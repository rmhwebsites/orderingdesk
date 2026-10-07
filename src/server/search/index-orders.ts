// Keeps order_search and people current (design section 3). Every writer of
// an orders row calls safeIndexOrders after its write commits (Tasks 5 and
// 6 of the Wave 1c plan list them); the cron's search tick
// (search-tick.ts) backfills and repairs whatever a writer missed. The
// desk list reads its filters from orders itself, so a missed index call
// only delays words and the person filter. Relative imports only: the sync
// engine (cron bundle) imports this.

import { and, eq, inArray, notLike, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { applyBatch } from "../../db/batch";
import { locations, orderSearch, orders, people, purchaseOrders, statuses } from "../../db/schema";
import { requesterOf, searchRowOf, type CardRow, type SearchRow } from "./haystack";

// 50 ids plus the workspace id per IN list: inside D1's 100 bound
// parameters per statement.
export const INDEX_CHUNK = 50;

// A requester found outside the snapshot (the search backfill asks Shopify
// for cards stored before snapshots kept customer ids).
export type RequesterHint = { customerId: string; contactId: string };
export type IndexOptions = { requesters?: ReadonlyMap<string, RequesterHint> };
// missing: ids that are not cards of this workspace (their search rows, if
// any, are deleted).
export type IndexResult = { indexed: number; missing: number };

type PersonFacts = {
  name: string;
  email: string;
  contactId: string;
  locationId: string | null;
  first: number;
  last: number;
};

function personFacts(cards: readonly CardRow[], hints: IndexOptions["requesters"]) {
  const byCustomer = new Map<string, PersonFacts>();
  const customerOf = new Map<string, string>();
  for (const card of cards) {
    const requester = requesterOf(card.shopify, card.draftSnapshot);
    const hint = hints?.get(card.id);
    const customerId = requester.customerId || hint?.customerId || "";
    if (customerId.length === 0) {
      continue;
    }
    customerOf.set(card.id, customerId);
    const contactId = requester.contactId || hint?.contactId || "";
    const known = byCustomer.get(customerId);
    if (!known) {
      byCustomer.set(customerId, {
        name: requester.name,
        email: requester.email,
        contactId,
        locationId: card.locationId,
        first: card.createdAt,
        last: card.createdAt,
      });
      continue;
    }
    const newer = card.createdAt >= known.last;
    byCustomer.set(customerId, {
      name: newer && requester.name ? requester.name : known.name || requester.name,
      email: newer && requester.email ? requester.email : known.email || requester.email,
      contactId: newer && contactId ? contactId : known.contactId || contactId,
      locationId: newer && card.locationId ? card.locationId : (known.locationId ?? card.locationId),
      first: Math.min(known.first, card.createdAt),
      last: Math.max(known.last, card.createdAt),
    });
  }
  return { byCustomer, customerOf };
}

// One upsert per customer. The newest card a person is seen on decides
// their name, email, contact and home location; an older card indexed
// later only widens first_seen_at. SQLite evaluates every SET expression
// against the stored row, so "newer" compares with the old last_seen_at.
async function upsertPeople(
  db: Db,
  workspaceId: string,
  cards: readonly CardRow[],
  hints: IndexOptions["requesters"],
): Promise<Map<string, string>> {
  const { byCustomer, customerOf } = personFacts(cards, hints);
  const entries = [...byCustomer.entries()];
  if (entries.length === 0) {
    return new Map();
  }
  const newer = sql`excluded.last_seen_at >= ${people.lastSeenAt}`;
  const results = await applyBatch(
    db,
    entries.map(([customerId, facts]) =>
      db
        .insert(people)
        .values({
          id: crypto.randomUUID(),
          workspaceId,
          shopifyCustomerId: customerId,
          name: facts.name || null,
          email: facts.email || null,
          companyContactId: facts.contactId || null,
          locationId: facts.locationId,
          firstSeenAt: facts.first,
          lastSeenAt: facts.last,
        })
        .onConflictDoUpdate({
          target: [people.workspaceId, people.shopifyCustomerId],
          set: {
            name: sql`case when ${newer} and excluded.name is not null then excluded.name else ${people.name} end`,
            email: sql`case when ${newer} and excluded.email is not null then excluded.email else ${people.email} end`,
            companyContactId: sql`case when ${newer} and excluded.company_contact_id is not null then excluded.company_contact_id else ${people.companyContactId} end`,
            locationId: sql`case when ${newer} and excluded.location_id is not null then excluded.location_id else ${people.locationId} end`,
            firstSeenAt: sql`min(${people.firstSeenAt}, excluded.first_seen_at)`,
            lastSeenAt: sql`max(${people.lastSeenAt}, excluded.last_seen_at)`,
          },
        })
        .returning({ id: people.id }),
    ),
  );
  const personOf = new Map<string, string>();
  entries.forEach(([customerId], index) => {
    const rows = results[index] as { id: string }[] | undefined;
    if (rows?.[0]) {
      personOf.set(customerId, rows[0].id);
    }
  });
  const byCard = new Map<string, string>();
  for (const [cardId, customerId] of customerOf) {
    const personId = personOf.get(customerId);
    if (personId) {
      byCard.set(cardId, personId);
    }
  }
  return byCard;
}

function upsertSearchRow(db: Db, row: SearchRow) {
  return db
    .insert(orderSearch)
    .values(row)
    .onConflictDoUpdate({
      target: orderSearch.orderId,
      set: {
        haystack: row.haystack,
        kind: row.kind,
        statusKey: row.statusKey,
        closed: row.closed,
        locationId: row.locationId,
        // A snapshot stored before requester ids has none: keep the one the
        // search backfill found.
        requesterId: sql`coalesce(excluded.requester_id, ${orderSearch.requesterId})`,
        createdAt: row.createdAt,
        statusSetAt: row.statusSetAt,
      },
    });
}

export async function indexOrders(
  db: Db,
  workspaceId: string,
  orderIds: readonly string[],
  opts?: IndexOptions,
): Promise<IndexResult> {
  const ids = [...new Set(orderIds)].filter((id) => id.length > 0);
  const result: IndexResult = { indexed: 0, missing: 0 };
  if (ids.length === 0) {
    return result;
  }
  const statusRows = await db
    .select({ key: statuses.key, closed: statuses.closed })
    .from(statuses)
    .where(eq(statuses.workspaceId, workspaceId));
  const closedByKey = new Map(statusRows.map((row) => [row.key, Boolean(row.closed)]));

  for (let i = 0; i < ids.length; i += INDEX_CHUNK) {
    const chunk = ids.slice(i, i + INDEX_CHUNK);
    const cards: CardRow[] = await db
      .select({
        id: orders.id,
        workspaceId: orders.workspaceId,
        shopifyOrderId: orders.shopifyOrderId,
        name: orders.name,
        shopify: orders.shopify,
        statusKey: orders.statusKey,
        statusSetAt: orders.statusSetAt,
        createdAt: orders.createdAt,
        draftName: orders.draftName,
        draftSnapshot: orders.draftSnapshot,
        locationId: orders.locationId,
      })
      .from(orders)
      .where(and(eq(orders.workspaceId, workspaceId), inArray(orders.id, chunk)));
    const found = new Set(cards.map((card) => card.id));
    const missing = chunk.filter((id) => !found.has(id));
    if (missing.length > 0) {
      await db.delete(orderSearch).where(and(eq(orderSearch.workspaceId, workspaceId), inArray(orderSearch.orderId, missing)));
      result.missing += missing.length;
    }
    if (cards.length === 0) {
      continue;
    }
    const locationIds = [...new Set(cards.map((card) => card.locationId).filter((id): id is string => id !== null))];
    const [locationRows, poRows] = await Promise.all([
      locationIds.length > 0
        ? db
            .select({ id: locations.shopifyLocationId, name: locations.name })
            .from(locations)
            .where(and(eq(locations.workspaceId, workspaceId), inArray(locations.shopifyLocationId, locationIds)))
        : Promise.resolve([] as { id: string; name: string }[]),
      db
        .select({ orderId: purchaseOrders.orderId, poNumber: purchaseOrders.poNumber })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.workspaceId, workspaceId),
            inArray(purchaseOrders.orderId, [...found]),
            // Unsent drafts carry a "draft:<id>" placeholder, not a number.
            notLike(purchaseOrders.poNumber, "draft:%"),
          ),
        ),
    ]);
    const locationName = new Map(locationRows.map((row) => [row.id, row.name]));
    const poNumbers = new Map<string, string[]>();
    for (const row of poRows) {
      poNumbers.set(row.orderId, [...(poNumbers.get(row.orderId) ?? []), row.poNumber]);
    }
    const requesterIds = await upsertPeople(db, workspaceId, cards, opts?.requesters);
    const rows = cards.map((card) =>
      searchRowOf(card, {
        closed: closedByKey.get(card.statusKey) ?? false,
        locationName: card.locationId ? (locationName.get(card.locationId) ?? null) : null,
        poNumbers: poNumbers.get(card.id) ?? [],
        requesterId: requesterIds.get(card.id) ?? null,
      }),
    );
    await applyBatch(db, rows.map((row) => upsertSearchRow(db, row)));
    result.indexed += rows.length;
  }
  return result;
}

