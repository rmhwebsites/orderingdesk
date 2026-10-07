// Company locations and what ships there (design section 3, location
// pages), keyed by the Shopify location id that orders.location_id holds
// (Wave 1b). Team members only; callers guard first and pass the workspace
// id from the session. Card lists are the desk's own server search narrowed
// to the location; the address is Wave 1b's JSON, shown by AddressBlock.

import { and, asc, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { locations, orderSearch, orders, people, statuses } from "@/db/schema";
import type { LocationAddress } from "@/lib/address";
import { EMPTY_QUERY } from "@/lib/desk-query";
import { orderSummaryOf, type OrderSummary } from "@/server/desk/read";
import { statusView, type StatusView } from "@/server/desk/shapes";
import { searchOrders } from "@/server/search/query";
import { itemTotals, ITEMS_WINDOW_MS, type ItemTotal } from "./items";
import { displayName, workspaceTimeZone } from "./people";

export const LOCATIONS_LIST_MAX = 200;
export const LOCATION_OPEN_MAX = 100;
export const LOCATION_ORDERS_MAX = 50;
export const LOCATION_TOP_ITEMS = 10;
export const LOCATION_PEOPLE_MAX = 20;

const closedNow = sql`coalesce(${statuses.closed}, 0)`;
const linkNow = sql`coalesce(${statuses.shopifyLink}, '')`;
// Shopify reports the order cancelled, wherever its card sits (see people.ts).
const shopifyCancelled = sql`coalesce(json_type(${orders.shopify}, '$.cancelledAt') in ('integer', 'real') and json_extract(${orders.shopify}, '$.cancelledAt') > 0, 0)`;
const notDeletedDraft = sql`not (${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is not null)`;
const statusJoin = and(eq(statuses.workspaceId, orders.workspaceId), eq(statuses.key, orders.statusKey));

export type LocationSummaryRow = {
  // The Shopify location id.
  id: string;
  name: string;
  active: boolean;
  openCount: number;
  cardCount: number;
};

export async function listLocationSummaries(db: Db, workspaceId: string): Promise<LocationSummaryRow[]> {
  const [rows, counts] = await Promise.all([
    db
      .select({ id: locations.shopifyLocationId, name: locations.name, active: locations.active })
      .from(locations)
      .where(eq(locations.workspaceId, workspaceId))
      .orderBy(desc(locations.active), asc(locations.name))
      .limit(LOCATIONS_LIST_MAX),
    db
      .select({ locationId: orders.locationId, cards: count(), open: sql<number>`sum(case when ${closedNow} = 0 then 1 else 0 end)` })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .where(and(eq(orders.workspaceId, workspaceId), isNotNull(orders.locationId), notDeletedDraft))
      .groupBy(orders.locationId),
  ]);
  const byLocation = new Map(counts.map((row) => [row.locationId, row]));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: Boolean(row.active),
    openCount: Number(byLocation.get(row.id)?.open ?? 0),
    cardCount: Number(byLocation.get(row.id)?.cards ?? 0),
  }));
}

export type LocationPage = {
  location: { id: string; name: string; address: LocationAddress | null; active: boolean };
  openCards: OrderSummary[];
  openCount: number;
  // Every order card for the location, any status, newest first.
  orders: OrderSummary[];
  ordersCount: number;
  topItems: ItemTotal[];
  // name is the display name; storedName is people.name as stored (see
  // PersonListRow in ./people).
  people: { id: string; name: string; storedName: string | null; cards: number }[];
  statuses: StatusView[];
  timeZone: string;
};

export async function getLocationPage(db: Db, workspaceId: string, shopifyLocationId: string, now: number): Promise<LocationPage | null> {
  const found = await db
    .select({ id: locations.shopifyLocationId, name: locations.name, address: locations.address, active: locations.active })
    .from(locations)
    .where(and(eq(locations.workspaceId, workspaceId), eq(locations.shopifyLocationId, shopifyLocationId)))
    .limit(1);
  const location = found[0];
  if (!location) {
    return null;
  }
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const here = and(eq(orders.workspaceId, workspaceId), eq(orders.locationId, shopifyLocationId));
  const ctx = { now, timeZone };
  const [open, everyOrder, recent, who, statusRows] = await Promise.all([
    searchOrders(db, workspaceId, { ...EMPTY_QUERY, view: "open", locations: [shopifyLocationId] }, { ...ctx, limit: LOCATION_OPEN_MAX }),
    searchOrders(db, workspaceId, { ...EMPTY_QUERY, view: "all", kind: "orders", locations: [shopifyLocationId] }, { ...ctx, limit: LOCATION_ORDERS_MAX }),
    db
      .select({ shopify: orders.shopify })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .where(and(here, gte(orders.createdAt, now - ITEMS_WINDOW_MS), notDeletedDraft, sql`${linkNow} not in ('draft_rejected', 'cancelled') and not ${shopifyCancelled}`)),
    db
      .select({ id: people.id, name: people.name, email: people.email, cards: count() })
      .from(orders)
      .innerJoin(orderSearch, eq(orderSearch.orderId, orders.id))
      .innerJoin(people, eq(people.id, orderSearch.requesterId))
      .where(and(here, notDeletedDraft))
      .groupBy(people.id, people.name, people.email)
      .orderBy(desc(count()), asc(people.name))
      .limit(LOCATION_PEOPLE_MAX),
    db.select().from(statuses).where(eq(statuses.workspaceId, workspaceId)).orderBy(asc(statuses.sort), asc(statuses.key)),
  ]);
  const summaries = (page: typeof open) => page.orders.map((entry) => orderSummaryOf(entry.row, entry.locationName, entry.requesterId, entry.hasPo));
  return {
    location: { id: location.id, name: location.name, address: location.address ?? null, active: Boolean(location.active) },
    openCards: summaries(open),
    openCount: open.total,
    orders: summaries(everyOrder),
    ordersCount: everyOrder.total,
    topItems: itemTotals(recent.map((entry) => entry.shopify), LOCATION_TOP_ITEMS),
    people: who.map((entry) => ({ id: entry.id, name: displayName(entry.name, entry.email), storedName: entry.name, cards: Number(entry.cards) })),
    statuses: statusRows.map(statusView),
    timeZone,
  };
}
