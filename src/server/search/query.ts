// The desk list from the server (design section 3): every filter in the URL
// (src/lib/desk-query.ts) as bound parameters, scoped to the workspace the
// route's guard resolved from the session. Filters read the live orders and
// statuses rows, so a status change or a closed flag edited in Settings
// counts at once and a card is listed before the index has it; words read
// order_search.haystack with LIKE (% and _ escaped) and the person filter
// reads order_search.requester_id. Plain words search every card, open and
// closed, whatever view is picked (owner decision, listScope). No FTS5: D1
// cannot export databases with virtual tables. Keyset pages reach any depth
// of history. At most about 50 bound parameters (20 locations, 8 words),
// inside D1's 100. Each row comes with its synced location name (locations
// joined on the Shopify location id that orders.location_id holds, as Wave
// 1b's list does) and whether it has a purchase order.

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db";
import { locations, orderSearch, orders, purchaseOrders, statuses } from "../../db/schema";
import { customRange, presetRange } from "../../lib/date-range";
import { DESK_PAGE_MAX, DESK_PAGE_SIZE, listScope, type DeskQuery } from "../../lib/desk-query";
import { normalizeSearchText } from "./haystack";

export const QUERY_WORDS_MAX = 8;
const DAY_MS = 86400000;

// A request still waiting for a manager: a draft that Shopify has not
// deleted, in an open status that is not the one linked to draft_rejected
// (a rejected request never waits, whether or not its status is closed).
// The one fragment for the approval view, its count in every view's sizes
// and the top bar's badge (src/server/desk/read.ts); the desk applies the
// same rule (src/lib/desk-state.ts viewMatches). Needs the statuses join.
export const awaitingApproval = sql`(${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is null and coalesce(${statuses.closed}, 0) = 0 and coalesce(${statuses.shopifyLink}, '') <> 'draft_rejected')`;

// Whether a card has any purchase order (one indexed lookup per card).
export const hasPurchaseOrder = sql<number>`exists (select 1 from ${purchaseOrders} where ${purchaseOrders.orderId} = ${orders.id} and ${purchaseOrders.workspaceId} = ${orders.workspaceId})`;

export function likePattern(text: string): string {
  return "%" + text.replace(/[\\%_]/g, (char) => "\\" + char) + "%";
}

function contains(text: string): SQL {
  return sql`${orderSearch.haystack} like ${likePattern(normalizeSearchText(text))} escape '\\'`;
}

export type SearchContext = { now: number; timeZone: string };

export function searchConditions(workspaceId: string, query: DeskQuery, ctx: SearchContext): SQL[] {
  const closed = sql`coalesce(${statuses.closed}, 0)`;
  const isDraft = isNull(orders.shopifyOrderId);
  const deletedDraft = sql`(${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is not null)`;
  const conditions: SQL[] = [eq(orders.workspaceId, workspaceId)];
  const scope = listScope(query);
  switch (scope.view) {
    case "open":
      conditions.push(sql`${closed} = 0`);
      break;
    case "closed":
      conditions.push(sql`${closed} = 1`);
      break;
    case "approval":
      conditions.push(awaitingApproval);
      break;
    case "all":
      break;
  }
  switch (scope.kind) {
    case "all":
      conditions.push(sql`not ${deletedDraft}`);
      break;
    case "drafts":
      conditions.push(isDraft, isNull(orders.draftDeletedAt));
      break;
    case "orders":
      conditions.push(isNotNull(orders.shopifyOrderId));
      break;
    case "deleted":
      conditions.push(deletedDraft);
      break;
  }
  if (query.status) {
    conditions.push(eq(orders.statusKey, query.status));
  }
  if (query.locations.length > 0) {
    conditions.push(inArray(orders.locationId, query.locations));
  }
  if (query.requester) {
    conditions.push(eq(orderSearch.requesterId, query.requester));
  }
  const words = normalizeSearchText(query.q).split(" ").filter((word) => word.length > 0).slice(0, QUERY_WORDS_MAX);
  for (const word of words) {
    conditions.push(contains(word));
  }
  for (const text of [query.person, query.item, query.pz]) {
    if (text) {
      conditions.push(contains(text));
    }
  }
  if (query.number) {
    conditions.push(
      or(sql`lower(${orders.name}) = ${query.number}`, sql`lower(coalesce(${orders.draftName}, '')) = ${query.number}`)!,
    );
  }
  const range =
    query.from && query.to
      ? customRange(query.from, query.to, ctx.timeZone)
      : query.date
        ? presetRange(query.date, ctx.now, ctx.timeZone)
        : null;
  if (range) {
    conditions.push(sql`${orders.createdAt} >= ${range.from}`, sql`${orders.createdAt} < ${range.to}`);
  }
  const waitingSince = sql`coalesce(${orders.statusSetAt}, ${orders.createdAt})`;
  if (query.older !== null) {
    conditions.push(sql`${waitingSince} <= ${ctx.now - query.older * DAY_MS}`);
  }
  if (query.newer !== null) {
    conditions.push(sql`${waitingSince} > ${ctx.now - query.newer * DAY_MS}`);
  }
  return conditions;
}

