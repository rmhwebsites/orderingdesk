import { NextResponse } from "next/server";
import { guardResponse, requireMemberByOrder } from "@/server/guard";
import { orderLinesForPo } from "@/server/po/order-lines";

type RouteContext = { params: Promise<{ orderId: string }> };

// The lines a new purchase order starts from (managers and platform admins;
// 404 for staff): the stored items when they are the whole order, else the
// full list read from Shopify. 200 {lines, source}; 502 {error} when the
// full list cannot be read (the modal then blocks Send to vendor); 409
// {error} for a request that is still a draft.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, env, workspaceId } = await requireMemberByOrder(orderId, "manager");
    const result = await orderLinesForPo(db, env, { workspaceId, orderId });
    switch (result.kind) {
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "unavailable":
        return NextResponse.json({ error: result.error }, { status: 502 });
      case "draft":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "ok":
        return NextResponse.json({ lines: result.lines, source: result.source });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
