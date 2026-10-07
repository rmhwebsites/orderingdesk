// What follows a status change or a note once it has committed, for the app's
// routes and the MCP confirms alike: open desks hear about it, members who
// follow all activity get a push, and a status goes to Shopify (status tag,
// and a fulfillment for a status linked to fulfilled). Best effort: never
// throws, so callers run it after the response (ctx.waitUntil).

import type { Db } from "@/db";
import type { LiveOrderStatus } from "@/lib/live-events";
import { broadcast } from "@/server/broadcast";
import { notifyActivity } from "@/server/notify";
import { pushAndShare } from "@/server/shopify/fanout";
import type { EventView } from "./shapes";

type FollowOptions = { fetchImpl?: typeof fetch; now?: () => number };

function logFailure(workspaceId: string, orderId: string | null, e: unknown): void {
  console.warn("[desk] " + JSON.stringify({ workspaceId, orderId, follow: e instanceof Error ? e.name : "failed" }));
}

export async function followStatusChange(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  change: { event: EventView; order: LiveOrderStatus },
  opts?: FollowOptions,
): Promise<void> {
  try {
    await broadcast(env, workspaceId, { kind: "order.status", event: change.event, order: change.order });
    await notifyActivity(db, env, workspaceId, change.event, opts);
    await pushAndShare(db, env, workspaceId, change.order.id, opts);
  } catch (e) {
    logFailure(workspaceId, change.order.id, e);
  }
}

export async function followNote(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  event: EventView,
  opts?: FollowOptions,
): Promise<void> {
  try {
    await broadcast(env, workspaceId, { kind: "order.note", event });
    await notifyActivity(db, env, workspaceId, event, opts);
  } catch (e) {
    logFailure(workspaceId, event.orderId, e);
  }
}
