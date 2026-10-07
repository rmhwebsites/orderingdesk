// One audit row per MCP tool call (Wave 2 plan, Decision 14): who, through
// which connection and app, which tool, on what, and how it ended. Never
// arguments, payloads or text. Never throws: a failed audit write is logged
// with ids only and the call's answer stands. The actor is a Principal, or
// for an every-workspace connection's call that named no usable workspace,
// the connection with workspaceId null. Relative imports only.

import type { Db } from "../db";
import { auditLog } from "../db/schema";
import { newId } from "./ids";
import type { Principal } from "./types";

export type AuditTarget = { kind: "order" | "person" | "location" | "product"; id: string };

export type AuditActor = Pick<Principal, "userId" | "grantId" | "client"> & { workspaceId: string | null };

export async function writeAudit(
  db: Db,
  p: AuditActor,
  entry: { tool: string; outcome: string; target?: AuditTarget | null },
  now: number,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: newId(),
      workspaceId: p.workspaceId,
      actorId: p.userId,
      grantId: p.grantId,
      client: p.client,
      tool: entry.tool,
      targetKind: entry.target?.kind ?? null,
      targetId: entry.target?.id ?? null,
      outcome: entry.outcome,
      createdAt: now,
    });
  } catch (e) {
    console.warn("[mcp] " + JSON.stringify({ workspaceId: p.workspaceId, tool: entry.tool, audit: e instanceof Error ? e.name : "failed" }));
  }
}
