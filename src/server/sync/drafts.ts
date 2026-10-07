// Draft orders in the sync engine (draft orders spec sections 5 and 6).
// Relative imports on purpose: this module is bundled into the custom worker
// entrypoint (cron), not only the Next.js build.
//
// One row per request (model A): a draft card is an orders row with
// shopify_order_id null and shopify_draft_id set. When Shopify reports the
// order the draft became, the SAME row gets the order id (attach), so its
// id, status, notes, events, purchase orders and notified_at claim carry
// over, and the order never announces itself as new. The rules, stated once:
// - a draft row is inserted only for an OPEN or INVOICE_SENT draft that has
//   no row (order_draft_unique);
// - attach is the only way a draft row gets an order id: a compare-and-set
//   on shopify_order_id IS NULL that never changes id, created_at, status_*
//   or notified_at, idempotent (a row already carrying the order id is
//   "already");
// - if another row O already carries the order id (an order row stored
//   before the link was known), O is merged into the draft row D, D's id
//   survives and O is deleted;
// - after attach, draft writes touch only draft_snapshot, and
//   draft_deleted_at is never set: the order snapshot owns shopify.
//
// Four signals can link a draft to its order, in any order, and each goes
// through attachOrderToDraft: the drafts phase seeing the draft completed,
// an order arriving first (the parent lookup), the approve response (stage
// 2) and the hourly check of every open draft card.
//
// Claim rule: like orders (see claimAndLoad in run.ts), synced_at is the
// start time of the latest run that has looked at the row; a run claims the
// draft rows it fetched before reading them, and its snapshot writes are
// guarded on synced_at <= now, so an older run never writes over a newer
// one.

import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { applyBatch, rowsAffected } from "../../db/batch";
import { events, orders, purchaseOrders, storeConnections } from "../../db/schema";
import { eventView, type EventView } from "../desk/shapes";
import { failureText, fetchDraftLinks, fetchOrderNode } from "../shopify/admin";
import { fetchDraftsUpdatedSince } from "../shopify/client";
import { normalizeDrafts, normalizeOrders, snapshotKind, type NormalizedDraft, type NormalizedOrder } from "../shopify/normalize";
import {
  evaluateShopifyTransitions,
  initialStatusFor,
  loadStatusRows,
  type SnapshotTransition,
  type StatusChange,
  type StatusRow,
} from "../shopify/status-sync";
import {
  claimAndLoad,
  EXISTENCE_CHUNK,
  OVERLAP_MS,
  parseResumeToken,
  resumeToken,
  upsertFetchedOrder,
  type KnownOrder,
} from "./run";

// The open-draft check (section 6.6) runs at most this often.
export const DRAFT_CHECK_EVERY_MS = 60 * 60 * 1000;
// Open draft cards the hourly check looks at, newest first.
export const DRAFT_CHECK_MAX = 1000;
// Open draft cards the parent lookup asks Shopify about (two requests).
export const DRAFT_LINK_MAX_CANDIDATES = 200;
// Orders fetched per run for cards that still show their draft after an
// attach (section 6.5); the rest wait for the next run.
export const ENSURE_ORDER_MAX = 20;

type ConnectionWrite = Partial<typeof storeConnections.$inferInsert>;

export type OrderMerge = { fromId: string; toId: string };

// What Shopify access the lookups need.
export type ShopifyAccess = { shopDomain: string; token: string; fetchImpl: typeof fetch };

function changesOf(result: unknown): number {
  return rowsAffected(result, "sync");
}

// The innermost error message: drizzle wraps a failed query in an error
// whose cause is the driver's.
function innermostMessage(e: unknown): string {
  let current = e;
  for (let depth = 0; depth < 10 && current instanceof Error && current.cause instanceof Error; depth++) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : "";
}

// Another row already carries this order id (order_unique).
export function isOrderIdTaken(e: unknown): boolean {
  const message = innermostMessage(e);
  return message.includes("UNIQUE constraint failed") && message.includes("shopify_order_id");
}

// Another row already carries this draft id (order_draft_unique).
function isDraftIdTaken(e: unknown): boolean {
  const message = innermostMessage(e);
  return message.includes("UNIQUE constraint failed") && message.includes("shopify_draft_id");
}

function logIds(fields: Record<string, unknown>): void {
  console.warn("[drafts] " + JSON.stringify(fields));
}

// ---------------------------------------------------------------------------
// Claim and load

export type KnownDraft = {
  id: string;
  shopifyOrderId: string | null;
  shopify: unknown;
  draftSnapshot: unknown;
  draftDeletedAt: number | null;
};

