import { NextResponse } from "next/server";
import { guardResponse, requireMember } from "@/server/guard";
import { approveRosterEntry } from "@/server/roster";

type RouteContext = { params: Promise<{ id: string; rosterId: string }> };

// Managers and platform admins of the workspace (404 for anyone else, 401
// signed out). Approves a Shopify tag request of THIS workspace (an entry of
// another workspace is a 404, like a missing one), a denied one included:
// the tag then grants its role, and an existing user gets the membership at
// once. Optional body {role}: the role the manager saw; when the tag now
// asks for another one the answer is 409 and nothing is approved. 200 {ok,
// role}; 400 {error}; 404; 409 {error}.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id, rosterId } = await context.params;
    const { db, userId } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await approveRosterEntry(db, { workspaceId: id, rosterId, approverId: userId }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "changed":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "approved":
        return NextResponse.json({ ok: true, role: result.role });
      default:
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
