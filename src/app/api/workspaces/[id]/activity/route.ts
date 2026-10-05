import { NextResponse } from "next/server";
import { loadActivityFeed } from "@/server/activity";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// The bell: {items, unread, lastSeenAt} (src/server/activity.ts). Any
// member; a platform admin who is not a member gets unread and lastSeenAt
// null.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId } = await requireMember(id, "staff");
    return NextResponse.json(await loadActivityFeed(db, id, userId), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return guardResponse(e);
  }
}
