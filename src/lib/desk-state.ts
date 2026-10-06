// The desk's client state and every change to it, as pure functions: live
// events (src/lib/live-events.ts), optimistic status changes and their
// rollback, the count strip and the filtered list. Components hold a
// DeskState and only ever replace it with what these return.

import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
import type { DeskKind, DeskView, SortKey, ViewCounts } from "./desk-query";
import { formatMoney } from "./format";
import type { LiveEvent } from "./live-events";

// The open drawer's activity timeline, newest first.
export type Timeline = { orderId: string; events: EventView[] } | null;

export type DeskState = {
  orders: OrderSummary[];
  // Per status key over every order (not only the loaded list), including
  // keys that no longer have a status row.
  statusCounts: Record<string, number>;
  timeline: Timeline;
};

export type LiveEffects = {
  // Reload the desk payload (new or refreshed orders).
  refetch: boolean;
  // Reload the open drawer's order (its snapshot changed).
  reloadOpenOrder: boolean;
  // New orders to announce once the reload has their names.
  announceOrderIds: string[];
  // Rows to flash, now or once reloaded.
  flashOrderIds: string[];
  // An order card folded into its request card: a drawer open on fromId
  // moves to toId.
  merged?: { fromId: string; toId: string };
};

const NO_EFFECTS: LiveEffects = {
  refetch: false,
  reloadOpenOrder: false,
  announceOrderIds: [],
  flashOrderIds: [],
};

function moveCount(counts: Record<string, number>, from: string, to: string): Record<string, number> {
  if (from === to) {
    return counts;
  }
  return {
    ...counts,
    [from]: Math.max(0, (counts[from] ?? 0) - 1),
    [to]: (counts[to] ?? 0) + 1,
  };
}

function byNewest(a: EventView, b: EventView): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function withTimelineEvent(timeline: Timeline, event: EventView): Timeline {
  if (!timeline || timeline.orderId !== event.orderId) {
    return timeline;
  }
  if (timeline.events.some((existing) => existing.id === event.id)) {
    return timeline;
  }
  return { orderId: timeline.orderId, events: [event, ...timeline.events].sort(byNewest) };
}

function metaMove(meta: unknown): { from: string; to: string } | null {
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const { from, to } = meta as { from?: unknown; to?: unknown };
  return typeof from === "string" && typeof to === "string" ? { from, to } : null;
}

export function applyLiveEvent(
  state: DeskState,
  event: LiveEvent,
  selfUserId: string | null,
): { state: DeskState; effects: LiveEffects } {
  switch (event.kind) {
    case "orders.synced": {
      const landed = event.addedOrderIds.length + event.updatedOrderIds.length > 0;
      return {
        state,
        effects: {
          refetch: landed,
          reloadOpenOrder:
            state.timeline !== null && event.updatedOrderIds.includes(state.timeline.orderId),
          announceOrderIds: event.addedOrderIds,
          flashOrderIds: [...event.addedOrderIds, ...event.updatedOrderIds],
        },
      };
    }

    // Older orders from the order history import: reload the list, but they
    // are not arrivals, so nothing is announced or flashed.
    case "orders.imported":
      return { state, effects: { ...NO_EFFECTS, refetch: true } };

    // An order card folded into its request card (draft orders spec section
    // 11.7): the old row and its count go at once, the list reloads, and a
    // drawer open on the old card moves to the request card.
    case "order.merged": {
      const gone = state.orders.find((row) => row.id === event.fromId);
      const merged = { fromId: event.fromId, toId: event.toId };
      if (!gone) {
        return { state, effects: { ...NO_EFFECTS, refetch: true, merged } };
      }
      return {
        state: {
          ...state,
          orders: state.orders.filter((row) => row.id !== event.fromId),
          statusCounts: { ...state.statusCounts, [gone.statusKey]: Math.max(0, (state.statusCounts[gone.statusKey] ?? 0) - 1) },
        },
        effects: { ...NO_EFFECTS, refetch: true, merged },
      };
    }

    case "order.status": {
      const change = event.order;
      const byOther = event.event.actorId !== selfUserId;
      const timeline = withTimelineEvent(state.timeline, event.event);
      const index = state.orders.findIndex((row) => row.id === change.id);

      if (index === -1) {
        // Outside the loaded list: only the counts can follow, from the
        // event's own record of the move.
        const move = metaMove(event.event.meta);
        return {
          state: {
            ...state,
            statusCounts: move ? moveCount(state.statusCounts, move.from, move.to) : state.statusCounts,
            timeline,
          },
          effects: NO_EFFECTS,
        };
      }

      const row = state.orders[index];
      // Last writer wins, as on the server: an event older than what the
      // row already shows changes nothing.
      if (row.statusSetAt !== null && row.statusSetAt > change.statusSetAt) {
        return { state: timeline === state.timeline ? state : { ...state, timeline }, effects: NO_EFFECTS };
      }
      const moved = row.statusKey !== change.statusKey;
      const orders = state.orders.slice();
      orders[index] = {
        ...row,
        statusKey: change.statusKey,
        statusSetBy: change.statusSetBy,
        statusSetAt: change.statusSetAt,
      };
      return {
        state: {
          orders,
          statusCounts: moved ? moveCount(state.statusCounts, row.statusKey, change.statusKey) : state.statusCounts,
          timeline,
        },
        effects: { ...NO_EFFECTS, flashOrderIds: moved && byOther ? [row.id] : [] },
      };
    }

    case "order.note": {
      const timeline = withTimelineEvent(state.timeline, event.event);
      const byOther = event.event.actorId !== selfUserId;
      return {
        state: timeline === state.timeline ? state : { ...state, timeline },
        effects: {
          ...NO_EFFECTS,
          flashOrderIds: byOther && event.event.orderId ? [event.event.orderId] : [],
        },
      };
    }

    case "order.activity": {
      // A system entry (the outcome of writing a status to Shopify, a
      // purchase order drafted, sent or failed): the open drawer's timeline,
      // and a purchase order entry drops its card's "PO not created" hint.
      // No flash.
      const timeline = withTimelineEvent(state.timeline, event.event);
      const next = timeline === state.timeline ? state : { ...state, timeline };
      return {
        state: isPurchaseOrderEntry(event.event) && event.event.orderId ? withPurchaseOrder(next, event.event.orderId) : next,
        effects: NO_EFFECTS,
      };
    }
  }
}

