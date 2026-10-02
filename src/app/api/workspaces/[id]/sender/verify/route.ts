import { NextResponse } from "next/server";
import { guardResponse, requireMember } from "@/server/guard";
import { verifySender } from "@/server/sender";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, 401 signed out). Sends a
// branded test email from the workspace's own address to the signed-in
// admin; when Cloudflare accepts it, workspace mail comes from that address
// from now on. 200 {sender view, verified: true}; 400 {error} when the
// workspace has no address of its own; 422 {error} when Cloudflare refuses
// the sending domain (the error says what to onboard); 502 {error} for any
// other sending failure.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env, email } = await requireMember(id, "platform");
    const result = await verifySender(db, env, id, email);
    switch (result.kind) {
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "no-sender":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "refused":
        return NextResponse.json({ error: result.error }, { status: 422 });
      case "failed":
        return NextResponse.json({ error: result.error }, { status: 502 });
      case "verified":
        return NextResponse.json(result.sender);
    }
  } catch (e) {
    return guardResponse(e);
  }
}
