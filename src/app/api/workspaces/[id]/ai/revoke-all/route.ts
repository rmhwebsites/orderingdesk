import { NextResponse } from "next/server";
import { revokeAllConnections } from "@/server/ai-connections";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Platform admins on the hub (404 for everyone else, a platform admin on a
// client host included): revoke every AI connection that can act in the
// workspace, platform admins' connections for every workspace included.
// 200 {revoked: n}.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId } = await requireMember(id, "platform");
    return NextResponse.json({ revoked: await revokeAllConnections(db, { workspaceId: id, viewerUserId: userId }, Date.now()) });
  } catch (e) {
    return guardResponse(e);
  }
}
