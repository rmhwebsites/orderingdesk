import { NextResponse } from "next/server";
import { parseDeskQuery } from "@/lib/desk-query";
import { loadDesk } from "@/server/desk/read";
import { AuthError, guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// The desk payload in one round trip: workspace, the caller's role, statuses
// by sort, settings, per-status counts over every order, the view's newest
// order summaries (full snapshots come from GET /api/orders/[orderId]),
// every view's count, the request counts, whether draft orders sync for the
// store, and the work queue settings. ?view=open|approval|all|closed; the
// server owns the default, Open (src/lib/desk-query.ts).
export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, role } = await requireMember(id, "staff");
    const query = parseDeskQuery(new URL(request.url).searchParams);
    const desk = await loadDesk(db, id, { view: query.view });
    if (!desk) {
      throw new AuthError(404, "Not found");
    }
    return NextResponse.json({
      workspace: desk.workspace,
      role,
      statuses: desk.statuses,
      settings: desk.settings,
      statusCounts: desk.statusCounts,
      orders: desk.orders,
      hasMore: desk.hasMore,
      draftCount: desk.draftCount,
      deletedDraftCount: desk.deletedDraftCount,
      drafts: desk.drafts,
      view: desk.view,
      viewCounts: desk.viewCounts,
      queue: desk.queue,
    });
  } catch (e) {
    return guardResponse(e);
  }
}
