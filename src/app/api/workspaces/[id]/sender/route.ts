import { NextResponse } from "next/server";
import { guardResponse, requireMember } from "@/server/guard";
import { setSenderOverride } from "@/server/sender";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, 401 signed out). Body
// {address: string | null}: sets the workspace's sending address override,
// or clears it with null (back to accounts@<custom domain>). A different
// value clears the verification; press Verify (POST .../sender/verify)
// after. 200 {override, address, source, verified, verifiedAt, from,
// replyTo}; 400 {error}.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env } = await requireMember(id, "platform");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await setSenderOverride(db, env, id, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "saved":
        return NextResponse.json(result.sender);
    }
  } catch (e) {
    return guardResponse(e);
  }
}
