import { NextResponse } from "next/server";
import { deskParams } from "@/lib/desk-query";
import { guardResponse, requireMember } from "@/server/guard";
import type { AiRunner } from "@/server/search/ai";
import { aiSearch } from "@/server/search/ai-search";

type RouteContext = { params: Promise<{ id: string }> };

const BODY_MAX = 2048;

// AI search (design section 3). Body {q}. Members (staff and up): 401
// signed out, 404 otherwise. 200 {params}: the understood filter as desk URL
// params (the desk applies them and shows them as chips); 200 {fallback}:
// why keyword search stands (shortcut, off, limit, timeout, busy, invalid,
// error); 400 for no question or a body over 2 KB. The workspace is the
// guard's; the model never sees order data.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env, userId } = await requireMember(id, "staff");
    const text = await request.text();
    if (text.length > BODY_MAX) {
      return NextResponse.json({ error: "Ask a shorter question" }, { status: 400 });
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    const outcome = await aiSearch(db, env.AI as unknown as AiRunner | undefined, { workspaceId: id, userId, now: Date.now() }, body);
    switch (outcome.kind) {
      case "invalid":
        return NextResponse.json({ error: outcome.error }, { status: 400 });
      case "fallback":
        return NextResponse.json({ fallback: outcome.reason });
      case "filter":
        return NextResponse.json({ params: deskParams(outcome.query).toString() });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
