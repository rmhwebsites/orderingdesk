// Prepared actions (comprehensive desk design section 4; Wave 2 plan,
// Decision 11): every write is a prepare tool that stores one of these and
// a confirm tool that carries it out once.
// - Bound to the workspace, the connection (grant), the person, the tool and
//   the target; another connection's id finds nothing.
// - content_hash covers the payload and the target's state at preview time
//   (cardState); confirm recomputes it, so a card that changed meanwhile is
//   refused ("prepare again").
// - Claimed with a conditional UPDATE (pending -> executing), so two
//   confirms cannot both run; expired after ACTION_TTL_MS.
// - A wrong echo is refused before the claim: the confirmation stays usable.
// - A change is counted (mcp_change) when the claim succeeds.
// - place_request only: a create that timed out is "unknown"; the same
//   confirmation may claim it again for a lookup (recheck), never a resend.
// Relative imports only.

import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db";
import { aiActions, type AiActionTool } from "../db/schema";
import { ACTION_TTL_MS, UNKNOWN_RECHECK_MS } from "./constants";
import { canonicalJson, sha256Hex, timingSafeEqual } from "./hash";
import { newId } from "./ids";
import { iso } from "./output";
import { fail, ok, type ToolDeps, type ToolOutcome } from "./tools/define";
import type { Principal } from "./types";
import { claimChange } from "./usage";

export type ActionRow = typeof aiActions.$inferSelect;

// What a card looked like at preview time, for the content hash.
export function cardState(card: { statusKey: string; shopify: unknown; draftDeletedAt: number | null; shopifyOrderId: string | null }): string {
  return canonicalJson([card.statusKey, card.shopifyOrderId, card.draftDeletedAt, card.shopify]);
}

function hashOf(tool: string, targetId: string | null, payload: unknown, state: string): Promise<string> {
  return sha256Hex(["ordering-desk.ai-action.v1", tool, targetId ?? "", canonicalJson(payload), state].join("\n"));
}

export async function prepareAction(
  db: Db,
  p: Principal,
  input: { tool: AiActionTool; targetId: string | null; payload: Record<string, unknown>; state: string },
  now: number,
): Promise<{ id: string; expiresAt: number }> {
  const id = newId();
  const expiresAt = now + ACTION_TTL_MS;
  await db.insert(aiActions).values({
    id,
    workspaceId: p.workspaceId,
    grantId: p.grantId,
    userId: p.userId,
    tool: input.tool,
    targetId: input.targetId,
    payload: input.payload,
    contentHash: await hashOf(input.tool, input.targetId, input.payload, input.state),
    createdAt: now,
    expiresAt,
  });
  return { id, expiresAt };
}

export async function loadAction(db: Db, p: Principal, id: string): Promise<ActionRow | null> {
  const rows = await db
    .select()
    .from(aiActions)
    .where(and(eq(aiActions.id, id), eq(aiActions.workspaceId, p.workspaceId), eq(aiActions.grantId, p.grantId), eq(aiActions.userId, p.userId)))
    .limit(1);
  return rows[0] ?? null;
}

// One member per kind, so a caller that has ruled out expired and used
// reads the action without a cast.
export type Claim =
  | { kind: "claimed"; action: ActionRow }
  | { kind: "recheck"; action: ActionRow }
  | { kind: "expired" }
  | { kind: "used" };

export async function claimAction(db: Db, action: ActionRow, now: number): Promise<Claim> {
  if (action.status === "unknown") {
    if (action.tool !== "place_request" || (action.usedAt ?? 0) + UNKNOWN_RECHECK_MS <= now) {
      return { kind: "used" };
    }
    const rows = await db
      .update(aiActions)
      .set({ status: "executing" })
      .where(and(eq(aiActions.id, action.id), eq(aiActions.status, "unknown")))
      .returning();
    return rows[0] ? { kind: "recheck", action: rows[0] } : { kind: "used" };
  }
  if (action.status !== "pending") {
    return { kind: "used" };
  }
  if (action.expiresAt <= now) {
    await db
      .update(aiActions)
      .set({ status: "failed", outcome: "expired" })
      .where(and(eq(aiActions.id, action.id), eq(aiActions.status, "pending")));
    return { kind: "expired" };
  }
  const rows = await db
    .update(aiActions)
    .set({ status: "executing", usedAt: now })
    .where(and(eq(aiActions.id, action.id), eq(aiActions.status, "pending"), gt(aiActions.expiresAt, now)))
    .returning();
  return rows[0] ? { kind: "claimed", action: rows[0] } : { kind: "used" };
}

