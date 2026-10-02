import { NextResponse } from "next/server";
import { BRAND_UPLOAD_MAX_BYTES, isBrandSlot, storePngCopy } from "@/server/branding/assets";
import { readBodyCapped } from "@/server/branding/read-body";
import { brandingResponse } from "@/server/branding/respond";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string; slot: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, 401 signed out). The PNG copy
// of the slot's SVG or WebP upload, rendered by the browser at 2x (512px
// wide for logos, 256px for symbols), for email. Query ?for=<file name of
// the upload it was made from>; body: the PNG. 200 {branding}; 400 {error};
// 409 {error} when the upload was replaced meanwhile; 413 over 512 KB.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id, slot } = await context.params;
    const { db, env } = await requireMember(id, "platform");
    if (!isBrandSlot(slot)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const forFile = new URL(request.url).searchParams.get("for") ?? "";
    const bytes = await readBodyCapped(request, BRAND_UPLOAD_MAX_BYTES);
    if (bytes === "too-large") {
      return NextResponse.json({ error: "The email copy must be 512 KB or smaller." }, { status: 413 });
    }
    return brandingResponse(await storePngCopy(db, env.PO_BUCKET, { workspaceId: id, slot, bytes, forFile }));
  } catch (e) {
    return guardResponse(e);
  }
}
