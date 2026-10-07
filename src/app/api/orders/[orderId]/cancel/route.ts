import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CANCEL_COPY, cancelOrder, followCancellation } from "@/server/desk/cancel-order";
import { guardResponse, requireMemberByOrder, roleAtLeast } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// Cancel an order after approval (comprehensive design section 2;
// src/server/desk/cancel-order.ts). Body {reason}: trimmed, 1 to 4000
// characters. Managers and platform admins: 404 for outsiders (as every
// order route), 403 for staff. 200 {kind: "cancelled", order, events,
// confirmed}, 200 {kind: "already-cancelled"}, 200 {kind:
// "cancelled-in-shopify", message}; 400, 409 or 502 {error} otherwise
// (nothing changed unless the error says so). Shopify never emails the
// customer, restocks or refunds. The order snapshot, the status tag and the
// pushes follow after the response.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: CANCEL_COPY.forbidden }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as unknown;
    const { env, ctx } = getCloudflareContext();
    const result = await cancelOrder(db, { workspaceId, orderId, userId, role }, body, { env });
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused":
        return NextResponse.json({ error: result.error }, { status: result.status });
      case "already-cancelled":
        return NextResponse.json({ kind: result.kind });
      case "cancelled-in-shopify":
        ctx.waitUntil(followCancellation(db, env, workspaceId, orderId, result, {}));
        return NextResponse.json({ kind: result.kind, message: result.message });
      case "cancelled":
        ctx.waitUntil(followCancellation(db, env, workspaceId, orderId, result, {}));
        return NextResponse.json({ kind: result.kind, order: result.order, events: result.events, confirmed: result.confirmed });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