// The same claim-then-read rule as claimAndLoad (run.ts), keyed by
// shopify_draft_id: stamp this run's now on the rows (forward only), then
// read them. One claim UPDATE plus one SELECT per chunk.
export async function claimAndLoadDrafts(
  db: Db,
  workspaceId: string,
  draftIds: readonly string[],
  now: number,
  into: Map<string, KnownDraft>,
): Promise<void> {
  for (let i = 0; i < draftIds.length; i += EXISTENCE_CHUNK) {
    const chunk = draftIds.slice(i, i + EXISTENCE_CHUNK);
    const inChunk = and(eq(orders.workspaceId, workspaceId), inArray(orders.shopifyDraftId, chunk));
    await db.update(orders).set({ syncedAt: now }).where(and(inChunk, lt(orders.syncedAt, now)));
    const found = await db
      .select({
        id: orders.id,
        shopifyDraftId: orders.shopifyDraftId,
        shopifyOrderId: orders.shopifyOrderId,
        shopify: orders.shopify,
        draftSnapshot: orders.draftSnapshot,
        draftDeletedAt: orders.draftDeletedAt,
      })
      .from(orders)
      .where(inChunk);
    for (const row of found) {
      if (row.shopifyDraftId !== null) {
        into.set(row.shopifyDraftId, {
          id: row.id,
          shopifyOrderId: row.shopifyOrderId,
          shopify: row.shopify,
          draftSnapshot: row.draftSnapshot,
          draftDeletedAt: row.draftDeletedAt,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attach and merge (sections 6.1 and 6.4)

export type AttachInput = {
  draftRowId: string;
  // The legacy id and name of the order the draft became.
  orderId: string;
  orderName: string | null;
  // The completed draft, when the signal carries it (a draft update, the
  // approve response); it becomes both draft_snapshot and, until the order
  // snapshot is written, shopify. Without it the stored draft snapshot is
  // kept as both.
  completedDraft?: NormalizedDraft;
  now: number;
  // app with the actor when approved in the desk; shopify otherwise.
  source: "app" | "shopify";
  actorId?: string | null;
};

export type AttachResult =
  // The row now carries the order. before: the stored snapshot (the open
  // draft); after: the row's snapshot now (the completed draft, the stored
  // draft, or after a merge the orphan's order snapshot). event: the
  // draft_completed entry (inserted unless an entry with its id existed).
  | {
      kind: "attached";
      orderRowId: string;
      before: unknown;
      after: unknown;
      event: EventView;
      merged?: OrderMerge;
    }
  // Another signal attached the same order first.
  | { kind: "already"; orderRowId: string }
  // The row carries a different order (should not happen; ids are logged).
  | { kind: "other"; orderRowId: string }
  | { kind: "missing" }
  // A merge could not complete because the orphan changed meanwhile;
  // nothing was written and the next signal retries.
  | { kind: "retry" };

export type DraftRow = {
  id: string;
  shopifyOrderId: string | null;
  shopifyDraftId: string | null;
  draftName: string | null;
  name: string;
  shopify: unknown;
};

export async function readCard(db: Db, workspaceId: string, rowId: string): Promise<DraftRow | undefined> {
  const found = await db
    .select({
      id: orders.id,
      shopifyOrderId: orders.shopifyOrderId,
      shopifyDraftId: orders.shopifyDraftId,
      draftName: orders.draftName,
      name: orders.name,
      shopify: orders.shopify,
    })
    .from(orders)
    .where(and(eq(orders.id, rowId), eq(orders.workspaceId, workspaceId)))
    .limit(1);
  return found[0];
}

export function completedEvent(workspaceId: string, row: DraftRow, input: AttachInput, orderName: string) {
  const draftName = row.draftName ?? row.name;
  return {
    id: `evt-draft-order-${workspaceId}-${row.shopifyDraftId ?? row.id}`,
    workspaceId,
    orderId: row.id,
    type: "draft_completed" as const,
    text: `Order ${orderName} created from draft ${draftName}`,
    actorId: input.source === "app" ? (input.actorId ?? null) : null,
    meta: { orderName, draftName, shopifyOrderId: input.orderId },
    createdAt: input.now,
    source: input.source,
  };
}

// The draft_completed entry as an insert-select that yields its row only
// when the card now carries the order, ignoring an entry whose id exists
// (whichever signal attached first wrote it). Values in the events table's
// column order.
export function insertCompletedEvent(db: Db, event: ReturnType<typeof completedEvent>) {
  const attached = sql`exists (select 1 from ${orders} where ${orders.id} = ${event.orderId} and ${orders.shopifyOrderId} = ${event.meta.shopifyOrderId})`;
  return db
    .insert(events)
    .select(
      sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${attached}`,
    )
    .onConflictDoNothing();
}

// Links the draft card to the order it became (one batch: the
// compare-and-set and its timeline entry). The claim stamp only moves
// forward (max(synced_at, now)); attach is not guarded on synced_at because
// it records a fact, and a newer run's draft write is then refused by its
// own shopify_order_id IS NULL guard. If another row already carries the
// order, it is merged into the card.
export async function attachOrderToDraft(db: Db, workspaceId: string, input: AttachInput): Promise<AttachResult> {
  const row = await readCard(db, workspaceId, input.draftRowId);
  if (!row) {
    return { kind: "missing" };
  }
  if (row.shopifyOrderId !== null) {
    if (row.shopifyOrderId === input.orderId) {
      return { kind: "already", orderRowId: row.id };
    }
    logIds({ workspaceId, orderRowId: row.id, attach: "other order" });
    return { kind: "other", orderRowId: row.id };
  }
  const orderName = input.orderName ?? row.name;
  const event = completedEvent(workspaceId, row, input, orderName);
  const snapshot = input.completedDraft ?? sql`${orders.shopify}`;
  let update: unknown;
  try {
    [update] = await applyBatch(db, [
      db
        .update(orders)
        .set({
          shopifyOrderId: input.orderId,
          name: orderName,
          // Every right-hand side sees the row as it was: draft_snapshot
          // takes the stored shopify when no completed draft came with the
          // signal.
          draftSnapshot: snapshot,
          shopify: snapshot,
          syncedAt: sql`max(${orders.syncedAt}, ${input.now})`,
        })
        .where(and(eq(orders.id, row.id), eq(orders.workspaceId, workspaceId), isNull(orders.shopifyOrderId))),
      insertCompletedEvent(db, event),
    ]);
  } catch (e) {
    if (!isOrderIdTaken(e)) {
      throw e;
    }
    return mergeOrderIntoDraft(db, workspaceId, input);
  }
  if (changesOf(update) === 1) {
    return {
      kind: "attached",
      orderRowId: row.id,
      before: row.shopify,
      after: input.completedDraft ?? row.shopify,
      event: eventView(event),
    };
  }
  const fresh = await readCard(db, workspaceId, row.id);
  if (!fresh) {
    return { kind: "missing" };
  }
  if (fresh.shopifyOrderId === input.orderId) {
    return { kind: "already", orderRowId: fresh.id };
  }
  logIds({ workspaceId, orderRowId: fresh.id, attach: "other order" });
  return { kind: "other", orderRowId: fresh.id };
}

// Folds the orphan O (the row carrying the order id with no draft id) into
// the draft card D, in one batch, in this order: O's "New order" entry goes
// (D has its request entry); O's events and purchase orders are re-pointed
// to D; D takes O's snapshot, O's notified_at when D has none, and the
// later claim stamp; O is deleted; D takes the order id, the order name
// and its draft snapshot; the draft_completed entry. If O changed in
// between, the delete matches nothing and the order id update trips
// order_unique, so the whole batch rolls back (D1 batches are atomic) and
// the result is retry. D keeps its status; the completion move then applies
// (before = D's draft snapshot, after = O's order snapshot).
export async function mergeOrderIntoDraft(db: Db, workspaceId: string, input: AttachInput): Promise<AttachResult> {
  const draft = await readCard(db, workspaceId, input.draftRowId);
  if (!draft) {
    return { kind: "missing" };
  }
  if (draft.shopifyOrderId !== null) {
    return draft.shopifyOrderId === input.orderId
      ? { kind: "already", orderRowId: draft.id }
      : { kind: "other", orderRowId: draft.id };
  }
  const orphans = await db
    .select({ id: orders.id, shopify: orders.shopify })
    .from(orders)
    .where(
      and(eq(orders.workspaceId, workspaceId), eq(orders.shopifyOrderId, input.orderId), isNull(orders.shopifyDraftId)),
    )
    .limit(1);
  const orphan = orphans[0];
  if (!orphan) {
    // The row holding the order id is another draft card (or it just went):
    // nothing to fold in safely.
    logIds({ workspaceId, orderRowId: draft.id, merge: "no orphan" });
    return { kind: "retry" };
  }
  const orderName = input.orderName ?? draft.name;
  const event = completedEvent(workspaceId, draft, input, orderName);
  const draftJson = input.completedDraft ?? draft.shopify;
  let results: unknown[];
  try {
    results = await applyBatch(db, [
      db
        .delete(events)
        .where(and(eq(events.workspaceId, workspaceId), eq(events.id, `evt-order-new-${workspaceId}-${input.orderId}`))),
      db.update(events).set({ orderId: draft.id }).where(and(eq(events.workspaceId, workspaceId), eq(events.orderId, orphan.id))),
      db
        .update(purchaseOrders)
        .set({ orderId: draft.id })
        .where(and(eq(purchaseOrders.workspaceId, workspaceId), eq(purchaseOrders.orderId, orphan.id))),
      db
        .update(orders)
        .set({
          shopify: sql`(select o2.shopify from orders o2 where o2.id = ${orphan.id})`,
          notifiedAt: sql`coalesce(notified_at, (select o2.notified_at from orders o2 where o2.id = ${orphan.id}))`,
          syncedAt: sql`max(synced_at, coalesce((select o2.synced_at from orders o2 where o2.id = ${orphan.id}), 0), ${input.now})`,
        })
        .where(and(eq(orders.id, draft.id), isNull(orders.shopifyOrderId))),
      db
        .delete(orders)
        .where(
          and(
            eq(orders.id, orphan.id),
            eq(orders.workspaceId, workspaceId),
            eq(orders.shopifyOrderId, input.orderId),
            isNull(orders.shopifyDraftId),
          ),
        ),
      db
        .update(orders)
        .set({ shopifyOrderId: input.orderId, name: orderName, draftSnapshot: draftJson })
        .where(and(eq(orders.id, draft.id), isNull(orders.shopifyOrderId))),
      insertCompletedEvent(db, event),
    ]);
  } catch (e) {
    if (isOrderIdTaken(e)) {
      logIds({ workspaceId, orderRowId: draft.id, merge: "orphan changed" });
      return { kind: "retry" };
    }
    throw e;
  }
  if (changesOf(results[5]) !== 1) {
    const fresh = await readCard(db, workspaceId, draft.id);
    return fresh?.shopifyOrderId === input.orderId ? { kind: "already", orderRowId: draft.id } : { kind: "retry" };
  }
  return {
    kind: "attached",
    orderRowId: draft.id,
    before: draft.shopify,
    after: orphan.shopify,
    event: eventView(event),
    merged: { fromId: orphan.id, toId: draft.id },
  };
}

// ---------------------------------------------------------------------------
// Deletion (section 6.3)

// Marks the open draft card whose draft Shopify no longer has, with a
// timeline entry, in one batch. Attached cards are ignored (deleting a
// completed draft does not delete its order), as are unknown drafts and
// cards already marked. The status does not change; the card is kept.
export async function markDraftDeleted(
  db: Db,
  workspaceId: string,
  draftId: string,
  now: number,
): Promise<{ kind: "deleted"; orderId: string; event: EventView } | { kind: "none" }> {
  const found = await db
    .select({
      id: orders.id,
      shopifyOrderId: orders.shopifyOrderId,
      draftName: orders.draftName,
      name: orders.name,
      draftDeletedAt: orders.draftDeletedAt,
    })
    .from(orders)
    .where(and(eq(orders.workspaceId, workspaceId), eq(orders.shopifyDraftId, draftId)))
    .limit(1);
  const row = found[0];
  if (!row || row.shopifyOrderId !== null || row.draftDeletedAt !== null) {
    return { kind: "none" };
  }
  const event = {
    id: `evt-draft-deleted-${workspaceId}-${draftId}`,
    workspaceId,
    orderId: row.id,
    type: "draft_deleted" as const,
    text: `Draft ${row.draftName ?? row.name} was deleted in Shopify. This card and its history are kept.`,
    actorId: null,
    meta: { draftName: row.draftName ?? row.name },
    createdAt: now,
    source: "shopify" as const,
  };
  const marked = sql`exists (select 1 from ${orders} where ${orders.id} = ${row.id} and ${orders.draftDeletedAt} = ${now})`;
  const [update] = await applyBatch(db, [
    db
      .update(orders)
      .set({ draftDeletedAt: now })
      .where(
        and(
          eq(orders.id, row.id),
          eq(orders.workspaceId, workspaceId),
          eq(orders.shopifyDraftId, draftId),
          isNull(orders.shopifyOrderId),
          isNull(orders.draftDeletedAt),
        ),
      ),
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${marked}`,
      )
      .onConflictDoNothing(),
  ]);
  if (changesOf(update) !== 1) {
    return { kind: "none" };
  }
  return { kind: "deleted", orderId: row.id, event: eventView(event) };
}

// ---------------------------------------------------------------------------
// One fetched draft (section 5.3)

export type DraftWriteOutcome =
  | { kind: "added"; orderId: string }
  // An open draft's snapshot changed (or a card marked deleted came back).
  | { kind: "updated"; orderId: string; before: unknown; after: unknown }
  | {
      kind: "attached";
      orderId: string;
      before: unknown;
      after: unknown;
      shopifyOrderId: string;
      event: EventView;
      merged?: OrderMerge;
    }
  // A completed draft first seen after its order was stored: the draft
  // fields were written onto the order's card.
  | { kind: "backfilled"; orderId: string }
  | { kind: "none" };

export type DraftWriteOptions = {
  // The first draft sync (decision D12): those requests were already
  // waiting in Shopify, so they are inserted with notified_at set and never
  // announced.
  silent?: boolean;
  // Rows by Shopify order id, claimed and loaded, for the backfill case.
  knownOrders?: Map<string, KnownOrder>;
};

async function insertDraftCard(
  db: Db,
  workspaceId: string,
  draft: NormalizedDraft,
  now: number,
  statusRows: readonly StatusRow[],
  silent: boolean,
): Promise<{ inserted: boolean; orderId: string }> {
  const orderId = crypto.randomUUID();
  const insertRow = db
    .insert(orders)
    .values({
      id: orderId,
      workspaceId,
      shopifyOrderId: null,
      name: draft.name,
      shopify: draft,
      statusKey: initialStatusFor(draft, statusRows, statusRows[0]?.key ?? "new"),
      createdAt: draft.createdAt || now,
      syncedAt: now,
      ...(silent ? { notifiedAt: now } : {}),
      shopifyDraftId: draft.shopifyDraftId,
      draftName: draft.name,
    })
    .onConflictDoNothing();
  const insertEvent = db
    .insert(events)
    .values({
      id: `evt-draft-new-${workspaceId}-${draft.shopifyDraftId}`,
      workspaceId,
      orderId,
      type: "order_new",
      text: `New request ${draft.name}${draft.customerName ? " from " + draft.customerName : ""}`,
      // silent: already waiting when draft sync turned on (decision D12);
      // the bell leaves these out like imported orders.
      meta: silent ? { orderName: draft.name, kind: "draft", silent: true } : { orderName: draft.name, kind: "draft" },
      createdAt: now,
      source: "shopify",
    })
    .onConflictDoNothing();
  const [result] = await applyBatch(db, [insertRow, insertEvent]);
  return { inserted: changesOf(result) === 1, orderId };
}

// Writes one fetched draft under the one-row and claim rules:
// | Row state          | Draft            | Action                                   |
// | none               | open, invoiced   | insert the card and its request entry    |
// | none               | completed        | backfill the order's card, else skip     |
// | open card          | open, invoiced   | refresh the snapshot when it changed     |
// | open card          | completed        | attach with the completed snapshot       |
// | attached card      | any              | refresh draft_snapshot only              |
// `known` is the claimed map; it is kept current. Outcomes are rows-affected
// truth.
export async function writeDraftSnapshot(
  db: Db,
  workspaceId: string,
  draft: NormalizedDraft,
  now: number,
  statusRows: readonly StatusRow[],
  known: Map<string, KnownDraft>,
  opts?: DraftWriteOptions,
): Promise<DraftWriteOutcome> {
  let existing = known.get(draft.shopifyDraftId);

  if (!existing) {
    if (draft.status === "completed") {
      return backfillDraft(db, workspaceId, draft, opts?.knownOrders);
    }
    const { inserted, orderId } = await insertDraftCard(db, workspaceId, draft, now, statusRows, opts?.silent === true);
    if (inserted) {
      known.set(draft.shopifyDraftId, {
        id: orderId,
        shopifyOrderId: null,
        shopify: draft,
        draftSnapshot: null,
        draftDeletedAt: null,
      });
      return { kind: "added", orderId };
    }
    // Another run stored it first: claim, load and treat it as known.
    await claimAndLoadDrafts(db, workspaceId, [draft.shopifyDraftId], now, known);
    existing = known.get(draft.shopifyDraftId);
    if (!existing) {
      return { kind: "none" };
    }
  }

  if (existing.shopifyOrderId !== null) {
    // Attached: the order snapshot owns shopify.
    if (JSON.stringify(existing.draftSnapshot) === JSON.stringify(draft)) {
      return { kind: "none" };
    }
    const result = await db
      .update(orders)
      .set({ draftSnapshot: draft })
      .where(and(eq(orders.id, existing.id), isNotNull(orders.shopifyOrderId), lte(orders.syncedAt, now)));
    if (changesOf(result) === 1) {
      known.set(draft.shopifyDraftId, { ...existing, draftSnapshot: draft });
    }
    return { kind: "none" };
  }

  if (draft.status === "completed" && draft.orderId !== null) {
    const attached = await attachOrderToDraft(db, workspaceId, {
      draftRowId: existing.id,
      orderId: draft.orderId,
      orderName: draft.orderName,
      completedDraft: draft,
      now,
      source: "shopify",
    });
    if (attached.kind === "attached") {
      known.set(draft.shopifyDraftId, {
        ...existing,
        shopifyOrderId: draft.orderId,
        shopify: attached.after,
        draftSnapshot: draft,
      });
      return {
        kind: "attached",
        orderId: attached.orderRowId,
        before: attached.before,
        after: attached.after,
        shopifyOrderId: draft.orderId,
        event: attached.event,
        ...(attached.merged ? { merged: attached.merged } : {}),
      };
    }
    return { kind: "none" };
  }

  const changed = JSON.stringify(existing.shopify) !== JSON.stringify(draft);
  const revived = existing.draftDeletedAt !== null;
  if (!changed && !revived) {
    return { kind: "none" };
  }
  // Snapshot only (the team's status fields are never touched here), and
  // never once the card is attached. A card marked deleted that Shopify
  // answers for again loses the mark.
  const result = await db
    .update(orders)
    .set({ shopify: draft, syncedAt: now, ...(revived ? { draftDeletedAt: null } : {}) })
    .where(and(eq(orders.id, existing.id), lte(orders.syncedAt, now), isNull(orders.shopifyOrderId)));
  if (changesOf(result) !== 1) {
    return { kind: "none" };
  }
  known.set(draft.shopifyDraftId, { ...existing, shopify: draft, draftDeletedAt: null });
  return { kind: "updated", orderId: existing.id, before: existing.shopify, after: draft };
}

// A completed draft whose card was never stored: if its order's card exists
// and names no draft yet, the draft fields are written onto it; otherwise it
// is skipped (the order path makes its card and announces it once).
async function backfillDraft(
  db: Db,
  workspaceId: string,
  draft: NormalizedDraft,
  knownOrders: Map<string, KnownOrder> | undefined,
): Promise<DraftWriteOutcome> {
  const order = draft.orderId !== null ? knownOrders?.get(draft.orderId) : undefined;
  if (!order || draft.orderId === null) {
    return { kind: "none" };
  }
  try {
    const result = await db
      .update(orders)
      .set({ shopifyDraftId: draft.shopifyDraftId, draftName: draft.name, draftSnapshot: draft })
      .where(
        and(
          eq(orders.id, order.id),
          eq(orders.workspaceId, workspaceId),
          eq(orders.shopifyOrderId, draft.orderId),
          isNull(orders.shopifyDraftId),
        ),
      );
    return changesOf(result) === 1 ? { kind: "backfilled", orderId: order.id } : { kind: "none" };
  } catch (e) {
    if (isDraftIdTaken(e)) {
      return { kind: "none" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Link lookups: the parent lookup (6.2) and the hourly check (6.6)

export type LinkOutcome = {
  kind: "ok";
  // Cards that got their order id.
  attachedRowIds: string[];
  // Cards newly marked deleted, with their timeline entries.
  deleted: { orderId: string; event: EventView }[];
  mergedOrders: OrderMerge[];
  // Snapshot changes the attaches made (merges: the draft snapshot to the
  // orphan's order snapshot), for the Shopify -> app status rules.
  transitions: SnapshotTransition[];
};

type Candidate = { id: string; shopifyDraftId: string; shopify: unknown };

const emptyLinks = (): LinkOutcome => ({
  kind: "ok",
  attachedRowIds: [],
  deleted: [],
  mergedOrders: [],
  transitions: [],
});

async function applyLinks(
  db: Db,
  workspaceId: string,
  candidates: readonly Candidate[],
  access: ShopifyAccess,
  now: number,
  onAttached?: (candidate: Candidate, orderId: string, after: unknown) => void,
): Promise<LinkOutcome | { kind: "failed"; detail: string }> {
  if (candidates.length === 0) {
    return emptyLinks();
  }
  const links = await fetchDraftLinks(
    access.shopDomain,
    access.token,
    candidates.map((candidate) => candidate.shopifyDraftId),
    access.fetchImpl,
  );
  if (links.kind !== "ok") {
    return { kind: "failed", detail: failureText(links) };
  }
  const outcome = emptyLinks();
  for (const candidate of candidates) {
    const link = links.links.get(candidate.shopifyDraftId);
    if (link?.kind === "gone") {
      const marked = await markDraftDeleted(db, workspaceId, candidate.shopifyDraftId, now);
      if (marked.kind === "deleted") {
        outcome.deleted.push({ orderId: marked.orderId, event: marked.event });
      }
    } else if (link?.kind === "completed" && link.orderId !== null) {
      const attached = await attachOrderToDraft(db, workspaceId, {
        draftRowId: candidate.id,
        orderId: link.orderId,
        orderName: link.orderName,
        now,
        source: "shopify",
      });
      if (attached.kind === "attached") {
        outcome.attachedRowIds.push(attached.orderRowId);
        if (attached.merged) {
          outcome.mergedOrders.push(attached.merged);
          outcome.transitions.push({ orderId: attached.orderRowId, before: attached.before, after: attached.after });
        }
        onAttached?.(candidate, link.orderId, attached.after);
      } else if (attached.kind === "already" && onAttached) {
        // Another signal attached the card since it was read as a candidate
        // (orders/create and orders/updated arrive together on completion,
        // and Approve or the draft webhook may attach meanwhile). The order
        // still belongs on the card: hand over its snapshot as it is now, so
        // the order is written as an update and never inserted as new.
        const card = await readCard(db, workspaceId, attached.orderRowId);
        if (card && card.shopifyOrderId === link.orderId) {
          onAttached(candidate, link.orderId, card.shopify);
        }
      }
    }
  }
  return outcome;
}

// Orders with no card yet may come from an open draft card whose
// completion the desk has not seen: before they are inserted, the newest
// open, not deleted draft cards created no later than the newest of them
// (at most DRAFT_LINK_MAX_CANDIDATES) are looked up live in Shopify. A card
// completed as one of these orders is attached, and `known` gets the order
// pointing at the card (with its stored draft snapshot), so the order is
// written onto it as an update. A card completed as another order is
// attached too (ensureOrderSnapshots loads that order), and a card whose
// draft is gone is marked deleted.
export async function lookupDraftParents(
  db: Db,
  workspaceId: string,
  unknownOrders: readonly NormalizedOrder[],
  known: Map<string, KnownOrder>,
  access: ShopifyAccess,
  now: number,
): Promise<LinkOutcome | { kind: "failed"; detail: string }> {
  if (unknownOrders.length === 0) {
    return emptyLinks();
  }
  const newest = Math.max(...unknownOrders.map((order) => order.createdAt));
  const found = await db
    .select({ id: orders.id, shopifyDraftId: orders.shopifyDraftId, shopify: orders.shopify })
    .from(orders)
    .where(
      and(
        eq(orders.workspaceId, workspaceId),
        isNull(orders.shopifyOrderId),
        isNull(orders.draftDeletedAt),
        lte(orders.createdAt, newest > 0 ? newest : now),
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(DRAFT_LINK_MAX_CANDIDATES);
  const candidates = found.filter((row): row is Candidate => row.shopifyDraftId !== null);
  const unknownIds = new Set(unknownOrders.map((order) => order.shopifyOrderId));
  const outcome = await applyLinks(db, workspaceId, candidates, access, now, (candidate, orderId, after) => {
    if (unknownIds.has(orderId)) {
      known.set(orderId, { id: candidate.id, shopify: after });
    }
  });
  if (outcome.kind === "ok") {
    // A merge deleted the orphan: entries pointing at it now mean the card.
    for (const merge of outcome.mergedOrders) {
      for (const [orderId, entry] of known) {
        if (entry.id === merge.fromId) {
          const card = await readCard(db, workspaceId, merge.toId);
          known.set(orderId, { id: merge.toId, shopify: card?.shopify ?? entry.shopify });
        }
      }
    }
  }
  return outcome;
}

// The hourly check: every open, not deleted draft card (newest first, up to
// DRAFT_CHECK_MAX) is looked up live. Gone drafts are marked deleted
// (catching deletions the window cannot see, and Shopify's one-year purge,
// which may send no webhook); completions whose signals were all missed are
// attached.
export async function checkOpenDrafts(
  db: Db,
  workspaceId: string,
  access: ShopifyAccess,
  now: number,
): Promise<LinkOutcome | { kind: "failed"; detail: string }> {
  const found = await db
    .select({ id: orders.id, shopifyDraftId: orders.shopifyDraftId, shopify: orders.shopify })
    .from(orders)
    .where(and(eq(orders.workspaceId, workspaceId), isNull(orders.shopifyOrderId), isNull(orders.draftDeletedAt)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(DRAFT_CHECK_MAX);
  const candidates = found.filter((row): row is Candidate => row.shopifyDraftId !== null);
  return applyLinks(db, workspaceId, candidates, access, now);
}

// ---------------------------------------------------------------------------
// Order snapshots for attached cards (section 6.5)

// Cards attached this run whose snapshot is still the draft (no completed
// order snapshot was written yet): fetch each order and write it through
// upsertFetchedOrder (an update of the card, never a new order), at most
// ENSURE_ORDER_MAX per run. Failures are logged and left for the next run's
// window.
export async function ensureOrderSnapshots(
  db: Db,
  workspaceId: string,
  rowIds: readonly string[],
  access: ShopifyAccess,
  now: number,
): Promise<{ updatedOrderIds: string[]; statusChanges: StatusChange[] }> {
  const updatedOrderIds: string[] = [];
  const statusChanges: StatusChange[] = [];
  const ids = [...new Set(rowIds)];
  const due: { id: string; shopifyOrderId: string }[] = [];
  for (let i = 0; i < ids.length && due.length < ENSURE_ORDER_MAX; i += EXISTENCE_CHUNK) {
    const found = await db
      .select({ id: orders.id, shopifyOrderId: orders.shopifyOrderId, shopify: orders.shopify })
      .from(orders)
      .where(and(eq(orders.workspaceId, workspaceId), inArray(orders.id, ids.slice(i, i + EXISTENCE_CHUNK))));
    for (const row of found) {
      if (row.shopifyOrderId !== null && snapshotKind(row.shopify) === "draft" && due.length < ENSURE_ORDER_MAX) {
        due.push({ id: row.id, shopifyOrderId: row.shopifyOrderId });
      }
    }
  }
  for (const row of due) {
    const fetched = await fetchOrderNode(
      access.shopDomain,
      access.token,
      `gid://shopify/Order/${row.shopifyOrderId}`,
      access.fetchImpl,
      // Only reached after a draft read, and every draft read names the B2B
      // company (DRAFT_FIELDS), which already needs read_companies.
      { companies: true },
    );
    if (fetched.kind !== "ok") {
      logIds({ workspaceId, orderRowId: row.id, ensure: failureText(fetched).slice(0, 200) });
      continue;
    }
    const [order] = fetched.node ? normalizeOrders([fetched.node]) : [];
    if (!order) {
      continue;
    }
    const outcome = await upsertFetchedOrder(db, workspaceId, order, now);
    if (outcome.kind === "updated" || outcome.kind === "attached") {
      updatedOrderIds.push(outcome.orderId);
      statusChanges.push(...outcome.statusChanges);
    }
  }
  return { updatedOrderIds, statusChanges };
}

// ---------------------------------------------------------------------------
// The drafts phase of a sync run (section 5.2)

export type DraftPhaseContext = {
  db: Db;
  workspaceId: string;
  now: number;
  access: ShopifyAccess;
  connection: Pick<
    typeof storeConnections.$inferSelect,
    "draftSyncCursor" | "draftSyncCursorSince" | "draftLastSyncAt" | "draftCheckedAt"
  >;
  statusRows: readonly StatusRow[];
  // Whether the run still holds its lease (run.ts holdsLease).
  holdsLease: () => Promise<boolean>;
};

export type DraftPhaseResult =
  | { kind: "auth" }
  | { kind: "superseded" }
  | {
      kind: "done";
      // A drafts feed failure in Shopify's words; the orders phase still runs.
      error: string | null;
      // Shopify will repeat it (one sync_error event per text per hour).
      fatal: boolean;
      // The draft cursor fields for the run's fenced terminal write.
      terminal: ConnectionWrite;
      addedOrderIds: string[];
      updatedOrderIds: string[];
      transitions: SnapshotTransition[];
      // Cards attached this phase (ensureOrderSnapshots loads their orders).
      attachedRowIds: string[];
      mergedOrders: OrderMerge[];
    };

export async function runDraftPhase(ctx: DraftPhaseContext): Promise<DraftPhaseResult> {
  const { db, workspaceId, now, access, connection } = ctx;
  // The window, mirroring the orders rules. draftLastSyncAt stays 0 until
  // the first chain completes, so a resumed first chain keeps the search its
  // cursor belongs to.
  const first = connection.draftLastSyncAt === 0;
  const resume = parseResumeToken(connection.draftSyncCursor);
  const resumeSince = connection.draftSyncCursorSince;
  const resuming = resume !== null && typeof resumeSince === "number";
  const sinceMs = resuming ? resumeSince : first ? 0 : Math.max(connection.draftLastSyncAt - OVERLAP_MS, 0);

  const fetched = await fetchDraftsUpdatedSince(
    access.shopDomain,
    access.token,
    first ? null : new Date(sinceMs).toISOString(),
    access.fetchImpl,
    resuming ? { startCursor: resume.cursor } : undefined,
  );
  const done = (fields: Partial<Extract<DraftPhaseResult, { kind: "done" }>>): DraftPhaseResult => ({
    kind: "done",
    error: null,
    fatal: false,
    terminal: {},
    addedOrderIds: [],
    updatedOrderIds: [],
    transitions: [],
    attachedRowIds: [],
    mergedOrders: [],
    ...fields,
  });
  if (fetched.kind === "auth") {
    return { kind: "auth" };
  }
  if (fetched.kind === "transient") {
    // The draft cursor and anchor stay as they are; the next run retries.
    return done({ error: fetched.detail });
  }
  if (fetched.kind === "fatal") {
    // Shopify cursors go stale: a fatal while resuming drops the chain.
    return done({
      error: fetched.detail,
      fatal: true,
      terminal: resuming ? { draftSyncCursor: null, draftSyncCursorSince: null } : {},
    });
  }
  if (!(await ctx.holdsLease())) {
    return { kind: "superseded" };
  }

  const drafts = normalizeDrafts(fetched.nodes);
  const known = new Map<string, KnownDraft>();
  const ids = drafts.map((draft) => draft.shopifyDraftId);
  for (let i = 0; i < ids.length; i += EXISTENCE_CHUNK) {
    if (i > 0 && !(await ctx.holdsLease())) {
      return { kind: "superseded" };
    }
    await claimAndLoadDrafts(db, workspaceId, ids.slice(i, i + EXISTENCE_CHUNK), now, known);
  }
  // Completed drafts with no card: their orders' cards, for the backfill.
  const knownOrders = new Map<string, KnownOrder>();
  const orphanOrderIds = drafts
    .filter((draft) => draft.status === "completed" && draft.orderId !== null && !known.has(draft.shopifyDraftId))
    .map((draft) => draft.orderId as string);
  for (let i = 0; i < orphanOrderIds.length; i += EXISTENCE_CHUNK) {
    await claimAndLoad(db, workspaceId, orphanOrderIds.slice(i, i + EXISTENCE_CHUNK), now, knownOrders);
  }
  if (ids.length > 0 && !(await ctx.holdsLease())) {
    return { kind: "superseded" };
  }

  const added: string[] = [];
  const updated = new Set<string>();
  const transitions: SnapshotTransition[] = [];
  const attachedRowIds: string[] = [];
  const mergedOrders: OrderMerge[] = [];
  for (const draft of drafts) {
    const outcome = await writeDraftSnapshot(db, workspaceId, draft, now, ctx.statusRows, known, {
      silent: first,
      knownOrders,
    });
    switch (outcome.kind) {
      case "added":
        added.push(outcome.orderId);
        break;
      case "updated":
        updated.add(outcome.orderId);
        transitions.push({ orderId: outcome.orderId, before: outcome.before, after: outcome.after });
        break;
      case "attached":
        updated.add(outcome.orderId);
        attachedRowIds.push(outcome.orderId);
        transitions.push({ orderId: outcome.orderId, before: outcome.before, after: outcome.after });
        if (outcome.merged) {
          mergedOrders.push(outcome.merged);
        }
        break;
      case "backfilled":
        updated.add(outcome.orderId);
        break;
      case "none":
        break;
    }
  }

  // The hourly check of every open draft card.
  let checkedAt: number | null = null;
  if (now - connection.draftCheckedAt >= DRAFT_CHECK_EVERY_MS && (await ctx.holdsLease())) {
    const checked = await checkOpenDrafts(db, workspaceId, access, now);
    if (checked.kind === "ok") {
      checkedAt = now;
      for (const id of checked.attachedRowIds) {
        updated.add(id);
        attachedRowIds.push(id);
      }
      for (const entry of checked.deleted) {
        updated.add(entry.orderId);
      }
      mergedOrders.push(...checked.mergedOrders);
      transitions.push(...checked.transitions);
    } else {
      logIds({ workspaceId, check: checked.detail.slice(0, 200) });
    }
  }

  // When the window was opened, exactly as for orders (see runSync).
  const chainOpenedAt = resuming && resume.openedAt !== null && resume.openedAt <= now ? resume.openedAt : null;
  const windowOpenedAt = resuming ? (chainOpenedAt ?? connection.draftLastSyncAt) : now;
  const terminal: ConnectionWrite = fetched.truncated
    ? { draftSyncCursor: resumeToken(windowOpenedAt, fetched.endCursor), draftSyncCursorSince: sinceMs }
    : {
        draftLastSyncAt: resuming ? Math.max(connection.draftLastSyncAt, windowOpenedAt) : now,
        draftSyncCursor: null,
        draftSyncCursorSince: null,
      };
  if (checkedAt !== null) {
    terminal.draftCheckedAt = checkedAt;
  }
  const addedSet = new Set(added);
  return done({
    terminal,
    addedOrderIds: added,
    updatedOrderIds: [...updated].filter((id) => !addedSet.has(id)),
    transitions,
    attachedRowIds,
    mergedOrders,
  });
}

// ---------------------------------------------------------------------------
// The webhook path (section 5.4)

// One draft outside a sync run (a webhook re-fetched it): claim, load and
// write it through writeDraftSnapshot, then apply the Shopify -> app status
// rules to a change that landed. `now` must be taken before the draft was
// fetched, like a run's now. silent: insert a new card without announcing
// it (a draft that was already waiting before the first draft sync).
export async function upsertFetchedDraft(
  db: Db,
  workspaceId: string,
  draft: NormalizedDraft,
  now: number,
  opts?: { silent?: boolean },
): Promise<
  | { kind: "added"; orderId: string }
  | { kind: "updated"; orderId: string; statusChanges: StatusChange[] }
  | {
      kind: "attached";
      orderId: string;
      orderGid: string;
      statusChanges: StatusChange[];
      event: EventView;
      merged?: OrderMerge;
    }
  | { kind: "unchanged" }
> {
  const statusRows = await loadStatusRows(db, workspaceId);
  const known = new Map<string, KnownDraft>();
  await claimAndLoadDrafts(db, workspaceId, [draft.shopifyDraftId], now, known);
  const knownOrders = new Map<string, KnownOrder>();
  if (draft.status === "completed" && draft.orderId !== null && !known.has(draft.shopifyDraftId)) {
    await claimAndLoad(db, workspaceId, [draft.orderId], now, knownOrders);
  }
  const outcome = await writeDraftSnapshot(db, workspaceId, draft, now, statusRows, known, {
    silent: opts?.silent === true,
    knownOrders,
  });
  switch (outcome.kind) {
    case "added":
      return { kind: "added", orderId: outcome.orderId };
    case "backfilled":
      return { kind: "updated", orderId: outcome.orderId, statusChanges: [] };
    case "updated":
      return {
        kind: "updated",
        orderId: outcome.orderId,
        statusChanges: await evaluateShopifyTransitions(
          db,
          workspaceId,
          [{ orderId: outcome.orderId, before: outcome.before, after: outcome.after }],
          now,
        ),
      };
    case "attached":
      return {
        kind: "attached",
        orderId: outcome.orderId,
        orderGid: `gid://shopify/Order/${outcome.shopifyOrderId}`,
        statusChanges: await evaluateShopifyTransitions(
          db,
          workspaceId,
          [{ orderId: outcome.orderId, before: outcome.before, after: outcome.after }],
          now,
        ),
        event: outcome.event,
        ...(outcome.merged ? { merged: outcome.merged } : {}),
      };
    case "none":
      return { kind: "unchanged" };
  }
}
