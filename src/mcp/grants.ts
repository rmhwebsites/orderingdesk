// The AI connection mirror (Wave 2 plan, Decision 7). The OAuth library
// keeps each grant in OAUTH_KV; ai_grants mirrors it in D1, written after the
// library stored the grant, and every MCP call checks it (src/mcp/
// principal.ts), so a revoke here takes effect on the next call. Revoking
// also removes the KV grant, best effort (KV deletes take up to a minute to
// spread; the D1 check does not wait for them). Relative imports only.

import { and, eq, gt, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Db } from "../db";
import { applyBatch } from "../db/batch";
import { aiGrants } from "../db/schema";
import type { AiClient } from "../lib/via";
import { GRANT_TTL_MS, TOUCH_EVERY_MS } from "./constants";

export type GrantRow = typeof aiGrants.$inferSelect;

export type GrantInput = {
  // null: a platform admin's hub connection for every workspace (owner
  // decision 3, Oct 7).
  workspaceId: string | null;
  userId: string;
  host: string;
  clientId: string;
  client: AiClient;
  clientDomain: string | null;
  redirectHost: string;
  scopes: string[];
};

export type RevokeReason = "person" | "manager" | "platform_admin" | "member_removed" | "replaced";

// Stands for "every workspace" in the provider user id; no workspace id is
// "*".
export const EVERY_WORKSPACE = "*";

function sameWorkspace(workspaceId: string | null): SQL {
  return workspaceId === null ? isNull(aiGrants.workspaceId) : eq(aiGrants.workspaceId, workspaceId);
}

// The user id the OAuth library files a grant under: one per workspace and
// person (or "*" and person for a platform admin's every-workspace hub
// connection), so a hub connection per workspace can coexist. Never
// contains ":".
export function providerUserId(workspaceId: string | null, userId: string): string {
  return encodeURIComponent(`${workspaceId ?? EVERY_WORKSPACE}.${userId}`);
}

// The library revokes the same app's older grant for this person and
// resource when a new one is stored; the mirror follows in one batch.
export async function recordGrant(db: Db, id: string, input: GrantInput, now: number): Promise<void> {
  await applyBatch(db, [
    db
      .update(aiGrants)
      .set({ revokedAt: now, revokedBy: null, revokeReason: "replaced" })
      .where(
        and(
          sameWorkspace(input.workspaceId),
          eq(aiGrants.userId, input.userId),
          eq(aiGrants.host, input.host),
          eq(aiGrants.clientId, input.clientId),
          eq(aiGrants.redirectHost, input.redirectHost),
          isNull(aiGrants.revokedAt),
        ),
      ),
    db.insert(aiGrants).values({ id, ...input, createdAt: now, expiresAt: now + GRANT_TTL_MS }),
  ]);
}

export async function loadActiveGrant(db: Db, id: string, now: number): Promise<GrantRow | null> {
  const rows = await db
    .select()
    .from(aiGrants)
    .where(and(eq(aiGrants.id, id), isNull(aiGrants.revokedAt), gt(aiGrants.expiresAt, now)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchGrant(db: Db, id: string, now: number): Promise<void> {
  await db
    .update(aiGrants)
    .set({ lastUsedAt: now })
    .where(and(eq(aiGrants.id, id), or(isNull(aiGrants.lastUsedAt), lt(aiGrants.lastUsedAt, now - TOUCH_EVERY_MS))));
}

// where.workspaceId null reaches only every-workspace connections;
// everyWorkspaceToo adds them to a workspace's own (Revoke all, since each
// of them can act in that workspace).
export async function revokeGrants(
  db: Db,
  where: { workspaceId: string | null; grantId?: string; userId?: string; everyWorkspaceToo?: boolean },
  by: { userId: string | null; reason: RevokeReason },
  now: number,
): Promise<GrantRow[]> {
  const scope =
    where.workspaceId !== null && where.everyWorkspaceToo
      ? (or(eq(aiGrants.workspaceId, where.workspaceId), isNull(aiGrants.workspaceId)) as SQL)
      : sameWorkspace(where.workspaceId);
  const conditions: SQL[] = [scope, isNull(aiGrants.revokedAt)];
  if (where.grantId) {
    conditions.push(eq(aiGrants.id, where.grantId));
  }
  if (where.userId) {
    conditions.push(eq(aiGrants.userId, where.userId));
  }
  return db
    .update(aiGrants)
    .set({ revokedAt: now, revokedBy: by.userId, revokeReason: by.reason })
    .where(and(...conditions))
    .returning();
}

export type GrantHelpers = Pick<OAuthHelpers, "listUserGrants" | "revokeGrant">;

// Revokes the KV grants behind these mirror rows (matched by the app id the
// authorize page put in each grant's metadata). Returns how many it
// revoked; never throws.
export async function revokeInKv(helpers: GrantHelpers, rows: Pick<GrantRow, "id" | "workspaceId" | "userId">[]): Promise<number> {
  const byOwner = new Map<string, Set<string>>();
  for (const row of rows) {
    const owner = providerUserId(row.workspaceId, row.userId);
    const ids = byOwner.get(owner) ?? new Set<string>();
    ids.add(row.id);
    byOwner.set(owner, ids);
  }
  let revoked = 0;
  for (const [owner, ids] of byOwner) {
    try {
      let cursor: string | undefined;
      do {
        const page = await helpers.listUserGrants(owner, cursor ? { limit: 1000, cursor } : { limit: 1000 });
        for (const grant of page.items) {
          const appId = (grant.metadata as { aiGrantId?: unknown } | null | undefined)?.aiGrantId;
          if (typeof appId === "string" && ids.has(appId)) {
            await helpers.revokeGrant(grant.id, owner);
            revoked += 1;
          }
        }
        cursor = page.cursor;
      } while (cursor);
    } catch (e) {
      console.warn("[oauth] " + JSON.stringify({ kvRevoke: e instanceof Error ? e.name : "failed" }));
    }
  }
  return revoked;
}

// Revoked connections whose KV grant the cron has not revoked yet.
export async function pendingKvRevokes(db: Db, limit: number): Promise<Pick<GrantRow, "id" | "workspaceId" | "userId">[]> {
  return db
    .select({ id: aiGrants.id, workspaceId: aiGrants.workspaceId, userId: aiGrants.userId })
    .from(aiGrants)
    .where(and(isNotNull(aiGrants.revokedAt), isNull(aiGrants.kvRevokedAt)))
    .limit(limit);
}

export async function markKvRevoked(db: Db, ids: string[], now: number): Promise<void> {
  if (ids.length > 0) {
    await db.update(aiGrants).set({ kvRevokedAt: now }).where(inArray(aiGrants.id, ids));
  }
}
