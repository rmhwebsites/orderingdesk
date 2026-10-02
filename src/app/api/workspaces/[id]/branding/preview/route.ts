import { NextResponse } from "next/server";
import { loadMailWorkspace } from "@/server/email/workspace";
import { EMAIL_PREVIEW_HEADERS, renderEmailPreview } from "@/server/branding/preview";
import { guardResponse, requireMember } from "@/server/guard";
import { appOrigin } from "@/server/host";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, 401 signed out). A sample
// workspace email (the shared renderEmail layout) with the draft theme from
// the query: primary, ink, background (#rrggbb), heading, body (font ids),
// radius. Answered as an inert document (no script, no network except
// https and data images, sandboxed) that Settings shows in a sandboxed
// iframe by URL.
export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env } = await requireMember(id, "platform");
    const workspace = await loadMailWorkspace(db, id);
    if (!workspace) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const html = renderEmailPreview(workspace, new URL(request.url).searchParams, appOrigin(env));
    return new Response(html, { status: 200, headers: EMAIL_PREVIEW_HEADERS });
  } catch (e) {
    return guardResponse(e);
  }
}
