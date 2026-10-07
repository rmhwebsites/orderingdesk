// The MCP server's housekeeping on the cron (src/server/sync/cron.ts):
// prepared actions and sign-in codes are kept two days, audit rows 400 days;
// revoked connections get their KV grant revoked (the D1 revoke already
// blocks every call). The OAuth helpers are built only when there is a KV
// grant to revoke. Relative imports only.

import { lt } from "drizzle-orm";
import type { Db } from "../db";
import { aiActions, aiSignInCodes, auditLog } from "../db/schema";
import { ACTION_TTL_MS, CODE_TTL_MS } from "./constants";
import { markKvRevoked, pendingKvRevokes, revokeInKv, type GrantHelpers } from "./grants";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTION_RETENTION_MS = 2 * DAY_MS;
export const CODE_RETENTION_MS = 2 * DAY_MS;
export const AUDIT_RETENTION_MS = 400 * DAY_MS;
export const KV_SWEEP_MAX = 50;

// The deletes, in the order they run. The cron runs every 10 minutes, so
// each one searches an index instead of scanning its table (audit_log keeps
// growing: one row per tool call, 400 days). Actions and codes are indexed
// on expires_at, which is created_at plus their 10-minute life and never
// changes, so "expires_at < now - retention + life" is exactly "created_at
// < now - retention". audit_log has its own created_at index (0015).
export function pruneDeletes(db: Db, now: number) {
  return [
    db.delete(aiActions).where(lt(aiActions.expiresAt, now - ACTION_RETENTION_MS + ACTION_TTL_MS)),
    db.delete(aiSignInCodes).where(lt(aiSignInCodes.expiresAt, now - CODE_RETENTION_MS + CODE_TTL_MS)),
    db.delete(auditLog).where(lt(auditLog.createdAt, now - AUDIT_RETENTION_MS)),
  ];
}

export async function pruneMcpTables(db: Db, now: number): Promise<void> {
  for (const statement of pruneDeletes(db, now)) {
    await statement;
  }
}

export async function sweepKvRevokes(db: Db, helpers: () => GrantHelpers, now: number): Promise<number> {
  const rows = await pendingKvRevokes(db, KV_SWEEP_MAX);
  if (rows.length === 0) {
    return 0;
  }
  const revoked = await revokeInKv(helpers(), rows);
  await markKvRevoked(db, rows.map((row) => row.id), now);
  console.log("[oauth] " + JSON.stringify({ kvSwept: rows.length, kvRevoked: revoked }));
  return rows.length;
}
