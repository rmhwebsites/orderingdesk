// Write side of the desk: status changes and notes. Each write produces an
// activity event, returned so the route can hand it to the realtime layer.
// Callers authorize first (requireMemberByOrder); every query here is still
// scoped to the workspace it is given.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch, rowsAffected } from "@/db/batch";
import { events, orders, statuses } from "@/db/schema";
import { NOTE_MAX } from "@/lib/limits";
import type { Role } from "@/lib/roles";
import { BULK_STATUS_MAX, checkStatusMove } from "@/lib/status-rules";
import { eventView, isRecord, type EventView } from "./shapes";

// Shared with the note composer (src/lib/limits.ts).
export { NOTE_MAX };

export type MutationContext = {
  workspaceId: string;
  orderId: string;
  userId: string;
  // The caller's effective role in the workspace (requireMemberByOrder).
  role: Role;
  // Injectable clock for tests.
  now?: number;
};

export type StatusChangeResult =
  | { kind: "invalid"; error: string }
  // The rule needs a manager (the route answers 403).
  | { kind: "forbidden"; error: string }
  | { kind: "not-found" }
  | { kind: "unchanged" }
  | {
      kind: "changed";
      event: EventView;
      order: { id: string; statusKey: string; statusSetBy: string; statusSetAt: number };
      triggersPo: boolean;
    };

export type NoteResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "added"; event: EventView };

async function findOrder(db: Db, ctx: MutationContext) {
  const rows = await db
    .select({ id: orders.id, statusKey: orders.statusKey, shopifyOrderId: orders.shopifyOrderId })
    .from(orders)
    .where(and(eq(orders.id, ctx.orderId), eq(orders.workspaceId, ctx.workspaceId)))
    .limit(1);
  return rows[0];
}

type StatusEvent = {
  id: string;
  workspaceId: string;
  orderId: string;
  type: "status";
  text: string;
  actorId: string;
  meta: Record<string, unknown>;
  createdAt: number;
  source: "app";
};

// The two statements of one status change: the order update and its status
// entry. The status was read before, but replaceStatuses may remove it
// before this write lands, so both re-check in SQL that it still exists:
// the update only matches while it does, and the entry is an insert-select
// that yields its one row only while it does. On D1 a batch is one
// transaction, so the two agree; the update's rows-affected tells which way
// it went.
function statusWrites(db: Db, event: StatusEvent, statusKey: string) {
  const statusStillExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${event.workspaceId} and ${statuses.key} = ${statusKey})`;
  return [
    db
      .update(orders)
      .set({ statusKey, statusSetBy: event.actorId, statusSetAt: event.createdAt })
      .where(and(eq(orders.id, event.orderId), eq(orders.workspaceId, event.workspaceId), statusStillExists)),
    // Values in the events table's column order (schema.ts declares the
    // columns in that order; drizzle names them all in the insert).
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${statusStillExists}`,
      ),
  ];
}

// Sets an order's status. The order update and its "status" event go out in
// one batch, so on D1 neither lands without the other. Only the team's own
// columns change (statusKey, statusSetBy, statusSetAt): the Shopify snapshot
// and synced_at belong to the sync engine. Concurrent changes resolve last
// writer wins; each one still leaves its own event. The rules for which
// status a card may take (a card is a draft while it has no Shopify order
// id) live in src/lib/status-rules.ts; triggersPo only for an order (a
// purchase order needs the Shopify order).
export async function changeOrderStatus(
  db: Db,
  ctx: MutationContext,
  body: unknown,
): Promise<StatusChangeResult> {
  const statusKey = isRecord(body) ? body.statusKey : undefined;
  if (typeof statusKey !== "string" || statusKey.length === 0) {
    return { kind: "invalid", error: "statusKey is required" };
  }

  const [order, statusRows] = await Promise.all([
    findOrder(db, ctx),
    db
      .select({
        key: statuses.key,
        label: statuses.label,
        triggersPo: statuses.triggersPo,
        shopifyLink: statuses.shopifyLink,
      })
      .from(statuses)
      .where(eq(statuses.workspaceId, ctx.workspaceId)),
  ]);
  if (!order) {
    return { kind: "not-found" };
  }
  const status = statusRows.find((row) => row.key === statusKey);
  if (!status) {
    return { kind: "invalid", error: "Unknown status for this workspace" };
  }
  if (order.statusKey === statusKey) {
    return { kind: "unchanged" };
  }
  const isDraft = order.shopifyOrderId === null;
  const check = checkStatusMove({
    isDraft,
    role: ctx.role,
    current: statusRows.find((row) => row.key === order.statusKey),
    target: status,
  });
  if (!check.ok) {
    return check.forbidden ? { kind: "forbidden", error: check.error } : { kind: "invalid", error: check.error };
  }

  const now = ctx.now ?? Date.now();
  const event: StatusEvent = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: order.id,
    type: "status",
    text: `Status set to ${status.label}`,
    actorId: ctx.userId,
    meta: { from: order.statusKey, to: statusKey },
    createdAt: now,
    source: "app",
  };
  const [updateResult] = await applyBatch(db, statusWrites(db, event, statusKey));
  if (rowsAffected(updateResult, "desk") === 0) {
    return { kind: "invalid", error: "Unknown status for this workspace" };
  }

  return {
    kind: "changed",
    event: eventView(event),
    order: { id: order.id, statusKey, statusSetBy: ctx.userId, statusSetAt: now },
    triggersPo: status.triggersPo && !isDraft,
  };
}

