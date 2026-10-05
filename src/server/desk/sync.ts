// Manual sync and the connection card, behind GET/POST
// /api/workspaces/[id]/sync. The route authorizes and maps the outcome to
// HTTP with manualSyncResponse; everything else lives here so it is tested
// without a request.

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { storeConnections } from "@/db/schema";
import { runSync, type SyncResult } from "@/server/sync/run";

// A manual sync may run at most once per 30 seconds per workspace.
export const MANUAL_SYNC_COOLDOWN_MS = 30000;

export type SyncConnectionView = {
  shopDomain: string;
  // The domain whose handle Shopify admin links use: the store's canonical
  // myshopify domain once a save or Refresh connection recorded it (a store
  // saved under an alias has its admin at the canonical handle), else the
  // saved domain.
  adminShopDomain: string;
  status: "ok" | "error" | "disabled";
  lastSyncAt: number;
  lastError: string | null;
  // True while a cursor chain is still draining (a first sync, or a backlog
  // bigger than one run). lastSyncAt deliberately stays at its old value
  // (0 on a first sync) until the chain finishes, so the card shows
  // "catching up" instead of a stale or missing sync time.
  catchingUp: boolean;
};

// The connection card: never the token or its ciphertext.
export async function getSyncConnection(
  db: Db,
  workspaceId: string,
): Promise<SyncConnectionView | null> {
  const rows = await db
    .select({
      shopDomain: storeConnections.shopDomain,
      canonicalShopDomain: storeConnections.canonicalShopDomain,
      status: storeConnections.status,
      lastSyncAt: storeConnections.lastSyncAt,
      lastError: storeConnections.lastError,
      syncCursor: storeConnections.syncCursor,
    })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    shopDomain: row.shopDomain,
    adminShopDomain: row.canonicalShopDomain ?? row.shopDomain,
    status: row.status,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
    catchingUp: row.syncCursor !== null,
  };
}

export type ManualSyncOutcome =
  | { kind: "cooldown"; retryAfterSeconds: number }
  // The engine reported an error; result still lists what landed.
  | { kind: "failed"; result: SyncResult }
  // Finished, including skipped runs (lease held, no connection, disabled).
  | { kind: "done"; result: SyncResult };

type RunEngine = (db: Db, env: CloudflareEnv, workspaceId: string) => Promise<SyncResult>;

export async function manualSync(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  opts?: { now?: number; run?: RunEngine },
): Promise<ManualSyncOutcome> {
  const now = opts?.now ?? Date.now();
  const run = opts?.run ?? ((d: Db, e: CloudflareEnv, id: string) => runSync(d, e, id));

  const rows = await db
    .select({ lastManualSyncAt: storeConnections.lastManualSyncAt })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const connection = rows[0];
  if (connection && connection.lastManualSyncAt > now - MANUAL_SYNC_COOLDOWN_MS) {
    return {
      kind: "cooldown",
      retryAfterSeconds: Math.ceil(
        (connection.lastManualSyncAt + MANUAL_SYNC_COOLDOWN_MS - now) / 1000,
      ),
    };
  }

  const result = await run(db, env, workspaceId);
  // The cooldown only counts runs that did real work: skipped runs (lease
  // held, no connection, disabled), fruitless failures and fruitless
  // superseded runs (another run, a connection save or a disconnect took
  // the lease mid-run) can be retried immediately.
  const fruitless =
    (Boolean(result.error) || result.superseded === true) && result.added + result.updated === 0;
  if (connection && !result.skipped && !fruitless) {
    await db
      .update(storeConnections)
      .set({ lastManualSyncAt: now })
      .where(eq(storeConnections.workspaceId, workspaceId));
  }
  return result.error ? { kind: "failed", result } : { kind: "done", result };
}

export type HttpReply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export function manualSyncResponse(outcome: ManualSyncOutcome): HttpReply {
  switch (outcome.kind) {
    case "cooldown":
      return {
        status: 429,
        headers: { "Retry-After": String(outcome.retryAfterSeconds) },
        body: { error: "Sync already ran in the last 30 seconds" },
      };
    case "failed":
      // 502 with the partial counts so the desk can show both the failure
      // and what still landed.
      return {
        status: 502,
        body: {
          error: outcome.result.error,
          added: outcome.result.added,
          updated: outcome.result.updated,
        },
      };
    case "done":
      // 200 even for skipped results; the desk renders the skip reason.
      return { status: 200, body: outcome.result };
  }
}
