import { NextResponse } from "next/server";
import { revokeConnection } from "@/server/ai-connections";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string; grantId: string }> };

// Revoke one AI connection: its owner, or a manager or platform admin of
// the workspace; a connection for every workspace only by a platform admin
// on the hub. 200 {revoked: true}; 404 for anyone else and for a
// connection already revoked. The next MCP call with it is refused; the cron
// revokes the KV grant.
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id, grantId } = await context.params;
    const { db, userId, role } = await requireMember(id, "staff");
    const result = await revokeConnection(db, { workspaceId: id, grantId, viewerUserId: userId, role }, Date.now());
    if (result.kind === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ revoked: true });
  } catch (e) {
    return guardResponse(e);
  }
}