// Adds a note to an order's timeline. The text is trimmed; 1 to NOTE_MAX
// characters after trimming. Line breaks inside are kept.
export async function addOrderNote(
  db: Db,
  ctx: MutationContext,
  body: unknown,
): Promise<NoteResult> {
  const raw = isRecord(body) ? body.text : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0 || text.length > NOTE_MAX) {
    return { kind: "invalid", error: `A note must be 1 to ${NOTE_MAX} characters` };
  }

  const order = await findOrder(db, ctx);
  if (!order) {
    return { kind: "not-found" };
  }

  const event = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: order.id,
    type: "note" as const,
    text,
    actorId: ctx.userId,
    meta: null,
    createdAt: ctx.now ?? Date.now(),
    source: "app" as const,
  };
  await db.insert(events).values(event);
  return { kind: "added", event: eventView(event) };
}

export type BulkContext = { workspaceId: string; userId: string; role: Role; now?: number };

export type BulkOutcome = {
  orderId: string;
  // The card's name, or null when it is not in this workspace.
  name: string | null;
  outcome: "changed" | "unchanged" | "refused" | "not-found";
  error?: string;
};

export type BulkStatusResult =
  | { kind: "invalid"; error: string }
  | {
      kind: "ok";
      statusLabel: string;
      results: BulkOutcome[];
      changed: Array<{
        event: EventView;
        order: { id: string; statusKey: string; statusSetBy: string; statusSetAt: number };
      }>;
      // An order moved into a status that starts a purchase order.
      triggersPo: boolean;
    };

function parseBulk(body: unknown): { orderIds: string[]; statusKey: string } | string {
  if (!isRecord(body)) {
    return "Send orderIds and statusKey";
  }
  const { orderIds, statusKey } = body;
  if (typeof statusKey !== "string" || statusKey.length === 0) {
    return "statusKey is required";
  }
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return "Pick at least one card";
  }
  if (orderIds.length > BULK_STATUS_MAX) {
    return `Move up to ${BULK_STATUS_MAX} cards at a time`;
  }
  const ids: string[] = [];
  for (const id of orderIds) {
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      return "orderIds must be card ids";
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return { orderIds: ids, statusKey };
}

// Bulk status change (comprehensive desk design section 1): every card
// checked with the same rules as one change (src/lib/status-rules.ts),
// then every allowed change written in one batch (two statements each, at
// most 50; each statement binds 11 parameters or fewer). Cards outside the
// workspace answer not-found, like an unknown id.
export async function changeOrderStatuses(db: Db, ctx: BulkContext, body: unknown): Promise<BulkStatusResult> {
  const parsed = parseBulk(body);
  if (typeof parsed === "string") {
    return { kind: "invalid", error: parsed };
  }
  const [orderRows, statusRows] = await Promise.all([
    db
      .select({ id: orders.id, name: orders.name, statusKey: orders.statusKey, shopifyOrderId: orders.shopifyOrderId })
      .from(orders)
      .where(and(eq(orders.workspaceId, ctx.workspaceId), inArray(orders.id, parsed.orderIds))),
    db
      .select({ key: statuses.key, label: statuses.label, triggersPo: statuses.triggersPo, shopifyLink: statuses.shopifyLink })
      .from(statuses)
      .where(eq(statuses.workspaceId, ctx.workspaceId)),
  ]);
  const target = statusRows.find((row) => row.key === parsed.statusKey);
  if (!target) {
    return { kind: "invalid", error: "Unknown status for this workspace" };
  }
  const now = ctx.now ?? Date.now();
  const results: BulkOutcome[] = [];
  const planned: Array<{ order: (typeof orderRows)[number]; event: StatusEvent }> = [];
  for (const id of parsed.orderIds) {
    const order = orderRows.find((row) => row.id === id);
    if (!order) {
      results.push({ orderId: id, name: null, outcome: "not-found" });
      continue;
    }
    if (order.statusKey === target.key) {
      results.push({ orderId: id, name: order.name, outcome: "unchanged" });
      continue;
    }
    const check = checkStatusMove({
      isDraft: order.shopifyOrderId === null,
      role: ctx.role,
      current: statusRows.find((row) => row.key === order.statusKey),
      target,
    });
    if (!check.ok) {
      results.push({ orderId: id, name: order.name, outcome: "refused", error: check.error });
      continue;
    }
    planned.push({
      order,
      event: {
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        orderId: order.id,
        type: "status",
        text: `Status set to ${target.label}`,
        actorId: ctx.userId,
        meta: { from: order.statusKey, to: target.key, bulk: true },
        createdAt: now,
        source: "app",
      },
    });
    results.push({ orderId: id, name: order.name, outcome: "changed" });
  }

  const writes = await applyBatch(
    db,
    planned.flatMap(({ event }) => statusWrites(db, event, target.key)),
  );
  const changed: Extract<BulkStatusResult, { kind: "ok" }>["changed"] = [];
  let triggersPo = false;
  planned.forEach(({ order, event }, index) => {
    if (rowsAffected(writes[index * 2], "desk") === 0) {
      const result = results.find((entry) => entry.orderId === order.id);
      if (result) {
        result.outcome = "refused";
        result.error = "Unknown status for this workspace";
      }
      return;
    }
    changed.push({
      event: eventView(event),
      order: { id: order.id, statusKey: target.key, statusSetBy: ctx.userId, statusSetAt: now },
    });
    triggersPo ||= target.triggersPo && order.shopifyOrderId !== null;
  });
  return { kind: "ok", statusLabel: target.label, results, changed, triggersPo };
}
