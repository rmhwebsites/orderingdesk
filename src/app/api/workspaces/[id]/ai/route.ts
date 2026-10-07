import { NextResponse } from "next/server";
import { aiSettingsFor, updateAiSettings } from "@/server/ai-connections";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Settings > AI connections. GET (staff and up): the MCP address, the
// switch, the limits and the AI connections the viewer may see. PATCH
// (managers and platform admins): {readsPerDay?, staffChangesPerDay?,
// managerChangesPerDay?} and, for a platform admin on the hub, {teamAccess}.
// 401 signed out, 404 for outsiders and under-ranked roles, 400 {error}.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env, userId, role } = await requireMember(id, "staff");
    return NextResponse.json({ ai: await aiSettingsFor(db, env, { workspaceId: id, userId, role }) });
  } catch (e) {
    return guardResponse(e);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env, userId, role } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await updateAiSettings(db, { workspaceId: id, role }, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ai: await aiSettingsFor(db, env, { workspaceId: id, userId, role }) });
  } catch (e) {
    return guardResponse(e);
  }
}
