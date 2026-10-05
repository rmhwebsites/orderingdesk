// Write side of the desk: status changes and notes. Each write produces an
// activity event, returned so the route can hand it to the realtime layer.
// Callers authorize first (requireMemberByOrder); every query here is still
// scoped to the workspace it is given.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch, rowsAffected } from "@/db/batch";
import { events, orders, statuses } from "@/db/schema";
import { NOTE_MAX } from "@/lib/limits";
import { roleAtLeast, type Role } from "@/lib/roles";
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

// Sets an order's status. The order update and its "status" event go out in
// one batch, so on D1 neither lands without the other. Only the team's own
// columns change (statusKey, statusSetBy, statusSetAt): the Shopify snapshot
// and synced_at belong to the sync engine. Concurrent changes resolve last
// writer wins; each one still leaves its own event.
//
// Draft cards (draft orders spec section 8.2 and section 18 item 5; a card
// is a draft while it has no Shopify order id):
// - a request moves freely between statuses with no Shopify link, staff
//   included;
// - never into a status linked to fulfilled or delivered (it is not an
//   order yet), nor to draft_completed or draft_rejected (Approve and
//   Reject do that, with their own checks and the reason);
// - out of the draft_rejected status only for a manager or platform admin;
// - an order never moves into the draft_rejected status;
// - triggersPo only for an order (a purchase order needs the Shopify order).
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
  if (isDraft) {
    const current = statusRows.find((row) => row.key === order.statusKey);
    if (current?.shopifyLink === "draft_rejected" && !roleAtLeast(ctx.role, "manager")) {
      return { kind: "forbidden", error: "Only a manager can reopen a rejected request." };
    }
    switch (status.shopifyLink) {
      case "fulfilled":
      case "delivered":
        return {
          kind: "invalid",
          error: `A draft cannot be marked ${status.label} until it is approved and becomes an order.`,
        };
      case "draft_completed":
        return { kind: "invalid", error: "Use Approve to approve this request. It creates the order in Shopify." };
      case "draft_rejected":
        return { kind: "invalid", error: "Use Reject to reject this request. It asks for a reason." };
      default:
        break;
    }
  } else if (status.shopifyLink === "draft_rejected") {
    return { kind: "invalid", error: "Rejected is for requests that are still drafts." };
  }

  const now = ctx.now ?? Date.now();
  const event = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: order.id,
    type: "status" as const,
    text: `Status set to ${status.label}`,
    actorId: ctx.userId,
    meta: { from: order.statusKey, to: statusKey },
    createdAt: now,
    source: "app" as const,
  };
  // The status was read above, but replaceStatuses may remove it before
  // this write lands. Both statements therefore re-check in SQL that it
  // still exists: the update only matches while it does, and the event is
  // an insert-select that yields its one row only while it does. On D1 the
  // batch is one transaction, so the two agree; rows-affected of the update
  // tells which way it went.
  const statusStillExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${ctx.workspaceId} and ${statuses.key} = ${statusKey})`;
  const [updateResult] = await applyBatch(db, [
    db
      .update(orders)
      .set({ statusKey, statusSetBy: ctx.userId, statusSetAt: now })
      .where(
        and(eq(orders.id, order.id), eq(orders.workspaceId, ctx.workspaceId), statusStillExists),
      ),
    // Values in the events table's column order (schema.ts declares the
    // columns in that order; drizzle names them all in the insert).
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${statusStillExists}`,
      ),
  ]);
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