function isPurchaseOrderEntry(event: EventView): boolean {
  return event.type === "po_draft" || event.type === "po_sent" || event.type === "po_failed";
}

// Whether a live event is a purchase order entry (drafted, sent, failed)
// for the order open in the drawer, whose PO history should then reload.
export function touchesPurchaseOrders(event: LiveEvent, openOrderId: string | null): boolean {
  return (
    openOrderId !== null &&
    event.kind === "order.activity" &&
    event.event.orderId === openOrderId &&
    isPurchaseOrderEntry(event.event)
  );
}

// A card the desk now knows has a purchase order (one was drafted, sent or
// failed, here or by someone else). Unchanged when it is not loaded or
// already had one. Purchase orders are never deleted.
export function withPurchaseOrder(state: DeskState, orderId: string): DeskState {
  const index = state.orders.findIndex((row) => row.id === orderId);
  if (index === -1 || state.orders[index].hasPo) {
    return state;
  }
  const orders = state.orders.slice();
  orders[index] = { ...orders[index], hasPo: true };
  return { ...state, orders };
}

// Owner decision after the Wave 1a plan: Approve and next skips the
// purchase order review, so an order whose status triggers a purchase order
// and that has none yet says "PO not created" (on its card and in the
// drawer). Requests never have purchase orders.
export function poNotCreated(row: Pick<OrderSummary, "kind" | "statusKey" | "hasPo">, statuses: StatusView[]): boolean {
  return row.kind === "order" && !row.hasPo && statuses.some((status) => status.key === row.statusKey && status.triggersPo);
}

// The toast after an approval. poLater: Approve and next skipped the
// purchase order review the status would open, so it says where to create
// it.
export function approvalNotice(orderName: string, poLater: boolean): { title: string; body?: string } {
  const title = `Approved. Order ${orderName} created in Shopify.`;
  return poLater ? { title, body: "Create its purchase order from the order when you are ready." } : { title };
}

// Shows a status change before the server confirms it. Null when there is
// nothing to change (unknown order, same status).
export function optimisticStatus(
  state: DeskState,
  orderId: string,
  nextKey: string,
): { state: DeskState; previousKey: string } | null {
  const index = state.orders.findIndex((row) => row.id === orderId);
  if (index === -1 || state.orders[index].statusKey === nextKey) {
    return null;
  }
  const row = state.orders[index];
  const orders = state.orders.slice();
  orders[index] = { ...row, statusKey: nextKey };
  return {
    state: { ...state, orders, statusCounts: moveCount(state.statusCounts, row.statusKey, nextKey) },
    previousKey: row.statusKey,
  };
}

