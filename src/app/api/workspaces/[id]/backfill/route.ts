import { NextResponse } from "next/server";
import { guardResponse, requireMember } from "@/server/guard";
import { cancelBackfill, getBackfillView, startBackfill } from "@/server/sync/backfill";

type RouteContext = { params: Promise<{ id: string }> };

// The order history import (src/server/sync/backfill.ts). PLATFORM ADMINS
// ONLY, on the hub, every method (404 for anyone else). The cron does the
// importing; these only start, show and cancel it.

// 200 {backfill}; 404 when the workspace has no store connection.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const backfill = await getBackfillView(db, id);
    if (!backfill) {
      return NextResponse.json({ error: "No store is connected" }, { status: 404 });
    }
    return NextResponse.json({ backfill });
  } catch (e) {
    return guardResponse(e);
  }
}

// Body {range: "all"} or {range: "since", since: <ms>}. 200 {backfill};
// 400 {error} for bad input; 409 {error} with no connected store, a
// connection that needs attention or an import already running; 422 {error}
// when the range reaches past 60 days and the app lacks read_all_orders.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await startBackfill(db, id, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "conflict":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "scope":
        return NextResponse.json({ error: result.error }, { status: 422 });
      case "started":
        return NextResponse.json({ backfill: result.backfill });
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Cancels the running import: 200 {backfill}; 409 {error} when none runs.
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const result = await cancelBackfill(db, id);
    if (result.kind === "conflict") {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    return NextResponse.json({ backfill: result.backfill });
  } catch (e) {
    return guardResponse(e);
  }
}
