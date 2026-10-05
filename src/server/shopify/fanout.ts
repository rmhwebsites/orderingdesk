// What follows a status change, after it has committed (platform amendment
// section 4): open desks hear about it, the status is written to Shopify,
// and the outcome reaches any open drawer. Best effort and never throws
// (broadcast and pushOrderStatus both swallow their failures), so callers
// can run it after the response through ctx.waitUntil. Relative imports on
// purpose: the cron path bundles this into the custom worker entrypoint.

import type { Db } from "../../db";
import { broadcast } from "../broadcast";
import { notifyActivity } from "../notify";
import { pushOrderStatus, type StatusChange } from "./status-sync";

type FanoutOptions = { fetchImpl?: typeof fetch; now?: () => number };

// A change made in the app: write the status to Shopify (fulfilling a
// status linked to fulfilled) and share each outcome entry.
export async function pushAndShare(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  opts?: FanoutOptions,
): Promise<void> {
  const activity = await pushOrderStatus(db, env, workspaceId, orderId, { fulfill: true, ...opts });
  for (const event of activity) {
    await broadcast(env, workspaceId, { kind: "order.activity", event });
  }
}

// Moves that came from Shopify (the sync or a webhook): broadcast each,
// push it to members who opted into all activity (notifyActivity never
// throws), then bring the order's status tag up to date. Never fulfills:
// Shopify reported the state these moves follow.
export async function shareShopifyMoves(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  changes: readonly StatusChange[],
  opts?: FanoutOptions,
): Promise<void> {
  for (const change of changes) {
    await broadcast(env, workspaceId, { kind: "order.status", event: change.event, order: change.order });
    await notifyActivity(db, env, workspaceId, change.event, opts);
    const activity = await pushOrderStatus(db, env, workspaceId, change.order.id, { fulfill: false, ...opts });
    for (const event of activity) {
      await broadcast(env, workspaceId, { kind: "order.activity", event });
    }
  }
}
