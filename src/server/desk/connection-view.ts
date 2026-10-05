// What Settings > Store connection shows about a workspace's store: never a
// credential, a token, a client ID or a ciphertext (only those columns are
// selected that are safe to show).

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { storeConnections } from "@/db/schema";
import { backfillViewOf, type BackfillView } from "@/server/sync/backfill";
import { missingScopes } from "./connection";

export type ConnectionSettingsView = {
  shopDomain: string;
  // Shopify's store name, as verified at connect time (null before that
  // was recorded).
  shopName: string | null;
  authMode: "client_credentials" | "legacy_token";
  status: "ok" | "error" | "disabled";
  // The scopes granted at connect time, or null when not recorded.
  scopes: string[] | null;
  // Required scopes the recorded grant lacks, by name (empty when the
  // grant is unknown).
  missingScopes: string[];
  webhooksRegisteredAt: number | null;
  lastSyncAt: number;
  lastError: string | null;
  // A first sync or a backlog is still draining.
  catchingUp: boolean;
  // The order history import (never its Shopify cursor).
  backfill: BackfillView;
};

export async function getConnectionSettings(db: Db, workspaceId: string): Promise<ConnectionSettingsView | null> {
  const rows = await db
    .select({
      shopDomain: storeConnections.shopDomain,
      shopName: storeConnections.shopName,
      authMode: storeConnections.authMode,
      status: storeConnections.status,
      scopes: storeConnections.scopes,
      webhooksRegisteredAt: storeConnections.webhooksRegisteredAt,
      lastSyncAt: storeConnections.lastSyncAt,
      lastError: storeConnections.lastError,
      syncCursor: storeConnections.syncCursor,
      backfillStatus: storeConnections.backfillStatus,
      backfillSince: storeConnections.backfillSince,
      backfillImported: storeConnections.backfillImported,
      backfillStartedAt: storeConnections.backfillStartedAt,
      backfillFinishedAt: storeConnections.backfillFinishedAt,
      backfillError: storeConnections.backfillError,
    })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const scopes = Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : null;
  return {
    shopDomain: row.shopDomain,
    shopName: row.shopName ?? null,
    authMode: row.authMode,
    status: row.status,
    scopes,
    missingScopes: scopes ? missingScopes(scopes) : [],
    webhooksRegisteredAt: row.webhooksRegisteredAt ?? null,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError ?? null,
    catchingUp: row.syncCursor !== null,
    backfill: backfillViewOf(row),
  };
}
