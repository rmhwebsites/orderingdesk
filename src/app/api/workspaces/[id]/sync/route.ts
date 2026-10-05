import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { broadcastMerges, broadcastSync } from "@/server/broadcast";
import { getSyncConnection, manualSync, manualSyncResponse } from "@/server/desk/sync";
import { guardResponse, requireMember } from "@/server/guard";
import { notifyNewOrders } from "@/server/notify";
import { shareShopifyMoves } from "@/server/shopify/fanout";

type RouteContext = { params: Promise<{ id: string }> };

// Connection card data: {connection: {shopDomain, adminShopDomain, status,
// lastSyncAt, lastError, catchingUp} | null}. Never the token.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "staff");
    return NextResponse.json({ connection: await getSyncConnection(db, id) });
  } catch (e) {
    return guardResponse(e);
  }
}

// Manual sync: 200 with the sync result (skipped runs included); 429
// {error} with Retry-After seconds inside the 30 second cooldown; 502
// {error, added, updated} when the run failed, with what still landed.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "staff");
    const { env, ctx } = getCloudflareContext();
    const outcome = await manualSync(db, env, id);
    if (outcome.kind !== "cooldown") {
      // Failed runs too: their id lists still name exactly what landed.
      // The new orders are announced (push and email, once per order
      // whichever path landed it); status moves that came from Shopify are
      // broadcast and their status tags written back. All best effort,
      // after the response.
      const { result } = outcome;
      ctx.waitUntil(
        (async () => {
          await broadcastSync(env, id, result);
          await broadcastMerges(env, id, result.mergedOrders ?? []);
          await notifyNewOrders(db, env, id, result.addedOrderIds);
          await shareShopifyMoves(db, env, id, result.statusChanges ?? []);
        })(),
      );
    }
    const reply = manualSyncResponse(outcome);
    return NextResponse.json(reply.body, { status: reply.status, headers: reply.headers });
  } catch (e) {
    return guardResponse(e);
  }
}
