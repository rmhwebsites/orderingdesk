import { lt, ne } from "drizzle-orm";
import { getDbFromEnv, type Db } from "../../db";
import { storeConnections, webhookDeliveries } from "../../db/schema";
import { broadcastImported, broadcastMerges, broadcastSync, kickUsers } from "../broadcast";
import { notifyNewOrders } from "../notify";
import { shareShopifyMoves } from "../shopify/fanout";
import { syncRoster } from "../shopify/roster-sync";
import { runBackfillTick } from "./backfill";
import { syncLocationsIfDue } from "./locations";
import { runSync, type SyncOptions } from "./run";

// Webhook ids are kept this long for dedupe. Shopify retries a failed
// delivery for up to 48 hours, so a week is ample.
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Sequential on purpose: one shop at a time keeps D1 contention and Shopify
// rate pressure low, and a cron tick has ample wall clock for a handful of
// workspaces. Exported separately from runScheduledSync so tests can inject
// a Db and a fetch implementation.
export async function runAllSyncs(db: Db, env: CloudflareEnv, opts?: SyncOptions): Promise<void> {
  const rows = await db
    .select({ workspaceId: storeConnections.workspaceId })
    .from(storeConnections)
    .where(ne(storeConnections.status, "disabled"));

  for (const { workspaceId } of rows) {
    // One workspace blowing up must not take down the rest of the tick.
    try {
      const result = await runSync(db, env, workspaceId, opts);
      // Open desks refresh from the landed ids, and drop the order cards
      // folded into draft cards (never throws).
      await broadcastSync(env, workspaceId, result);
      await broadcastMerges(env, workspaceId, result.mergedOrders ?? []);
      // Push and email for the orders this run inserted (never throws;
      // each order is announced once, whichever path landed it).
      await notifyNewOrders(db, env, workspaceId, result.addedOrderIds, opts);
      // Status moves that came from Shopify: broadcast, and write each
      // order's status tag back (never throws).
      await shareShopifyMoves(db, env, workspaceId, result.statusChanges ?? [], opts);
      console.log(
        "[sync] " +
          JSON.stringify({
            workspaceId,
            added: result.added,
            updated: result.updated,
            skipped: result.skipped,
            error: result.error,
          }),
      );
    } catch (e) {
      console.log(
        "[sync] " +
          JSON.stringify({
            workspaceId,
            error: e instanceof Error ? e.message : "unexpected failure",
          }),
      );
    }

    // The tagged-customer roster (platform amendment section 2): heals
    // missed customer webhooks, and is the only roster path for a legacy
    // token store. Logged as counts only (no emails).
    try {
      const roster = await syncRoster(db, env, workspaceId, opts);
      if (roster.kind === "ok") {
        const { revokedUserIds, ...counts } = roster;
        console.log("[roster] " + JSON.stringify({ workspaceId, ...counts }));
        // People whose tag went: close their open sockets (never throws).
        if (revokedUserIds.length > 0) {
          await kickUsers(env, workspaceId, revokedUserIds);
        }
      } else if (roster.kind === "failed") {
        console.log("[roster] " + JSON.stringify({ workspaceId, ...roster }));
      }
    } catch (e) {
      console.log("[roster] " + JSON.stringify({ workspaceId, error: e instanceof Error ? e.name : "failed" }));
    }

    // Company locations (comprehensive design section 2): once a day, or
    // while the workspace has none; skipped without a companies scope.
    // Logged as counts only.
    try {
      const synced = await syncLocationsIfDue(db, env, workspaceId, { fetchImpl: opts?.fetchImpl, now: opts?.now });
      if (synced.kind === "ok" || synced.kind === "failed") {
        console.log("[locations] " + JSON.stringify({ workspaceId, ...synced }));
      }
    } catch (e) {
      console.log("[locations] " + JSON.stringify({ workspaceId, error: e instanceof Error ? e.name : "failed" }));
    }

    // A running order history import advances a bounded stretch, last, so
    // it never delays the regular sync or the roster (and waits while the
    // regular sync is catching up). Its orders are old: open desks refresh,
    // nobody is notified, nothing goes back to Shopify.
    try {
      const imported = await runBackfillTick(db, env, workspaceId, opts);
      if (imported.skipped !== "idle") {
        await broadcastImported(env, workspaceId, imported.importedOrderIds);
        console.log(
          "[backfill] " +
            JSON.stringify({
              workspaceId,
              imported: imported.imported,
              skipped: imported.skipped,
              finished: imported.finished,
              error: imported.error,
            }),
        );
      }
    } catch (e) {
      console.log("[backfill] " + JSON.stringify({ workspaceId, error: e instanceof Error ? e.name : "failed" }));
    }
  }

  try {
    const now = opts?.now?.() ?? Date.now();
    await db.delete(webhookDeliveries).where(lt(webhookDeliveries.receivedAt, now - WEBHOOK_DELIVERY_RETENTION_MS));
  } catch (e) {
    console.log("[sync] " + JSON.stringify({ prune: e instanceof Error ? e.name : "failed" }));
  }
}

export async function runScheduledSync(env: CloudflareEnv): Promise<void> {
  // scheduled() has no request context, so build the db straight from env;
  // getCloudflareContext() does not exist on this path.
  await runAllSyncs(getDbFromEnv(env), env);
}
