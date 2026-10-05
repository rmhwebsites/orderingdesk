import { NextResponse } from "next/server";
import { guardResponse, requireMemberByPo } from "@/server/guard";
import { updatePurchaseOrder } from "@/server/po/service";

type RouteContext = { params: Promise<{ poId: string }> };

// Saves a draft, or a PO whose last send failed (managers and platform
// admins; 404 for staff). Body as for creating one. 200 {po}; 400 {error};
// 409 {error, po} once it was sent or while a send holds it.
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { poId } = await context.params;
    const { db, workspaceId } = await requireMemberByPo(poId, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await updatePurchaseOrder(db, { workspaceId, poId, now: Date.now() }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "conflict":
        return NextResponse.json({ error: result.error, po: result.po }, { status: 409 });
      case "updated":
        return NextResponse.json({ po: result.po });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
