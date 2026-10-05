import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { followRejection, rejectRequest, REVIEW_COPY } from "@/server/desk/review";
import { guardResponse, requireMemberByOrder, roleAtLeast } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// Reject a request (draft orders spec section 9.2; src/server/desk/
// review.ts). Body {reason}: trimmed, 1 to 4000 characters, saved as a
// note. Managers and platform admins: 404 for outsiders, 403 for staff. 200
// {kind: "rejected", order, events}, 200 {kind: "unchanged"} when it is
// already rejected (no second note); 400 or 409 {error}. Nothing is deleted
// and nobody is emailed; the "Ordering Desk: Rejected" tag goes to the
// draft in Shopify after the response.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: REVIEW_COPY.forbidden }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await rejectRequest(db, { workspaceId, orderId, userId, role }, body, {});
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused":
        return NextResponse.json({ error: result.error }, { status: result.status });
      case "unchanged":
        return NextResponse.json({ kind: "unchanged" });
      case "rejected": {
        const { env, ctx } = getCloudflareContext();
        ctx.waitUntil(followRejection(db, env, workspaceId, orderId, result, {}));
        return NextResponse.json({ kind: result.kind, order: result.order, events: result.events });
      }
    }
  } catch (e) {
    return guardResponse(e);
  }
}
