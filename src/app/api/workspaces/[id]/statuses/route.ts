import { NextResponse } from "next/server";
import { replaceStatuses } from "@/server/desk/statuses";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Managers and platform admins. Body: the full ordered list [{key?, label,
// color, triggersPo, shopifyLink?: fulfilled | delivered | null}] (an
// existing status without shopifyLink keeps its link; at most one status
// per Shopify state). 200 {statuses}; 400 {error}; 409 {error, inUse:
// [{key, label, count}]} when a removed status still has orders (nothing
// changes). The first status in the list is the default for newly synced
// orders.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await replaceStatuses(db, id, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "in-use":
        return NextResponse.json({ error: result.error, inUse: result.inUse }, { status: 409 });
      case "ok":
        return NextResponse.json({ statuses: result.statuses });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
