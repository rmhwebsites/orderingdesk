import { NextResponse } from "next/server";
import { guardResponse, requireMember } from "@/server/guard";
import { setRosterTags } from "@/server/roster";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, 401 signed out). Body
// {manager, staff}: the Shopify customer tags that grant each role in this
// workspace, or null to go back to "Ordering Desk Manager" and "Ordering
// Desk Staff". The roster sync applies a change at its next run. 200
// {tags}; 400 {error}.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      // Unreadable JSON is not "null" (which resets the tags).
      return NextResponse.json({ error: "Send the tags as JSON" }, { status: 400 });
    }
    const result = await setRosterTags(db, id, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "saved":
        return NextResponse.json({ tags: result.tags });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
