import { NextResponse } from "next/server";
import { kickUsers } from "@/server/broadcast";
import { guardResponse, requireMember } from "@/server/guard";
import { denyRosterEntry } from "@/server/roster";

type RouteContext = { params: Promise<{ id: string; rosterId: string }> };

// Managers and platform admins of the workspace (404 for anyone else, 401
// signed out). Denies a Shopify tag request of THIS workspace (an entry of
// another workspace is a 404): the tag grants nothing until it is removed
// in Shopify and added again, and any shopify membership for the email here
// goes, closing that person's open sockets. A manual membership stays.
// 200 {ok}; 404.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id, rosterId } = await context.params;
    const { db, env } = await requireMember(id, "manager");
    const result = await denyRosterEntry(db, { workspaceId: id, rosterId });
    if (result.kind !== "denied") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (result.revokedUserId) {
      await kickUsers(env, id, [result.revokedUserId]);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
