// Fans a realtime event out to a workspace's open desks through its
// WorkspaceRoom (src/realtime/room.ts). Best effort by design: the write the
// event describes has already committed, and clients refetch after every
// reconnect and poll while disconnected, so a lost broadcast only delays an
// update. broadcast therefore never throws into its caller: failures, a
// refusal or a room that does not answer within BROADCAST_TIMEOUT_MS are
// logged and the caller continues. Relative imports only: the cron path
// (src/server/sync/cron.ts) bundles this into the custom worker.

import type { LiveEvent } from "../lib/live-events";

const BROADCAST_TIMEOUT_MS = 3000;
const ROOM_BROADCAST_URL = "https://workspace-room/broadcast";
const ROOM_KICK_URL = "https://workspace-room/kick";

function timeout(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function broadcast(env: CloudflareEnv, workspaceId: string, event: LiveEvent): Promise<void> {
  // Tools and tests that build a partial env have no ROOM; production always
  // does (wrangler.jsonc durable_objects).
  if (!env.ROOM) {
    return;
  }
  const limit = timeout(BROADCAST_TIMEOUT_MS);
  try {
    const room = env.ROOM.get(env.ROOM.idFromName(workspaceId));
    const response = await Promise.race([
      room.fetch(ROOM_BROADCAST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }),
      limit.promise,
    ]);
    if (!response.ok) {
      console.warn("[live] " + JSON.stringify({ workspaceId, kind: event.kind, status: response.status }));
    }
  } catch (e) {
    console.warn(
      "[live] " +
        JSON.stringify({
          workspaceId,
          kind: event.kind,
          error: e instanceof Error ? e.message : "broadcast failed",
        }),
    );
  } finally {
    limit.cancel();
  }
}

// After a sync run (manual or cron): one orders.synced event when the run
// landed anything. The id lists are rows-affected truth from runSync.
export async function broadcastSync(
  env: CloudflareEnv,
  workspaceId: string,
  result: { addedOrderIds: string[]; updatedOrderIds: string[] },
): Promise<void> {
  if (result.addedOrderIds.length + result.updatedOrderIds.length === 0) {
    return;
  }
  await broadcast(env, workspaceId, {
    kind: "orders.synced",
    addedOrderIds: result.addedOrderIds,
    updatedOrderIds: result.updatedOrderIds,
  });
}

// After an order history import tick (src/server/sync/backfill.ts) landed
// orders: one orders.imported event, so open desks refresh. Old orders are
// not arrivals, so no ids travel (nothing to announce or flash).
export async function broadcastImported(
  env: CloudflareEnv,
  workspaceId: string,
  importedOrderIds: readonly string[],
): Promise<void> {
  if (importedOrderIds.length === 0) {
    return;
  }
  await broadcast(env, workspaceId, { kind: "orders.imported", count: importedOrderIds.length });
}

// Closes the open sockets of people who just lost access to the workspace
// (removed, their Shopify tag revoked, or platform admin access revoked):
// the room closes every socket tagged with each user id. Best effort like
// broadcast: the access change has committed, and the client's next
// request is refused anyway; this only stops events reaching a socket that
// was opened before the change. Never throws.
export async function kickUsers(env: CloudflareEnv, workspaceId: string, userIds: readonly string[]): Promise<void> {
  if (!env.ROOM || userIds.length === 0) {
    return;
  }
  for (const userId of userIds) {
    const limit = timeout(BROADCAST_TIMEOUT_MS);
    try {
      const room = env.ROOM.get(env.ROOM.idFromName(workspaceId));
      const response = await Promise.race([
        room.fetch(ROOM_KICK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        }),
        limit.promise,
      ]);
      if (!response.ok) {
        console.warn("[live] " + JSON.stringify({ workspaceId, kick: true, status: response.status }));
      }
    } catch (e) {
      console.warn(
        "[live] " + JSON.stringify({ workspaceId, kick: true, error: e instanceof Error ? e.message : "kick failed" }),
      );
    } finally {
      limit.cancel();
    }
  }
}
