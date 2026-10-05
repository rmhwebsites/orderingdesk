import { NextResponse } from "next/server";
import { loadDesk } from "@/server/desk/read";
import { AuthError, guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// The desk payload in one round trip: workspace, the caller's role, statuses
// by sort, settings, per-status counts over every order, and the newest order
// summaries (full snapshots come from GET /api/orders/[orderId]), the
// request counts and whether draft orders sync for the store.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, role } = await requireMember(id, "staff");
    const desk = await loadDesk(db, id);
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
    });
  } catch (e) {
    return guardResponse(e);
  }
}