// What every writer calls after its own write committed: an index failure
// never fails the write. The search tick repairs what this missed.
export async function safeIndexOrders(
  db: Db,
  workspaceId: string,
  orderIds: readonly string[],
  opts?: IndexOptions,
): Promise<void> {
  if (orderIds.length === 0) {
    return;
  }
  try {
    await indexOrders(db, workspaceId, orderIds, opts);
  } catch (e) {
    console.warn(
      "[search] " + JSON.stringify({ workspaceId, cards: orderIds.length, index: e instanceof Error ? e.name : "failed" }),
    );
  }
}

// The cards a sync pass touched: inserted, updated, moved by the Shopify
// status rules, and both sides of a merge (the folded card is gone, so its
// search row is dropped by indexOrders).
export function syncedOrderIds(result: {
  addedOrderIds: readonly string[];
  updatedOrderIds: readonly string[];
  statusChanges?: readonly { order: { id: string } }[];
  mergedOrders?: readonly { fromId: string; toId: string }[];
}): string[] {
  return [
    ...new Set([
      ...result.addedOrderIds,
      ...result.updatedOrderIds,
      ...(result.statusChanges ?? []).map((change) => change.order.id),
      ...(result.mergedOrders ?? []).flatMap((merge) => [merge.fromId, merge.toId]),
    ]),
  ];
}

// After a statuses save (Settings can flip a closed flag): every search row
// takes its status's closed flag again, for the save's own batch. Only rows
// whose flag differs are written. Raw identifiers on purpose: the
// correlated subquery must name order_search, not whatever drizzle would
// render for a column inside an UPDATE.
export function closedFlagsStatement(db: Db, workspaceId: string) {
  const closedNow = sql.raw(
    "coalesce((select s.closed from statuses s where s.workspace_id = order_search.workspace_id and s.key = order_search.status_key), 0)",
  );
  return db
    .update(orderSearch)
    .set({ closed: closedNow })
    .where(and(eq(orderSearch.workspaceId, workspaceId), sql`${orderSearch.closed} <> ${closedNow}`));
}

// A company location was renamed (Wave 1b's locations sync): its name is in
// the haystack of every card shipping there. Keyed by the Shopify location
// id, the value orders.location_id holds.
export async function reindexLocation(db: Db, workspaceId: string, shopifyLocationId: string): Promise<void> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.workspaceId, workspaceId), eq(orders.locationId, shopifyLocationId)));
  await safeIndexOrders(db, workspaceId, rows.map((row) => row.id));
}
