// Cancel an order after approval (comprehensive design section 2), behind
// POST /api/orders/[orderId]/cancel. Managers and platform admins only (the
// route answers 403 to staff, like Approve and Reject). Orders only: a
// request that is still a draft is rejected instead. A reason is required:
// saved as a note, and (cut to 255 characters) as Shopify's staff note.
//
// Rules, in order: the card must be an order; a status must follow
// Shopify's cancelled state; a card already in it answers
// already-cancelled. The order is read fresh: gone is refused; already
// cancelled in Shopify moves the card the way the orders/cancelled webhook
// would and sends nothing; a total that is not exactly 0 is refused
// (Ordering Desk never refunds). Then orderCancel goes out ONCE with
// notifyCustomer false, restock false and no refundMethod (no refund). A
// refusal changes nothing and says why in plain words. A timeout or a
// transport failure is followed by a read, never a resend: cancelled counts
// as done, anything else asks the manager to check Shopify (the webhook
// moves the card if Shopify did cancel). Shopify cancels in a background
// job, so an accepted cancel is read back up to REVIEW_READY_TRIES times;
// the card moves either way and the entry says whether Shopify confirmed.
// One batch: the move, its status entry, the reason note and an
// order_cancelled entry, the three entries only when the move landed.

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch, rowsAffected } from "@/db/batch";
import { events, orders, statuses, storeConnections } from "@/db/schema";
import { formatMoney } from "@/lib/format";
import { NOTE_MAX } from "@/lib/limits";
import { roleAtLeast } from "@/lib/roles";
import { broadcast, broadcastSync } from "@/server/broadcast";
import { notifyActivity } from "@/server/notify";
import {
  cancelOrderInShopify,
  companiesEnabled,
  failureText,
  fetchOrderCancelState,
  fetchOrderNode,
  type OrderCancelState,
} from "@/server/shopify/admin";
import { pushAndShare, shareShopifyMoves } from "@/server/shopify/fanout";
import { normalizeOrders } from "@/server/shopify/normalize";
import { applyShopifyMove, loadStatusRows, safeErrorReason, type StatusChange } from "@/server/shopify/status-sync";
import { getAccessToken } from "@/server/shopify/token";
import { upsertFetchedOrder } from "@/server/sync/run";
import {
  actorNameOf,
  linkedStatus,
  REVIEW_READY_TRIES,
  REVIEW_RETRY_MS,
  shopifyAccess,
  type ReviewContext,
  type ReviewDeps,
} from "./review";
import { eventView, isRecord, type EventView } from "./shapes";

export const CANCEL_COPY = {
  reason: "Give a reason (up to 4000 characters). It is saved as a note on the order.",
  forbidden: "Only a manager can cancel orders.",
  draft: "This request is still a draft. Use Reject instead; only orders are cancelled.",
  noStatus: "No status follows Shopify's cancelled state. A manager can set one in Settings > Statuses.",
  gone: "Shopify no longer has this order.",
  notConfirmed:
    "Shopify did not answer. Check the order in Shopify before trying again. If Shopify cancelled it, the card moves to Cancelled by itself.",
  moveFailed: "Shopify cancelled the order, but its status could not change here. Set it in the status list.",
} as const;

export type CancelOrderView = { id: string; statusKey: string; statusSetBy: string; statusSetAt: number };

export type CancelResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "forbidden"; error: string }
  | { kind: "refused"; status: 409 | 502; error: string }
  | { kind: "already-cancelled" }
  | { kind: "cancelled-in-shopify"; message: string; change: StatusChange | null }
  | {
      kind: "cancelled";
      order: CancelOrderView;
      events: EventView[];
      statusEvent: EventView;
      noteEvent: EventView;
      cancelEvent: EventView;
      // Shopify's background job was seen done (cancelledAt) before the
      // answer; false: accepted, still finishing.
      confirmed: boolean;
    };

type Card = { id: string; shopifyOrderId: string | null; name: string; statusKey: string };

const refused = <S extends 409 | 502>(status: S, error: string) => ({ kind: "refused" as const, status, error });