export async function finishAction(db: Db, id: string, status: "done" | "failed" | "unknown", outcome: string): Promise<void> {
  await db.update(aiActions).set({ status, outcome }).where(eq(aiActions.id, id));
}

export async function stateMatches(action: Pick<ActionRow, "tool" | "targetId" | "payload" | "contentHash">, state: string): Promise<boolean> {
  return timingSafeEqual(action.contentHash, await hashOf(action.tool, action.targetId, action.payload, state));
}

export type ConfirmStart<P> = { ok: true; action: ActionRow; payload: P; recheck: boolean } | { ok: false; outcome: ToolOutcome };

// The common start of every confirm tool. echo returns null when the
// repeated fields match the payload, else the sentence to answer.
export async function beginConfirm<P>(
  deps: ToolDeps,
  input: { id: string; tool: AiActionTool; echo: (payload: P) => string | null },
): Promise<ConfirmStart<P>> {
  const { db, principal: p } = deps;
  const now = deps.now();
  const action = await loadAction(db, p, input.id);
  if (!action) {
    return { ok: false, outcome: fail("not_found", "No such confirmation for this connection. Prepare the change again.") };
  }
  const target = action.targetId ? { kind: "order" as const, id: action.targetId } : undefined;
  if (action.tool !== input.tool) {
    return { ok: false, outcome: fail("mismatch", "This confirmation is for another kind of change.", target) };
  }
  const payload = action.payload as P;
  const mismatch = input.echo(payload);
  if (mismatch) {
    return { ok: false, outcome: fail("mismatch", `${mismatch} Repeat the fields exactly as the preview showed them.`, target) };
  }
  const claim = await claimAction(db, action, now);
  if (claim.kind === "expired") {
    return { ok: false, outcome: fail("expired", "This confirmation expired after 10 minutes. Prepare the change again.", target) };
  }
  if (claim.kind === "used") {
    return { ok: false, outcome: fail("already_used", "This confirmation was already used. Prepare the change again if it is still needed.", target) };
  }
  if (claim.kind === "claimed" && !(await claimChange(db, p, now))) {
    await finishAction(db, action.id, "failed", "limit_reached");
    return { ok: false, outcome: fail("limit_reached", `Today's limit of ${p.limits.changes} changes is used up. It resets at 00:00 UTC.`, target) };
  }
  return { ok: true, action: claim.action, payload, recheck: claim.kind === "recheck" };
}

export type Preview = {
  summary: string;
  details?: Record<string, unknown>;
  warnings?: string[];
  // What the person must confirm before the change is sent (owner decision
  // 4, Oct 7: personalization details, src/mcp/details.ts), returned as
  // confirm_details. Omitted when there is nothing to confirm.
  confirmDetails?: { instruction: string; details: unknown[] } | null;
  // Values to repeat: strings, and for personalized requests the details
  // list (details_confirmed is never pre-filled here).
  confirm: { tool: string; fields: Record<string, unknown> };
};

// What every prepare tool returns: the confirmation id, its expiry, the
// preview, warnings, what the person must confirm (if anything), and
// exactly which tool and fields confirm it.
export function preparedResult(prepared: { id: string; expiresAt: number }, preview: Preview, target?: { kind: "order"; id: string }): ToolOutcome {
  return ok(
    {
      confirmation_id: prepared.id,
      expires_at: iso(prepared.expiresAt),
      preview: { summary: preview.summary, ...(preview.details ?? {}) },
      warnings: preview.warnings ?? [],
      ...(preview.confirmDetails ? { confirm_details: preview.confirmDetails } : {}),
      confirm_with: { tool: preview.confirm.tool, confirmation_id: prepared.id, ...preview.confirm.fields },
    },
    target,
  );
}