function sortOf(query: DeskQuery): { value: SQL; dir: "asc" | "desc" } {
  switch (query.sort) {
    case "oldest":
      return { value: sql`${orders.createdAt}`, dir: "asc" };
    case "waiting":
      return { value: sql`coalesce(${orders.statusSetAt}, ${orders.createdAt})`, dir: "asc" };
    default:
      return { value: sql`${orders.createdAt}`, dir: "desc" };
  }
}

function sortValueOf(query: DeskQuery, row: typeof orders.$inferSelect): number {
  return query.sort === "waiting" ? (row.statusSetAt ?? row.createdAt) : row.createdAt;
}

const CURSOR = /^(-?\d{1,15})~([A-Za-z0-9_-]{1,64})$/;

export function encodeCursor(value: number, id: string): string {
  return `${value}~${id}`;
}

export function decodeCursor(cursor: string | null | undefined): { value: number; id: string } | null {
  const match = cursor?.match(CURSOR);
  return match ? { value: Number(match[1]), id: match[2] } : null;
}

export type SearchPage = {
  orders: { row: typeof orders.$inferSelect; requesterId: string | null; locationName: string | null; hasPo: boolean }[];
  // Where the next page starts, or null on the last page.
  nextCursor: string | null;
  // Cards matching the filter, over all history.
  total: number;
};

export async function searchOrders(
  db: Db,
  workspaceId: string,
  query: DeskQuery,
  opts: SearchContext & { limit?: number; cursor?: string | null },
): Promise<SearchPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DESK_PAGE_SIZE), 1), DESK_PAGE_MAX);
  const conditions = searchConditions(workspaceId, query, opts);
  const sort = sortOf(query);
  const after = decodeCursor(opts.cursor);
  const paged = after
    ? [
        ...conditions,
        sort.dir === "desc"
          ? sql`(${sort.value} < ${after.value} or (${sort.value} = ${after.value} and ${orders.id} < ${after.id}))`
          : sql`(${sort.value} > ${after.value} or (${sort.value} = ${after.value} and ${orders.id} > ${after.id}))`,
      ]
    : conditions;
  const statusJoin = and(eq(statuses.workspaceId, orders.workspaceId), eq(statuses.key, orders.statusKey));
  const [rows, totals] = await Promise.all([
    db
      .select({ row: orders, requesterId: orderSearch.requesterId, locationName: locations.name, hasPo: hasPurchaseOrder })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .leftJoin(orderSearch, eq(orderSearch.orderId, orders.id))
      .leftJoin(locations, and(eq(locations.workspaceId, orders.workspaceId), eq(locations.shopifyLocationId, orders.locationId)))
      .where(and(...paged))
      .orderBy(sort.dir === "desc" ? desc(sort.value) : asc(sort.value), sort.dir === "desc" ? desc(orders.id) : asc(orders.id))
      .limit(limit + 1),
    db
      .select({ total: count() })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .leftJoin(orderSearch, eq(orderSearch.orderId, orders.id))
      .where(and(...conditions)),
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    orders: page.map((entry) => ({
      row: entry.row,
      requesterId: entry.requesterId ?? null,
      locationName: entry.locationName ?? null,
      hasPo: Boolean(entry.hasPo),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(sortValueOf(query, last.row), last.row.id) : null,
    total: Number(totals[0]?.total ?? 0),
  };
}
