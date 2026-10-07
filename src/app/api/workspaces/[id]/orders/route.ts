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
// server owns the default, Open (src/lib/desk-query.ts). The URL's search
// params (src/lib/desk-query.ts) filter the list on the server, one page at
// a time (limit 1 to 1000, default 200; cursor from nextCursor); the
// workspace is the guard's.
export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, role } = await requireMember(id, "staff");
    const params = new URL(request.url).searchParams;
    const query = parseDeskQuery(params);
    const limit = Number(params.get("limit"));
    const desk = await loadDesk(db, id, {
      query,
      limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
      cursor: params.get("cursor"),
      now: Date.now(),
    });
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
      nextCursor: desk.nextCursor,
      matchCount: desk.matchCount,
      searchReady: desk.searchReady,
      locations: desk.locations,
      aiSearch: desk.aiSearch,
      requester: desk.requester,
    });
  } catch (e) {
    return guardResponse(e);
  }
}
