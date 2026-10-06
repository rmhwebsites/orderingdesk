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
// broadcast, then its status goes to Shopify, PUSH_CONCURRENCY cards at a
// time, each write sent once (pushAndShare, as for one change). A bulk move
// sends no all-activity pushes: one per card would flood phones.
//
// A Worker has about 30 seconds after its response. One card's write takes
// several Shopify calls (more for a status linked to fulfilled), so 25 cards
// one at a time could run past that and silently lose the last writes; four
// at a time fits, and stays well inside Shopify's GraphQL rate limit. If the
// writes are still running after PUSH_WARN_MS, the cards not yet written are
// logged, so a write the Worker never finished can be found (its order has
// no shopify_write entry for the move) and its status saved again.
const PUSH_CONCURRENCY = 4;
const PUSH_WARN_MS = 20_000;

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
          const queue = result.changed.map((change) => change.order.id);
          const unfinished = new Set(queue);
          const slow = setTimeout(() => {
            console.warn("[bulk-status] " + JSON.stringify({ workspaceId: id, afterMs: PUSH_WARN_MS, unfinished: [...unfinished] }));
          }, PUSH_WARN_MS);
          // pushAndShare never throws, so one card cannot stop the others.
          const worker = async () => {
            for (let orderId = queue.shift(); orderId; orderId = queue.shift()) {
              await pushAndShare(db, env, id, orderId);
              unfinished.delete(orderId);
            }
          };
          try {
            await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, queue.length) }, worker));
          } finally {
            clearTimeout(slow);
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