// Undoes a failed optimistic change, unless the row has moved on since
// (someone else's newer change wins).
export function rollbackStatus(
  state: DeskState,
  orderId: string,
  attemptedKey: string,
  previousKey: string,
): DeskState {
  const index = state.orders.findIndex((row) => row.id === orderId);
  if (index === -1 || state.orders[index].statusKey !== attemptedKey) {
    return state;
  }
  const orders = state.orders.slice();
  orders[index] = { ...orders[index], statusKey: previousKey };
  return { ...state, orders, statusCounts: moveCount(state.statusCounts, attemptedKey, previousKey) };
}

export type StatusChip = {
  key: string;
  label: string;
  color: string;
  count: number;
  // False for a key with orders but no status row any more; shown as
  // "Unknown status" in slate with the raw key.
  known: boolean;
};

export function statusChips(statuses: StatusView[], counts: Record<string, number>): StatusChip[] {
  const known = new Set(statuses.map((status) => status.key));
  const chips: StatusChip[] = statuses.map((status) => ({
    key: status.key,
    label: status.label,
    color: status.color,
    count: counts[status.key] ?? 0,
    known: true,
  }));
  const unknown = Object.keys(counts)
    .filter((key) => !known.has(key) && (counts[key] ?? 0) > 0)
    .sort();
  for (const key of unknown) {
    chips.push({ key, label: "Unknown status", color: "slate", count: counts[key], known: false });
  }
  return chips;
}