function sentence(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

function totalRefusal(state: OrderCancelState): string | null {
  const total = state.total;
  if (total !== null && total.trim().length > 0 && Number(total) === 0) {
    return null;
  }
  const amount = total !== null && total.trim().length > 0 ? formatMoney(total, state.currency) : null;
  return amount
    ? `This order totals ${amount}. Ordering Desk only cancels orders that total $0.00, because it never refunds. Cancel it in Shopify instead.`
    : "Shopify did not report this order's total. Ordering Desk only cancels orders that total $0.00, because it never refunds. Cancel it in Shopify instead.";
}

function refusalText(detail: string, state: OrderCancelState): string {
  const said = sentence(detail);
  return state.fulfillment === "FULFILLED" || state.fulfillment === "PARTIALLY_FULFILLED"
    ? `Shopify did not cancel this order because items on it are already fulfilled (Shopify said: ${said}). Nothing changed.`
    : `Shopify did not cancel the order (Shopify said: ${said}). Nothing changed.`;
}

export async function cancelOrder(db: Db, ctx: ReviewContext, body: unknown, deps: ReviewDeps): Promise<CancelResult> {
  const clock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const raw = isRecord(body) ? body.reason : undefined;
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0 || reason.length > NOTE_MAX) {
    return { kind: "invalid", error: CANCEL_COPY.reason };
  }
  const rows = await db
    .select({ id: orders.id, shopifyOrderId: orders.shopifyOrderId, name: orders.name, statusKey: orders.statusKey })
    .from(orders)
    .where(and(eq(orders.id, ctx.orderId), eq(orders.workspaceId, ctx.workspaceId)))
    .limit(1);
  const card: Card | undefined = rows[0];
  if (!card) {
    return { kind: "not-found" };
  }
  if (!roleAtLeast(ctx.role, "manager")) {
    return { kind: "forbidden", error: CANCEL_COPY.forbidden };
  }
  if (card.shopifyOrderId === null) {
    return refused(409, CANCEL_COPY.draft);
  }
  const target = await linkedStatus(db, ctx.workspaceId, "cancelled");
  if (!target) {
    return refused(409, CANCEL_COPY.noStatus);
  }
  if (card.statusKey === target.key) {
    return { kind: "already-cancelled" };
  }
  const granted = await shopifyAccess(db, ctx.workspaceId, deps);
  if (granted.kind !== "ok") {
    return granted;
  }
  const { access } = granted;
  const gid = `gid://shopify/Order/${card.shopifyOrderId}`;

  const before = await fetchOrderCancelState(access.shopDomain, access.token, gid, access.fetchImpl);
  if (before.kind !== "ok") {
    return refused(502, `Could not check the order in Shopify (${sentence(failureText(before))}). Nothing changed. Try again.`);
  }
  if (before.order === null) {
    return refused(409, CANCEL_COPY.gone);
  }
  if (before.order.cancelledAt !== null) {
    return followShopifyCancel(db, ctx, card, before.order.name || card.name, clock);
  }
  const notZero = totalRefusal(before.order);
  if (notZero) {
    return refused(409, notZero);
  }

  const sent = await cancelOrderInShopify(access.shopDomain, access.token, gid, `Ordering Desk: ${reason}`, access.fetchImpl);
  if (sent.kind === "refused") {
    return refused(409, refusalText(sent.detail, before.order));
  }
  let confirmed = false;
  if (sent.kind === "ok") {
    confirmed = sent.done;
    for (let attempt = 0; !confirmed && attempt < REVIEW_READY_TRIES; attempt++) {
      await sleep(REVIEW_RETRY_MS);
      const read = await fetchOrderCancelState(access.shopDomain, access.token, gid, access.fetchImpl);
      confirmed = read.kind === "ok" && read.order !== null && read.order.cancelledAt !== null;
    }
  } else {
    // A timeout or transport failure: read, never send again.
    const read = await fetchOrderCancelState(access.shopDomain, access.token, gid, access.fetchImpl);
    if (read.kind !== "ok" || read.order === null || read.order.cancelledAt === null) {
      return refused(502, CANCEL_COPY.notConfirmed);
    }
    confirmed = true;
  }
  return commitCancel(db, ctx, card, target, reason, confirmed, sent.kind === "ok" ? sent.jobId : null, clock());
}

// The order was cancelled in Shopify before this cancel: nothing is sent;
// the card moves exactly as the orders/cancelled webhook would move it.
async function followShopifyCancel(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  orderName: string,
  clock: () => number,
): Promise<CancelResult> {
  const rows = await loadStatusRows(db, ctx.workspaceId);
  const to = rows.find((row) => row.shopifyLink === "cancelled");
  const change = to ? await applyShopifyMove(db, ctx.workspaceId, card.id, card.statusKey, to, "cancelled", clock()) : null;
  return {
    kind: "cancelled-in-shopify",
    message: `Order ${orderName} was already cancelled in Shopify. The card is now Cancelled.`,
    change,
  };
}

