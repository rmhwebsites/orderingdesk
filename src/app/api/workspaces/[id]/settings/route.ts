import { NextResponse } from "next/server";
import { getWorkspaceSettings, updateWorkspaceSettings } from "@/server/desk/settings";
import { AuthError, guardResponse, requireMember, roleAtLeast } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// {workspace: {name, accentColor, slug}, settings: {notificationEmails,
// poPrefix, replyTo, fromName, timeZone, aiSearch}}
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "staff");
    const payload = await getWorkspaceSettings(db, id);
    if (!payload) {
      throw new AuthError(404, "Not found");
    }
    return NextResponse.json(payload);
  } catch (e) {
    return guardResponse(e);
  }
}

// Managers and platform admins. Partial update of any of
// notificationEmails, poPrefix, replyTo, fromName, timeZone (an IANA zone
// name), aiSearch (a boolean), and (platform admins only: identity and
// branding) name and accentColor. 200 with the GET
// shape; 400 {error}; 404 when a manager sends name or accentColor.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, role } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await updateWorkspaceSettings(db, id, body, {
      canEditIdentity: roleAtLeast(role, "platform"),
    });
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
      case "forbidden":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "ok":
        return NextResponse.json({ workspace: result.workspace, settings: result.settings });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
