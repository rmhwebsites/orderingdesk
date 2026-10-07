// People and their cards (design section 3, employee pages): the people
// table, joined to cards through order_search.requester_id. Team members
// only; callers guard first and pass the workspace id from the session.
// Counts read the live statuses, like the desk; the card list is the desk's
// own server search narrowed to the person.

import { and, asc, count, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { locations, orderSearch, orders, people, statuses, workspaceSettings } from "@/db/schema";
import { DEFAULT_TIME_ZONE, isTimeZone } from "@/lib/date-range";
import { EMPTY_QUERY } from "@/lib/desk-query";
import { orderSummaryOf, type OrderSummary } from "@/server/desk/read";
import { statusView, type StatusView } from "@/server/desk/shapes";
import { normalizeSearchText } from "@/server/search/haystack";
import { likePattern, searchOrders } from "@/server/search/query";
import { itemTotals, ITEMS_WINDOW_MS, type ItemTotal } from "./items";

export const PEOPLE_LIST_MAX = 200;
export const PERSON_CARDS_MAX = 100;
export const PERSON_ITEMS_MAX = 50;

const closedNow = sql`coalesce(${statuses.closed}, 0)`;
const linkNow = sql`coalesce(${statuses.shopifyLink}, '')`;
const notDeletedDraft = sql`not (${orders.shopifyOrderId} is null and ${orders.draftDeletedAt} is not null)`;
const statusJoin = and(eq(statuses.workspaceId, orders.workspaceId), eq(statuses.key, orders.statusKey));
// people.location_id holds a Shopify location id, like orders.location_id.
const homeJoin = and(eq(locations.workspaceId, people.workspaceId), eq(locations.shopifyLocationId, people.locationId));

export function displayName(name: string | null, email: string | null): string {
  return name?.trim() || email || "Unknown person";
}

export async function workspaceTimeZone(db: Db, workspaceId: string): Promise<string> {
  const rows = await db
    .select({ timeZone: workspaceSettings.timeZone })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const zone = rows[0]?.timeZone;
  return isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

export type PersonListRow = {
  id: string;
  name: string;
  email: string | null;
  locationName: string | null;
  openCount: number;
  cardCount: number;
  lastSeenAt: number;
};

export async function listPeople(db: Db, workspaceId: string, opts: { q?: string } = {}): Promise<{ people: PersonListRow[]; total: number }> {
  const words = normalizeSearchText(opts.q ?? "").split(" ").filter((word) => word.length > 0).slice(0, 4);
  const where = and(
    eq(people.workspaceId, workspaceId),
    ...words.map(
      (word) =>
        or(
          sql`lower(coalesce(${people.name}, '')) like ${likePattern(word)} escape '\\'`,
          sql`coalesce(${people.email}, '') like ${likePattern(word)} escape '\\'`,
        )!,
    ),
  );
  const [rows, totals, counts] = await Promise.all([
    db
      .select({ id: people.id, name: people.name, email: people.email, locationName: locations.name, lastSeenAt: people.lastSeenAt })
      .from(people)
      .leftJoin(locations, homeJoin)
      .where(where)
      .orderBy(desc(people.lastSeenAt), asc(people.id))
      .limit(PEOPLE_LIST_MAX),
    db.select({ total: count() }).from(people).where(where),
    db
      .select({
        requesterId: orderSearch.requesterId,
        cards: count(),
        open: sql<number>`sum(case when ${closedNow} = 0 then 1 else 0 end)`,
      })
      .from(orderSearch)
      .innerJoin(orders, eq(orders.id, orderSearch.orderId))
      .leftJoin(statuses, statusJoin)
      .where(and(eq(orderSearch.workspaceId, workspaceId), isNotNull(orderSearch.requesterId), notDeletedDraft))
      .groupBy(orderSearch.requesterId),
  ]);
  const byPerson = new Map(counts.map((row) => [row.requesterId, row]));
  return {
    total: Number(totals[0]?.total ?? 0),
    people: rows.map((row) => ({
      id: row.id,
      name: displayName(row.name, row.email),
      email: row.email,
      locationName: row.locationName ?? null,
      openCount: Number(byPerson.get(row.id)?.open ?? 0),
      cardCount: Number(byPerson.get(row.id)?.cards ?? 0),
      lastSeenAt: row.lastSeenAt,
    })),
  };
}

export type PersonPage = {
  person: {
    id: string;
    name: string;
    email: string | null;
    // Keyed by the Shopify location id, like the location pages.
    homeLocation: { id: string; name: string } | null;
    firstSeenAt: number;
    lastSeenAt: number;
  };
  counts: { open: number; approved: number; rejected: number; cancelled: number; cards: number };
  items: ItemTotal[];
  cards: OrderSummary[];
  statuses: StatusView[];
  timeZone: string;
};

export async function getPersonPage(db: Db, workspaceId: string, personId: string, now: number): Promise<PersonPage | null> {
  const found = await db
    .select({ person: people, locationName: locations.name })
    .from(people)
    .leftJoin(locations, homeJoin)
    .where(and(eq(people.workspaceId, workspaceId), eq(people.id, personId)))
    .limit(1);
  const row = found[0];
  if (!row) {
    return null;
  }
  const timeZone = await workspaceTimeZone(db, workspaceId);
  const mine = and(eq(orderSearch.workspaceId, workspaceId), eq(orderSearch.requesterId, personId), eq(orders.workspaceId, workspaceId));
  const [countRows, page, recent, statusRows] = await Promise.all([
    db
      .select({
        open: sql<number>`sum(case when ${closedNow} = 0 and ${notDeletedDraft} then 1 else 0 end)`,
        approved: sql<number>`sum(case when ${orders.shopifyOrderId} is not null and ${linkNow} <> 'cancelled' then 1 else 0 end)`,
        rejected: sql<number>`sum(case when ${linkNow} = 'draft_rejected' then 1 else 0 end)`,
        cancelled: sql<number>`sum(case when ${linkNow} = 'cancelled' then 1 else 0 end)`,
      })
      .from(orderSearch)
      .innerJoin(orders, eq(orders.id, orderSearch.orderId))
      .leftJoin(statuses, statusJoin)
      .where(mine),
    searchOrders(db, workspaceId, { ...EMPTY_QUERY, view: "all", requester: personId }, { now, timeZone, limit: PERSON_CARDS_MAX }),
    db
      .select({ shopify: orders.shopify })
      .from(orderSearch)
      .innerJoin(orders, eq(orders.id, orderSearch.orderId))
      .leftJoin(statuses, statusJoin)
      .where(and(mine, gte(orders.createdAt, now - ITEMS_WINDOW_MS), notDeletedDraft, sql`${linkNow} not in ('draft_rejected', 'cancelled')`)),
    db.select().from(statuses).where(eq(statuses.workspaceId, workspaceId)).orderBy(asc(statuses.sort), asc(statuses.key)),
  ]);
  const counted = countRows[0];
  return {
    person: {
      id: row.person.id,
      name: displayName(row.person.name, row.person.email),
      email: row.person.email,
      homeLocation: row.person.locationId && row.locationName ? { id: row.person.locationId, name: row.locationName } : null,
      firstSeenAt: row.person.firstSeenAt,
      lastSeenAt: row.person.lastSeenAt,
    },
    counts: {
      open: Number(counted?.open ?? 0),
      approved: Number(counted?.approved ?? 0),
      rejected: Number(counted?.rejected ?? 0),
      cancelled: Number(counted?.cancelled ?? 0),
      cards: page.total,
    },
    items: itemTotals(recent.map((entry) => entry.shopify), PERSON_ITEMS_MAX),
    cards: page.orders.map((entry) => orderSummaryOf(entry.row, entry.locationName, entry.requesterId, entry.hasPo)),
    statuses: statusRows.map(statusView),
    timeZone,
  };
}