export function totalOrders(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export type { DeskKind, DeskView, SortKey, ViewCounts };

export type DeskFilter = { query: string; statusKey: string | null; sort: SortKey; kind?: DeskKind; view?: DeskView };

function kindMatches(row: OrderSummary, kind: DeskKind): boolean {
  switch (kind) {
    case "all":
      return !row.draftDeleted;
    case "drafts":
      return row.kind === "draft" && !row.draftDeleted;
    case "orders":
      return row.kind === "order";
    case "deleted":
      return row.draftDeleted;
  }
}

// Which cards a view shows (the server loads the same set, src/server/desk/
// read.ts): Open leaves closed statuses out, Closed shows only them, the
// approval queue shows requests still waiting. Filtering here too means a
// card that moves into a closed status leaves Open at once.
export function viewMatches(row: OrderSummary, view: DeskView, closedKeys: ReadonlySet<string>): boolean {
  switch (view) {
    case "all":
      return true;
    case "open":
      return !closedKeys.has(row.statusKey);
    case "closed":
      return closedKeys.has(row.statusKey);
    case "approval":
      return row.kind === "draft" && !row.draftDeleted && !closedKeys.has(row.statusKey);
  }
}

// The view counts after a loaded card moved from one status to another.
// Unchanged (the same object) unless it crossed between open and closed; a
// request whose draft Shopify deleted counts in no view.
export function shiftViewCounts(
  counts: ViewCounts,
  row: Pick<OrderSummary, "kind" | "draftDeleted">,
  fromKey: string,
  toKey: string,
  closedKeys: ReadonlySet<string>,
): ViewCounts {
  if (row.kind === "draft" && row.draftDeleted) {
    return counts;
  }
  const wasClosed = closedKeys.has(fromKey);
  const isClosed = closedKeys.has(toKey);
  if (wasClosed === isClosed) {
    return counts;
  }
  const delta = isClosed ? 1 : -1;
  return {
    ...counts,
    open: counts.open - delta,
    closed: counts.closed + delta,
    approval: row.kind === "draft" ? counts.approval - delta : counts.approval,
  };
}

// Whether a status entry for a card the desk has not loaded moved it
// between open and closed (then only a reload can fix the counts).
export function crossesClosed(meta: unknown, closedKeys: ReadonlySet<string>): boolean {
  const move = metaMove(meta);
  return move !== null && closedKeys.has(move.from) !== closedKeys.has(move.to);
}

// The filter the list applies (src/components/desk/desk.tsx). The view in
// the address changes at once, but the desk holds the loaded view's cards
// until the asked-for view lands, so the list filters by the loaded view:
// it keeps showing those cards, dimmed, instead of emptying into the new
// view's empty state. The approval queue shows every kind.
export function listFilter(filter: DeskFilter, loadedView: DeskView): DeskFilter {
  return { ...filter, view: loadedView, kind: loadedView === "approval" ? "all" : filter.kind };
}

// Where the list stands against the view in the address: ready (it holds
// that view's cards), loading (the view changed and its cards have not
// landed; true from the render the address changes in, so nothing flashes
// before the load starts), or failed (the asked-for view's load failed;
// failedView is the last view whose load failed, cleared by a load that
// lands).
export function viewLoadState(
  askedView: DeskView,
  loadedView: DeskView,
  failedView: DeskView | null,
): "ready" | "loading" | "failed" {
  if (askedView === loadedView) {
    return "ready";
  }
  return failedView === askedView ? "failed" : "loading";
}

// The statuses the status filter offers in a view.
export function chipsForView(chips: StatusChip[], view: DeskView, closedKeys: ReadonlySet<string>): StatusChip[] {
  if (view === "all") {
    return chips;
  }
  return chips.filter((chip) => (view === "closed" ? closedKeys.has(chip.key) : !closedKeys.has(chip.key)));
}

// The loaded cards per kind filter (the server's counts cover every card;
// these are for what this desk has).
export function deskKindCounts(orders: OrderSummary[]): { drafts: number; orders: number; deleted: number } {
  return {
    drafts: orders.filter((row) => kindMatches(row, "drafts")).length,
    orders: orders.filter((row) => kindMatches(row, "orders")).length,
    deleted: orders.filter((row) => kindMatches(row, "deleted")).length,
  };
}

// The Deleted filter goes away with the last deleted request. The count is
// known only once a payload has loaded: before that it is the starting 0,
// and a reload or link with ?kind=deleted keeps the filter.
export function dropsDeletedFilter({ kind, deletedCount, loaded }: { kind: DeskKind; deletedCount: number; loaded: boolean }): boolean {
  return loaded && kind === "deleted" && deletedCount === 0;
}

// The live toast for cards that just arrived: "New request #D12 from
// Jordan Vale", "New order #1001 from Riley Oakes" with its total, or a
// count ("3 new requests", "2 new orders", "5 new orders and requests").
export function arrivalNotice(orders: OrderSummary[]): { title: string; body?: string } {
  if (orders.length === 1) {
    const [row] = orders;
    const who = row.customerName ? ` from ${row.customerName}` : "";
    if (row.kind === "draft") {
      return { title: `New request ${row.name}${who}` };
    }
    const total = formatMoney(row.total, row.currency);
    return total ? { title: `New order ${row.name}${who}`, body: total } : { title: `New order ${row.name}${who}` };
  }
  const requests = orders.filter((row) => row.kind === "draft").length;
  const names = orders.slice(0, 3).map((row) => row.name);
  const rest = orders.length - names.length;
  const title =
    requests === orders.length
      ? `${orders.length} new requests`
      : requests === 0
        ? `${orders.length} new orders`
        : `${orders.length} new orders and requests`;
  return { title, body: rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ") };
}

// The time a card has waited in its status: since its status was set, else
// since it arrived.
function waitingSince(row: OrderSummary): number {
  return row.statusSetAt ?? row.createdAt;
}

export function selectOrders(
  orders: OrderSummary[],
  filter: DeskFilter,
  closedKeys: ReadonlySet<string> = new Set(),
): OrderSummary[] {
  const query = filter.query.trim().toLowerCase();
  const kind = filter.kind ?? "all";
  const view = filter.view ?? "all";
  const matches = orders.filter((row) => {
    if (!viewMatches(row, view, closedKeys) || !kindMatches(row, kind)) {
      return false;
    }
    if (filter.statusKey !== null && row.statusKey !== filter.statusKey) {
      return false;
    }
    if (query.length === 0) {
      return true;
    }
    return (
      row.name.toLowerCase().includes(query) ||
      row.customerName.toLowerCase().includes(query) ||
      row.email.toLowerCase().includes(query) ||
      row.itemTitles.some((title) => title.toLowerCase().includes(query)) ||
      row.searchText.some((text) => text.toLowerCase().includes(query))
    );
  });
  const newest = (a: OrderSummary, b: OrderSummary) =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  switch (filter.sort) {
    case "newest":
      return matches.sort(newest);
    case "oldest":
      return matches.sort((a, b) => -newest(a, b));
    case "waiting":
      return matches.sort((a, b) => waitingSince(a) - waitingSince(b) || newest(a, b));
  }
}

// The request to open after an approval (comprehensive desk design section
// 1, Approve and next): the next waiting request after the current card in
// the list's order, wrapping round to the top; null when none waits.
export function nextWaitingRequest(
  visible: OrderSummary[],
  currentId: string,
  closedKeys: ReadonlySet<string>,
): { id: string; name: string } | null {
  const index = visible.findIndex((row) => row.id === currentId);
  const ordered = index === -1 ? visible : [...visible.slice(index + 1), ...visible.slice(0, index)];
  const next = ordered.find((row) => row.id !== currentId && viewMatches(row, "approval", closedKeys));
  return next ? { id: next.id, name: next.name } : null;
}
