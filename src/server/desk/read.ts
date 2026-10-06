// Read side of the desk: the one-round-trip desk payload, a single order in
// full, and the activity feed. Callers authorize first (route guards); every
// query here is still scoped to the workspace it is given.

import { and, asc, count, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { events, orders, purchaseOrders, statuses, storeConnections, user, workspaceSettings, workspaces } from "@/db/schema";
import type { DeskView, ViewCounts } from "@/lib/desk-query";
import type { QueueSettingsView } from "@/lib/queue-settings";
import { requestFieldsOf } from "@/lib/request-fields";
import { draftsEnabled, missingDraftScopes } from "@/server/shopify/admin";
import {
  eventView,
  isRecord,
  personName,
  settingsView,
  statusView,
  type EventView,
  type SettingsView,
  type StatusView,
} from "./shapes";
import { queueSettingsView } from "./queue-settings";

// The desk list carries at most this many orders, newest first; hasMore tells
// the client there are older ones it was not sent.
export const ORDER_LIST_CAP = 1000;
export const EVENT_FEED_CAP = 300;
const PREVIEW_ITEMS = 3;

export type OrderSummary = {
  id: string;
  name: string;
  statusKey: string;
  statusSetBy: string | null;
  statusSetAt: number | null;
  createdAt: number;
  syncedAt: number;
  customerName: string;
  email: string;
  total: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  itemCount: number;
  itemsPreview: string[];
  // Every non-empty item title, so a desk search covers items past the
  // preview.
  itemTitles: string[];
  // True unless the sync confirmed the stored line items are the whole order
  // (see itemsTruncated in normalize.ts). When true, itemCount, the preview
  // and itemTitles cover only the items the sync fetched.
  itemsTruncated: boolean;
  // Draft orders spec section 11.1. A draft card has no Shopify order yet.
  kind: "draft" | "order";
  // A draft's name, or the draft an order came from ("#D12").
  draftName: string | null;
  // The draft's own status: open or invoice_sent while a request,
  // completed on an order card that was one; null for other orders.
  draftStatus: "open" | "invoice_sent" | "completed" | null;
  // Shopify reported the request's draft deleted (the card is kept).
  draftDeleted: boolean;
  // Request fields (src/lib/request-fields.ts): the current snapshot, then
  // the draft snapshot an order card keeps.
  company: string;
  location: string;
  requestFor: string;
  branch: string;
  // What a desk search matches besides the name, customer, email and items.
  searchText: string[];
  // The card has at least one purchase order, of any state (an order whose
  // status triggers one says "PO not created" until it does).
  hasPo: boolean;
};

function draftStatusOf(snapshot: unknown): OrderSummary["draftStatus"] {
  const status = isRecord(snapshot) ? snapshot.status : undefined;
  return status === "invoice_sent" || status === "completed" ? status : "open";
}

// Only an explicit false counts as complete; a snapshot stored before the
// marker existed has no key and stays unconfirmed. One rule for the list
// and the order detail.
function itemsTruncatedOf(snapshot: unknown): boolean {
  return !isRecord(snapshot) || snapshot.itemsTruncated !== false;
}

export type DeskPayload = {
  workspace: { id: string; name: string; slug: string; accentColor: string };
  statuses: StatusView[];
  settings: SettingsView;
  statusCounts: Record<string, number>;
  orders: OrderSummary[];
  hasMore: boolean;
  // Requests waiting as drafts (not deleted in Shopify), over every card.
  draftCount: number;
  // Requests whose draft Shopify deleted (shown under their own filter).
  deletedDraftCount: number;
  // Whether draft orders sync for the store, from the stored grant;
  // missingScopes is empty when there is no store or the grant is unknown.
  drafts: { enabled: boolean; missingScopes: string[] };
  // The view this list is (src/lib/desk-query.ts) and every view's count.
  view: DeskView;
  viewCounts: ViewCounts;
  // Age thresholds and price display (src/server/desk/queue-settings.ts).
  queue: QueueSettingsView;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// A quantity that is not a finite number counts as 1, matching the
// normalizer's default for a line item without one.
function quantity(item: Record<string, unknown>): number {
  return typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 1;
}

// The list ships summaries only, derived from the stored snapshot; the full
// snapshot is served per order by getOrderDetail. Snapshots are read
// defensively: a malformed one degrades to empty fields instead of failing
// the whole desk.
function summarize(row: typeof orders.$inferSelect, hasPo: boolean): OrderSummary {
  const snapshot = isRecord(row.shopify) ? row.shopify : {};
  const items = Array.isArray(snapshot.items) ? snapshot.items.filter(isRecord) : [];
  const kind = row.shopifyOrderId === null ? "draft" : "order";
  const request = requestFieldsOf(row.shopify, row.draftSnapshot);
  return {
    id: row.id,
    name: row.name,
    statusKey: row.statusKey,
    statusSetBy: row.statusSetBy,
    statusSetAt: row.statusSetAt,
    createdAt: row.createdAt,
    syncedAt: row.syncedAt,
    customerName: text(snapshot.customerName),
    email: text(snapshot.email),
    total: text(snapshot.total),
    currency: text(snapshot.currency),
    financialStatus: text(snapshot.financialStatus),
    fulfillmentStatus: text(snapshot.fulfillmentStatus),
    itemCount: items.reduce((sum, item) => sum + quantity(item), 0),
    itemsPreview: items
      .slice(0, PREVIEW_ITEMS)
      .map((item) => `${quantity(item)} x ${text(item.title) || "Untitled item"}`),
    itemTitles: items.map((item) => text(item.title)).filter((title) => title.length > 0),
    itemsTruncated: itemsTruncatedOf(row.shopify),
    kind,
    draftName: row.draftName ?? null,
    draftStatus:
      kind === "draft" ? draftStatusOf(row.shopify) : row.draftSnapshot !== null || row.draftName !== null ? "completed" : null,
    draftDeleted: kind === "draft" && row.draftDeletedAt !== null,
    company: request.company,
    location: request.location,
    requestFor: request.requestFor,
    branch: request.branch,
    searchText: [row.draftName ?? "", request.company, request.location, request.requestFor, request.branch].filter(
      (part) => part.length > 0,
    ),
    hasPo,
  };
}

// A card's status row, for the closed flag (migration 0011). A key with no
// status row (one removed while cards still had it) counts as open.
const statusJoin = and(eq(statuses.workspaceId, orders.workspaceId), eq(statuses.key, orders.statusKey));
const isOpen = sql`coalesce(${statuses.closed}, 0) = 0`;
const isClosed = sql`coalesce(${statuses.closed}, 0) = 1`;
// Whether a card has any purchase order (one indexed lookup per card).
const hasPurchaseOrder = sql<number>`exists (select 1 from ${purchaseOrders} where ${purchaseOrders.orderId} = ${orders.id} and ${purchaseOrders.workspaceId} = ${orders.workspaceId})`;

// Which cards a view loads (comprehensive desk design section 1). Deleted
// requests come with Open, All and Closed; the desk's Deleted filter shows
// them. The approval queue is requests still waiting: drafts that are not
// deleted, in an open status.
function viewCondition(view: DeskView): SQL | undefined {
  switch (view) {
    case "all":
      return undefined;
    case "open":
      return isOpen;
    case "closed":
      return isClosed;
    case "approval":
      return and(isNull(orders.shopifyOrderId), isNull(orders.draftDeletedAt), isOpen);
  }
}

// Requests waiting for a manager: the approval view's size (the top bar's
// badge).
export async function countNeedsApproval(db: Db, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(orders)
    .leftJoin(statuses, statusJoin)
    .where(and(eq(orders.workspaceId, workspaceId), viewCondition("approval")));
  return Number(rows[0]?.count ?? 0);
}

export async function loadDesk(
  db: Db,
  workspaceId: string,
  opts?: { limit?: number; view?: DeskView },
): Promise<DeskPayload | null> {
  const limit = opts?.limit ?? ORDER_LIST_CAP;
  const view = opts?.view ?? "all";
  const [workspaceRows, statusRows, settingsRows, countRows, orderRows, draftRows, connectionRows, viewRows] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        accentColor: workspaces.accentColor,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1),
    db
      .select()
      .from(statuses)
      .where(eq(statuses.workspaceId, workspaceId))
      .orderBy(asc(statuses.sort), asc(statuses.key)),
    db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1),
    // Counts cover every order, not just the capped list below.
    db
      .select({ statusKey: orders.statusKey, count: count() })
      .from(orders)
      .where(eq(orders.workspaceId, workspaceId))
      .groupBy(orders.statusKey),
    // One row past the cap answers hasMore without a second count query.
    db
      .select({ order: orders, hasPo: hasPurchaseOrder })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .where(and(eq(orders.workspaceId, workspaceId), viewCondition(view)))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1),
    // Draft cards over every card, split by whether Shopify deleted them.
    db
      .select({ deleted: isNotNull(orders.draftDeletedAt), count: count() })
      .from(orders)
      .where(and(eq(orders.workspaceId, workspaceId), isNull(orders.shopifyOrderId)))
      .groupBy(isNotNull(orders.draftDeletedAt)),
    db
      .select({ scopes: storeConnections.scopes })
      .from(storeConnections)
      .where(eq(storeConnections.workspaceId, workspaceId))
      .limit(1),
    // Every view's size over every card. Deleted requests count in none.
    db
      .select({
        all: sql<number>`coalesce(sum(case when ${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is not null then 0 else 1 end), 0)`,
        closed: sql<number>`coalesce(sum(case when ${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is not null then 0 when coalesce(${statuses.closed}, 0) = 1 then 1 else 0 end), 0)`,
        approval: sql<number>`coalesce(sum(case when ${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is null and coalesce(${statuses.closed}, 0) = 0 then 1 else 0 end), 0)`,
      })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .where(eq(orders.workspaceId, workspaceId)),
  ]);

  const workspace = workspaceRows[0];
  if (!workspace) {
    return null;
  }

  // Every status gets an entry (0 when unused) so the count strip needs no
  // fallback. A key with orders but no status row (one removed while an
  // order was being assigned to it) is kept, so the totals still add up.
  const statusCounts: Record<string, number> = {};
  for (const status of statusRows) {
    statusCounts[status.key] = 0;
  }
  for (const row of countRows) {
    statusCounts[row.statusKey] = Number(row.count);
  }

  const scopes = Array.isArray(connectionRows[0]?.scopes) ? connectionRows[0].scopes : null;
  const draftsCounted = (deleted: boolean) =>
    Number(draftRows.find((row) => Boolean(row.deleted) === deleted)?.count ?? 0);
  return {
    workspace,
    statuses: statusRows.map(statusView),
    settings: settingsView(settingsRows[0]),
    statusCounts,
    orders: orderRows.slice(0, limit).map((row) => summarize(row.order, Boolean(row.hasPo))),
    hasMore: orderRows.length > limit,
    draftCount: draftsCounted(false),
    deletedDraftCount: draftsCounted(true),
    drafts: { enabled: draftsEnabled(scopes), missingScopes: scopes ? missingDraftScopes(scopes) : [] },
    view,
    viewCounts: (() => {
      const all = Number(viewRows[0]?.all ?? 0);
      const closed = Number(viewRows[0]?.closed ?? 0);
      return { open: all - closed, approval: Number(viewRows[0]?.approval ?? 0), all, closed };
    })(),
    queue: queueSettingsView(settingsRows[0]),
  };
}

