import { NextResponse } from "next/server";
import { countNeedsApproval } from "@/server/desk/read";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Managers and platform admins: how many requests wait for approval (the
// top bar's Needs approval badge). 401 signed out, 404 for staff and
// outsiders. 200 {needsApproval}.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "manager");
    return NextResponse.json({ needsApproval: await countNeedsApproval(db, id) });
  } catch (e) {
    return guardResponse(e);
  }
}
