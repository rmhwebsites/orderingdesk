// Realtime events: what the server broadcasts to a workspace room and what
// the desk applies. Shared by the server (src/server/broadcast.ts, bundled
// into the custom worker for cron, hence relative and type-only imports
// here) and the client (src/lib/use-live.ts).

import type { EventView } from "../server/desk/shapes";

// The close code a workspace room uses when it removes someone (their
// membership or platform admin access went): the client stops
// reconnecting instead of retrying.
export const LIVE_KICK_CLOSE_CODE = 4003;

// The close code a workspace room uses when a socket has been open for
// longer than it may go without a fresh check (src/realtime/room.ts): the
// client reconnects at once with a new ticket, whose route checks access
// again.
export const LIVE_REFRESH_CLOSE_CODE = 4001;

export type LiveOrderStatus = {
  id: string;
  statusKey: string;
  // Null for a move that came from Shopify (no person made it).
  statusSetBy: string | null;
  statusSetAt: number;
};

export type LiveEvent =
  // A sync run landed orders: new rows and refreshed snapshots, by order id.
  | { kind: "orders.synced"; addedOrderIds: string[]; updatedOrderIds: string[] }
  // The order history import stored this many older orders: refresh the
  // list, announce nothing.
  | { kind: "orders.imported"; count: number }
  // An order's status changed (a member, or Shopify); event is the timeline
  // entry.
  | { kind: "order.status"; event: EventView; order: LiveOrderStatus }
  // A member added a note; event is the timeline entry.
  | { kind: "order.note"; event: EventView }
  // A system timeline entry, such as the outcome of writing a status to
  // Shopify, or a purchase order drafted, sent or failed (po_* events; open
  // drawers reload the order's purchase orders).
  | { kind: "order.activity"; event: EventView }
  // An order card was folded into the draft card it came from (draft orders
  // spec section 6.4): fromId no longer exists, toId carries its history.
  | { kind: "order.merged"; fromId: string; toId: string };

const EVENT_TYPES = new Set([
  "order_new",
  "status",
  "note",
  "po_sent",
  "po_draft",
  "po_failed",
  "sync_error",
  "shopify_write",
  "draft_completed",
  "draft_deleted",
  "draft_edited",
  "order_cancelled",
  "request_placed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOrderEvent(value: unknown): value is EventView & { orderId: string } {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.orderId === "string" &&
    typeof value.type === "string" &&
    EVENT_TYPES.has(value.type) &&
    typeof value.text === "string" &&
    (value.actorId === null || typeof value.actorId === "string") &&
    typeof value.createdAt === "number"
  );
}

function isOrderStatus(value: unknown): value is LiveOrderStatus {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.statusKey === "string" &&
    (value.statusSetBy === null || typeof value.statusSetBy === "string") &&
    typeof value.statusSetAt === "number"
  );
}

// A socket message as a LiveEvent, or null for anything else (the "pong"
// heartbeat reply, garbage, a kind this client does not know yet).
export function parseLiveEvent(raw: string): LiveEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) {
    return null;
  }
  switch (data.kind) {
    case "orders.synced":
      return isStringArray(data.addedOrderIds) && isStringArray(data.updatedOrderIds)
        ? { kind: "orders.synced", addedOrderIds: data.addedOrderIds, updatedOrderIds: data.updatedOrderIds }
        : null;
    case "orders.imported":
      return typeof data.count === "number" && Number.isSafeInteger(data.count) && data.count > 0
        ? { kind: "orders.imported", count: data.count }
        : null;
    case "order.status":
      return isOrderEvent(data.event) && isOrderStatus(data.order)
        ? { kind: "order.status", event: data.event, order: data.order }
        : null;
    case "order.note":
      return isOrderEvent(data.event) ? { kind: "order.note", event: data.event } : null;
    case "order.activity":
      return isOrderEvent(data.event) ? { kind: "order.activity", event: data.event } : null;
    case "order.merged":
      return typeof data.fromId === "string" && data.fromId.length > 0 && typeof data.toId === "string" && data.toId.length > 0
        ? { kind: "order.merged", fromId: data.fromId, toId: data.toId }
        : null;
    default:
      return null;
  }
}