export type OrderDetail = {
  // The whole row, including the full stored snapshot.
  order: typeof orders.$inferSelect;
  // Computed from the snapshot with the list's rule, so the drawer does not
  // re-implement it.
  itemsTruncated: boolean;
};

export async function getOrderDetail(
  db: Db,
  workspaceId: string,
  orderId: string,
): Promise<OrderDetail | null> {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
    .limit(1);
  const order = rows[0];
  return order ? { order, itemsTruncated: itemsTruncatedOf(order.shopify) } : null;
}

export type EventsResult = { kind: "ok"; events: EventView[] } | { kind: "not-found" };

// orderId null: the latest EVENT_FEED_CAP events of the workspace. With an
// orderId: that order's whole timeline, provided the order is in this
// workspace (not-found otherwise, so another workspace's order ids reveal
// nothing). Newest first either way; id breaks createdAt ties so the order is
// stable.
export async function listEvents(
  db: Db,
  workspaceId: string,
  orderId: string | null,
): Promise<EventsResult> {
  // Who did it, member or not (like the bell, src/server/activity.ts).
  const withActor = (row: { event: typeof events.$inferSelect; name: string | null; email: string | null }): EventView => ({
    ...eventView(row.event),
    actorName: row.event.actorId ? personName(row.name, row.email) : null,
  });
  const selection = { event: events, name: user.name, email: user.email };
  if (orderId === null) {
    const rows = await db
      .select(selection)
      .from(events)
      .leftJoin(user, eq(user.id, events.actorId))
      .where(eq(events.workspaceId, workspaceId))
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(EVENT_FEED_CAP);
    return { kind: "ok", events: rows.map(withActor) };
  }

  const order = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
    .limit(1);
  if (order.length === 0) {
    return { kind: "not-found" };
  }
  const rows = await db
    .select(selection)
    .from(events)
    .leftJoin(user, eq(user.id, events.actorId))
    .where(and(eq(events.workspaceId, workspaceId), eq(events.orderId, orderId)))
    .orderBy(desc(events.createdAt), desc(events.id));
  return { kind: "ok", events: rows.map(withActor) };
}
