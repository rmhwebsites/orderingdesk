import { NextResponse } from "next/server";
import { BRAND_UPLOAD_MAX_BYTES, isBrandSlot, removeBrandImage, uploadBrandImage } from "@/server/branding/assets";
import { readBodyCapped } from "@/server/branding/read-body";
import { brandingResponse } from "@/server/branding/respond";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string; slot: string }> };

// PLATFORM ADMINS ONLY, both methods (404 for anyone else, 401 signed out).
// slot: symbol-light, symbol-dark, logo-light or logo-dark.

// Body: the image file itself (SVG, PNG, JPEG or WebP, at most 512 KB; the
// Content-Type header should name its type). 200 {branding}; 400 {error}
// for an unsafe SVG, a file that is not what it claims, or a dark version
// without its light one; 413 {error} over 512 KB; 409 {error} on a
// concurrent change. An SVG or WebP needs its PNG copy next (.../png).
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id, slot } = await context.params;
    const { db, env } = await requireMember(id, "platform");
    if (!isBrandSlot(slot)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const bytes = await readBodyCapped(request, BRAND_UPLOAD_MAX_BYTES);
    if (bytes === "too-large") {
      return NextResponse.json({ error: "Images must be 512 KB or smaller." }, { status: 413 });
    }
    const result = await uploadBrandImage(db, env.PO_BUCKET, {
      workspaceId: id,
      slot,
      bytes,
      declaredType: request.headers.get("content-type"),
    });
    return brandingResponse(result);
  } catch (e) {
    return guardResponse(e);
  }
}

// Removes the slot's image (the light version takes its dark one with it).
// 200 {branding}.
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id, slot } = await context.params;
    const { db, env } = await requireMember(id, "platform");
    if (!isBrandSlot(slot)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return brandingResponse(await removeBrandImage(db, env.PO_BUCKET, { workspaceId: id, slot }));
  } catch (e) {
    return guardResponse(e);
  }
}
