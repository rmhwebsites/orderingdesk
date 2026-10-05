import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { roleAtLeast } from "@/lib/roles";
import { broadcast } from "@/server/broadcast";
import { AuthError, guardResponse, requireMemberByOrder } from "@/server/guard";
import { previewPoNumber } from "@/server/po/number";
import { createPurchaseOrder, listOrderPurchaseOrders, poPrefixOf } from "@/server/po/service";

type RouteContext = { params: Promise<{ orderId: string }> };

// The order's purchase orders, newest first, for everyone in the workspace
// (staff see them; only managers and platform admins create and send).
// 200 {pos, canManage, nextNumber}: nextNumber, for those who can manage,
// is the number the next send would take (nothing is reserved).
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, role, workspaceId } = await requireMemberByOrder(orderId, "staff");
    const now = Date.now();
    const pos = await listOrderPurchaseOrders(db, { workspaceId, orderId, now });
    if (!pos) {
      throw new AuthError(404, "Not found");
    }
    const canManage = roleAtLeast(role, "manager");
    const nextNumber = canManage ? await previewPoNumber(db, workspaceId, await poPrefixOf(db, workspaceId), now) : null;
    return NextResponse.json({ pos, canManage, nextNumber });
  } catch (e) {
    return guardResponse(e);
  }
}

// A new draft (managers and platform admins; 404 for staff). Body
// {vendorId, lines: [{description, sku, quantity, unitCost}], shipTo:
// [lines], notes}. 201 {po}; 400 {error}. Nothing is sent: sending is
// POST /api/pos/[poId]/send with an explicit confirmation.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId } = await requireMemberByOrder(orderId, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await createPurchaseOrder(db, { workspaceId, orderId, userId, now: Date.now() }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "created": {
        const { env, ctx } = getCloudflareContext();
        ctx.waitUntil(broadcast(env, workspaceId, { kind: "order.activity", event: result.event }));
        return NextResponse.json({ po: result.po }, { status: 201 });
      }
    }
  } catch (e) {
    return guardResponse(e);
  }
}
