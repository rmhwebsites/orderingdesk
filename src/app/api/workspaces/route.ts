import { NextResponse } from "next/server";
import { guardResponse, requirePlatformAdmin, requireSession } from "@/server/guard";
import { createWorkspace, listWorkspacesForViewer } from "@/server/workspaces";

// {workspaces: [{id, name, slug, accentColor, symbol, role}]} (symbol:
// {light, dark | null} served paths, or null): every workspace for a
// platform admin (role "platform"), only the caller's memberships otherwise.
export async function GET() {
  try {
    const { db, viewer } = await requireSession();
    return NextResponse.json({ workspaces: await listWorkspacesForViewer(db, viewer) });
  } catch (e) {
    return guardResponse(e);
  }
}

// Platform admins only (404 for anyone else). Body {name}. 201 {workspace:
// {id, name, slug, role}}; 400 {error}; 409 {error} on a slug race.
export async function POST(request: Request) {
  try {
    const { db, userId } = await requirePlatformAdmin();
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await createWorkspace(db, userId, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "conflict":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "created":
        return NextResponse.json({ workspace: result.workspace }, { status: 201 });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