async function commitCancel(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  target: { key: string; label: string },
  reason: string,
  confirmed: boolean,
  jobId: string | null,
  now: number,
): Promise<CancelResult> {
  const base = { workspaceId: ctx.workspaceId, orderId: card.id, actorId: ctx.userId, createdAt: now, source: "app" as const };
  const statusEvent = {
    ...base,
    id: crypto.randomUUID(),
    type: "status" as const,
    text: `Cancelled the order in Shopify. Status set to ${target.label}`,
    meta: { from: card.statusKey, to: target.key, action: "cancel" },
  };
  const noteEvent = { ...base, id: crypto.randomUUID(), type: "note" as const, text: reason, meta: { cancelReason: true } };
  const cancelEvent = {
    ...base,
    id: crypto.randomUUID(),
    type: "order_cancelled" as const,
    text: confirmed
      ? "Shopify cancelled the order: no email to the customer, no restock, no refund."
      : "Shopify accepted the cancellation and is finishing it: no email to the customer, no restock, no refund.",
    meta: { confirmed, jobId },
  };
  const statusExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${ctx.workspaceId} and ${statuses.key} = ${target.key})`;
  const moved = sql`exists (select 1 from ${orders} where ${orders.id} = ${card.id} and ${orders.statusKey} = ${target.key} and ${orders.statusSetAt} = ${now} and ${orders.statusSetBy} = ${ctx.userId})`;
  // Values in the events table's column order (as in changeOrderStatus).
  const insertWhenMoved = (event: typeof statusEvent | typeof noteEvent | typeof cancelEvent) =>
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${moved}`,
      );
  const [update] = await applyBatch(db, [
    db
      .update(orders)
      .set({ statusKey: target.key, statusSetBy: ctx.userId, statusSetAt: now })
      .where(
        and(
          eq(orders.id, card.id),
          eq(orders.workspaceId, ctx.workspaceId),
          isNotNull(orders.shopifyOrderId),
          ne(orders.statusKey, target.key),
          statusExists,
        ),
      ),
    insertWhenMoved(statusEvent),
    insertWhenMoved(noteEvent),
    insertWhenMoved(cancelEvent),
  ]);
  if (rowsAffected(update, "cancel") === 0) {
    const fresh = await db.select({ statusKey: orders.statusKey }).from(orders).where(eq(orders.id, card.id)).limit(1);
    return fresh[0]?.statusKey === target.key ? { kind: "already-cancelled" } : refused(409, CANCEL_COPY.moveFailed);
  }
  const actorName = await actorNameOf(db, ctx.userId);
  const [statusView, noteView, cancelView] = [statusEvent, noteEvent, cancelEvent].map((event) => ({ ...eventView(event), actorName }));
  return {
    kind: "cancelled",
    order: { id: card.id, statusKey: target.key, statusSetBy: ctx.userId, statusSetAt: now },
    events: [statusView, noteView, cancelView],
    statusEvent: statusView,
    noteEvent: noteView,
    cancelEvent: cancelView,
    confirmed,
  };
}

// The order as Shopify has it now, written onto the card (cancelledAt
// lands on the snapshot, so the drawer stops saying "not confirmed").
async function refreshOrderSnapshot(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  deps: Omit<ReviewDeps, "env">,
): Promise<void> {
  const clock = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rows = await db
    .select({ shopifyOrderId: orders.shopifyOrderId })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
    .limit(1);
  const shopifyOrderId = rows[0]?.shopifyOrderId;
  if (!shopifyOrderId) {
    return;
  }
  // Taken before the fetch, like a sync run's now (the claim rule).
  const now = clock();
  const token = await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
  if (token.kind !== "ok") {
    return;
  }
  // The same selection the sync uses for this store (the company location
  // only with a companies scope, Task 4).
  const grant = await db
    .select({ scopes: storeConnections.scopes })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const fetched = await fetchOrderNode(token.shopDomain, token.token, `gid://shopify/Order/${shopifyOrderId}`, fetchImpl, {
    companies: companiesEnabled(grant[0]?.scopes),
  });
  const [order] = fetched.kind === "ok" && fetched.node ? normalizeOrders([fetched.node]) : [];
  if (!order) {
    return;
  }
  const outcome = await upsertFetchedOrder(db, workspaceId, order, now);
  if (outcome.kind === "updated" || outcome.kind === "attached") {
    await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [outcome.orderId] });
    await shareShopifyMoves(db, env, workspaceId, outcome.statusChanges, { fetchImpl, now: clock });
  }
}

// After the response: open desks hear about it, members who follow all
// activity get one push, Shopify's cancelled order is written onto the card,
// and the order gets the "Ordering Desk: Cancelled" tag. Never throws.
export async function followCancellation(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  result: Extract<CancelResult, { kind: "cancelled" | "cancelled-in-shopify" }>,
  deps: Omit<ReviewDeps, "env">,
): Promise<void> {
  const opts = { fetchImpl: deps.fetchImpl, now: deps.now };
  try {
    if (result.kind === "cancelled") {
      await broadcast(env, workspaceId, { kind: "order.status", event: result.statusEvent, order: result.order });
      await broadcast(env, workspaceId, { kind: "order.note", event: result.noteEvent });
      await broadcast(env, workspaceId, { kind: "order.activity", event: result.cancelEvent });
      await notifyActivity(db, env, workspaceId, result.statusEvent, opts);
    } else if (result.change) {
      await shareShopifyMoves(db, env, workspaceId, [result.change], opts);
    }
    await refreshOrderSnapshot(db, env, workspaceId, orderId, deps);
    if (result.kind === "cancelled") {
      await pushAndShare(db, env, workspaceId, orderId, opts);
    }
  } catch (e) {
    console.warn("[cancel] " + JSON.stringify({ workspaceId, orderId, follow: safeErrorReason(e) }));
  }
}
