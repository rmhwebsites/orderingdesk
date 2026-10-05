import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { broadcast, broadcastSync } from "@/server/broadcast";
import { approveRequest, followApproval, REVIEW_COPY } from "@/server/desk/review";
import { guardResponse, requireMemberByOrder, roleAtLeast } from "@/server/guard";
import { notifyActivity } from "@/server/notify";

type RouteContext = { params: Promise<{ orderId: string }> };

// Approve a request: completes its $0 draft in Shopify and the card becomes
// that order (draft orders spec section 9.1; src/server/desk/review.ts). No
// body. Managers and platform admins: 404 for outsiders (as every order
// route), 403 for staff. 200 {kind: "approved", order, orderName,
// shopifyOrderId, events, triggersPo}, 200 {kind: "already-approved",
// order, orderName} for a card that already is an order, 200 {kind:
// "completed-in-shopify", order, orderName, message} when Shopify had it
// completed already; 409 or 502 {error} otherwise (nothing changed unless
// the error says so). The order snapshot, the status tag and the pushes
// follow after the response.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: REVIEW_COPY.forbidden }, { status: 403 });
    }
    const { env, ctx } = getCloudflareContext();
    const result = await approveRequest(db, { workspaceId, orderId, userId, role }, { env });
    switch (result.kind) {
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused": {
        const deleted = result.deleted;
        if (deleted) {
          // The draft is gone in Shopify: open desks show the card as deleted.
          ctx.waitUntil(
            (async () => {
              await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [deleted.orderId] });
              await broadcast(env, workspaceId, { kind: "order.activity", event: deleted.event });
              await notifyActivity(db, env, workspaceId, deleted.event);
            })(),
          );
        }
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
      case "already-approved":
        return NextResponse.json({ kind: result.kind, order: result.order, orderName: result.orderName });
      case "completed-in-shopify":
        ctx.waitUntil(followApproval(db, env, workspaceId, orderId, result.follow, {}));
        return NextResponse.json({
          kind: result.kind,
          order: result.order,
          orderName: result.orderName,
          message: result.message,
        });
      case "approved":
        ctx.waitUntil(followApproval(db, env, workspaceId, orderId, result.follow, {}));
        return NextResponse.json({
          kind: result.kind,
          order: result.order,
          orderName: result.orderName,
          shopifyOrderId: result.shopifyOrderId,
          events: result.events,
          triggersPo: result.triggersPo,
        });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
