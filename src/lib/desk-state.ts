// The desk's client state and every change to it, as pure functions: live
// events (src/lib/live-events.ts), optimistic status changes and their
// rollback, the count strip and the filtered list. Components hold a
// DeskState and only ever replace it with what these return.

import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
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
      // A system entry (the outcome of writing a status to Shopify): the
      // open drawer's timeline only, no row change and no flash.
      const timeline = withTimelineEvent(state.timeline, event.event);
      return { state: timeline === state.timeline ? state : { ...state, timeline }, effects: NO_EFFECTS };
    }
  }
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

export type SortKey = "newest" | "oldest" | "total";

export type DeskFilter = { query: string; statusKey: string | null; sort: SortKey };

function amount(total: string): number {
  const value = Number(total);
  return Number.isFinite(value) ? value : -Infinity;
}

export function selectOrders(orders: OrderSummary[], filter: DeskFilter): OrderSummary[] {
  const query = filter.query.trim().toLowerCase();
  const matches = orders.filter((row) => {
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
      row.itemTitles.some((title) => title.toLowerCase().includes(query))
    );
  });
  const newest = (a: OrderSummary, b: OrderSummary) =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  switch (filter.sort) {
    case "newest":
      return matches.sort(newest);
    case "oldest":
      return matches.sort((a, b) => -newest(a, b));
    case "total":
      return matches.sort((a, b) => amount(b.total) - amount(a.total) || newest(a, b));
  }
}
