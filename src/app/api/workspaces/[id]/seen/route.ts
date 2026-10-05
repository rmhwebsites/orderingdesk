import { NextResponse } from "next/server";
import { markAllRead } from "@/server/activity";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Mark all read: the member's last visit moves to now. 200 {lastSeenAt};
// 404 for anyone who is not a member (a platform admin looking in has no
// record to move).
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId } = await requireMember(id, "staff");
    const result = await markAllRead(db, id, userId);
    if (result.kind === "not-member") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ lastSeenAt: result.lastSeenAt });
  } catch (e) {
    return guardResponse(e);
  }
}
