import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { broadcast } from "@/server/broadcast";
import { changeOrderStatus } from "@/server/desk/mutations";
import { guardResponse, requireMemberByOrder } from "@/server/guard";
import { notifyActivity } from "@/server/notify";
import { pushAndShare } from "@/server/shopify/fanout";

type RouteContext = { params: Promise<{ orderId: string }> };

// Body {statusKey}. 200 {unchanged: true} when the order already has that
// status (nothing is written); otherwise 200 {event, order, triggersPo}, where
// triggersPo tells the client to open the PO review flow (orders only). 400
// for a status the card cannot take (a request into a status linked to
// fulfilled, delivered, Draft approved or Draft rejected; an order into
// Rejected), 403 for staff moving a request out of Rejected. The new status is
// written to Shopify after the response (status tag, and a fulfillment for a
// status linked to fulfilled); its outcome lands in the order's timeline and
// a Shopify failure never undoes the change here.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await changeOrderStatus(db, { workspaceId, orderId, userId, role }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "unchanged":
        return NextResponse.json({ unchanged: true });
      case "changed": {
        // After the response: open desks update the row and any open
        // drawer's timeline, members who opted into all activity get a
        // push, then the status goes to Shopify and its outcome follows
        // (best effort, never fails the request).
        const { env, ctx } = getCloudflareContext();
        ctx.waitUntil(
          (async () => {
            await broadcast(env, workspaceId, { kind: "order.status", event: result.event, order: result.order });
            await notifyActivity(db, env, workspaceId, result.event);
            await pushAndShare(db, env, workspaceId, orderId);
          })(),
        );
        return NextResponse.json({
          event: result.event,
          order: result.order,
          triggersPo: result.triggersPo,
        });
      }
    }
  } catch (e) {
    return guardResponse(e);
  }
}
