import { NextResponse } from "next/server";
import { checkCustomDomain } from "@/server/domains";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, 401 signed out). Fetches
// https://<domain>/api/health and compares the host it reports. 200
// {domain, status: active | error, reason} where reason (null when active)
// says what to fix; 400 {error} when no domain is saved.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const result = await checkCustomDomain(db, id);
    switch (result.kind) {
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "no-domain":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "checked":
        return NextResponse.json(result.domain);
    }
  } catch (e) {
    return guardResponse(e);
  }
}
