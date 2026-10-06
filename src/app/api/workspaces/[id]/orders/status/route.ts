import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { broadcast } from "@/server/broadcast";
import { changeOrderStatuses } from "@/server/desk/mutations";
import { guardResponse, requireMember } from "@/server/guard";
import { pushAndShare } from "@/server/shopify/fanout";

type RouteContext = { params: Promise<{ id: string }> };

// Bulk status change (comprehensive desk design section 1). Body {orderIds
// (up to 25), statusKey}. Every member who can change one card's status
// (staff included); 401 signed out, 404 for outsiders. The server checks
// every card with the rules of one change (src/lib/status-rules.ts): no
// bulk approve or reject, no request into a fulfilled or delivered status,
// no staff reopening a rejected request; cards it refuses are listed with
// why, and nothing about them changes. 200 {statusLabel, results:
// [{orderId, name, outcome, error?}], changed: [{event, order}],
// triggersPo}; 400 {error}. After the response each moved card is
// broadcast, then its status goes to Shopify one card at a time, each write
// sent once (pushAndShare, as for one change). A bulk move sends no
// all-activity pushes: one per card would flood phones.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId, role } = await requireMember(id, "staff");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await changeOrderStatuses(db, { workspaceId: id, userId, role }, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (result.changed.length > 0) {
      const { env, ctx } = getCloudflareContext();
      ctx.waitUntil(
        (async () => {
          for (const change of result.changed) {
            await broadcast(env, id, { kind: "order.status", event: change.event, order: change.order });
          }
          for (const change of result.changed) {
            await pushAndShare(db, env, id, change.order.id);
          }
        })(),
      );
    }
    return NextResponse.json({
      statusLabel: result.statusLabel,
      results: result.results,
      changed: result.changed,
      triggersPo: result.triggersPo,
    });
  } catch (e) {
    return guardResponse(e);
  }
}
