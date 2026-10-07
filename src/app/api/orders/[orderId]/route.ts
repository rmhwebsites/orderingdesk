import { NextResponse } from "next/server";
import { getOrderDetail } from "@/server/desk/read";
import { AuthError, guardResponse, requireMemberByOrder } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// One order in full, including the whole stored Shopify snapshot, plus
// itemsTruncated (true unless the sync confirmed the line items are whole),
// plus location (the card's synced company location, or null).
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, workspaceId } = await requireMemberByOrder(orderId, "staff");
    const detail = await getOrderDetail(db, workspaceId, orderId);
    if (!detail) {
      throw new AuthError(404, "Not found");
    }
    return NextResponse.json({ order: detail.order, itemsTruncated: detail.itemsTruncated, location: detail.location });
  } catch (e) {
    return guardResponse(e);
  }
}
