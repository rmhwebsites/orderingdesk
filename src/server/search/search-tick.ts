// The cron's search work for one workspace (design section 3), after its
// sync, roster and history import:
// 1. Backfill, until workspace_settings.search_indexed_at is set: the next
//    BACKFILL_ROWS cards by (created_at, id) after the stored cursor are
//    indexed. Cards whose snapshot predates customer ids get their
//    requester from Shopify first (one read per 50 cards). A busy Shopify
//    keeps the cursor where it is; a store that cannot be read is skipped
//    (those cards index without a requester). A batch shorter than
//    BACKFILL_ROWS ends the pass and stamps the workspace.
// 2. Repair, every tick once the backfill is done: up to REPAIR_ROWS cards
//    whose search row is missing or disagrees with orders and statuses on a
//    filter column are indexed again, and rows whose card is gone are
//    deleted.
// 3. Verify, every tick after the repair: the next VERIFY_ROWS cards by
//    (created_at, id) are indexed again with onlyChanged, so a haystack or
//    requester a writer missed (a swallowed index error, a webhook resend
//    that upserts as unchanged, two indexers racing) is rewritten within one
//    pass over the workspace. The position lives in search_backfill_cursor,
//    which the backfill no longer needs; past the newest card it wraps to
//    null and starts over.
// Relative imports only (cron bundle). Logs carry counts, never text.

import { and, asc, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { rowsAffected } from "../../db/batch";
import { orderSearch, orders, statuses, workspaceSettings } from "../../db/schema";
import { fetchRequesterIds } from "../shopify/admin";
import { getAccessToken } from "../shopify/token";
import { requesterOf } from "./haystack";
import { indexOrders, type RequesterHint } from "./index-orders";

export const BACKFILL_ROWS = 200;
export const REPAIR_ROWS = 200;
// Cards verified per tick: at a tick every 10 minutes, 7,200 cards a day.
export const VERIFY_ROWS = 50;

export type SearchTickResult = {
  backfilled: number;
  repaired: number;
  removed: number;
  finished?: boolean;
  skipped?: "no-settings" | "shopify-busy";
};

export type SearchTickOptions = { fetchImpl?: typeof fetch; now?: () => number };

const CURSOR = /^(\d{1,15})~([A-Za-z0-9_-]{1,64})$/;

export function backfillCursor(createdAt: number, id: string): string {
  return `${createdAt}~${id}`;
}

export function parseBackfillCursor(value: string | null): { createdAt: number; id: string } | null {
  const match = value?.match(CURSOR);
  return match ? { createdAt: Number(match[1]), id: match[2] } : null;
}

type BackfillCard = {
  id: string;
  createdAt: number;
  shopifyOrderId: string | null;
  shopifyDraftId: string | null;
  shopify: unknown;
  draftSnapshot: unknown;
};

function gidOf(card: BackfillCard): string | null {
  if (card.shopifyOrderId !== null) {
    return `gid://shopify/Order/${card.shopifyOrderId}`;
  }
  return card.shopifyDraftId !== null ? `gid://shopify/DraftOrder/${card.shopifyDraftId}` : null;
}

async function requesterHints(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  cards: readonly BackfillCard[],
  opts: SearchTickOptions | undefined,
): Promise<Map<string, RequesterHint> | "busy"> {
  const wanted = new Map<string, string>();
  for (const card of cards) {
    const gid = gidOf(card);
    if (gid && requesterOf(card.shopify, card.draftSnapshot).customerId === "") {
      wanted.set(gid, card.id);
    }
  }
  if (wanted.size === 0) {
    return new Map();
  }
  const token = await getAccessToken(db, env, workspaceId, { fetchImpl: opts?.fetchImpl, now: opts?.now });
  if (token.kind === "transient") {
    return "busy";
  }
  if (token.kind !== "ok") {
    console.log("[search] " + JSON.stringify({ workspaceId, requesters: "store unavailable", cards: wanted.size }));
    return new Map();
  }
  const fetched = await fetchRequesterIds(token.shopDomain, token.token, [...wanted.keys()], opts?.fetchImpl ?? fetch);
  if (fetched.kind === "transient") {
    return "busy";
  }
  if (fetched.kind !== "ok") {
    console.log("[search] " + JSON.stringify({ workspaceId, requesters: fetched.kind, cards: wanted.size }));
    return new Map();
  }
  const hints = new Map<string, RequesterHint>();
  for (const [gid, ids] of fetched.ids) {
    const cardId = wanted.get(gid);
    if (cardId) {
      hints.set(cardId, ids);
    }
  }
  return hints;
}

// Cards after a (created_at, id) cursor, oldest first.
function afterCursor(cursor: string | null) {
  const after = parseBackfillCursor(cursor);
  return after
    ? or(gt(orders.createdAt, after.createdAt), and(eq(orders.createdAt, after.createdAt), gt(orders.id, after.id)))
    : undefined;
}

async function backfillStep(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  cursor: string | null,
  now: number,
  opts: SearchTickOptions | undefined,
): Promise<SearchTickResult> {
  const cards: BackfillCard[] = await db
    .select({
      id: orders.id,
      createdAt: orders.createdAt,
      shopifyOrderId: orders.shopifyOrderId,
      shopifyDraftId: orders.shopifyDraftId,
      shopify: orders.shopify,
      draftSnapshot: orders.draftSnapshot,
    })
    .from(orders)
    .where(and(eq(orders.workspaceId, workspaceId), afterCursor(cursor)))
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(BACKFILL_ROWS);
  const hints = await requesterHints(db, env, workspaceId, cards, opts);
  if (hints === "busy") {
    return { backfilled: 0, repaired: 0, removed: 0, skipped: "shopify-busy" };
  }
  const indexed = cards.length > 0 ? await indexOrders(db, workspaceId, cards.map((card) => card.id), { requesters: hints }) : { indexed: 0 };
  const finished = cards.length < BACKFILL_ROWS;
  const last = cards[cards.length - 1];
  await db
    .update(workspaceSettings)
    .set(
      finished
        ? { searchIndexedAt: now, searchBackfillCursor: null }
        : { searchBackfillCursor: backfillCursor(last.createdAt, last.id) },
    )
    .where(and(eq(workspaceSettings.workspaceId, workspaceId), isNull(workspaceSettings.searchIndexedAt)));
  return { backfilled: indexed.indexed, repaired: 0, removed: 0, ...(finished ? { finished: true } : {}) };
}

async function verifyStep(db: Db, workspaceId: string, cursor: string | null): Promise<number> {
  const cards = await db
    .select({ id: orders.id, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.workspaceId, workspaceId), afterCursor(cursor)))
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(VERIFY_ROWS);
  const rewritten =
    cards.length > 0 ? (await indexOrders(db, workspaceId, cards.map((card) => card.id), { onlyChanged: true })).indexed : 0;
  const last = cards[cards.length - 1];
  const next = cards.length < VERIFY_ROWS ? null : backfillCursor(last.createdAt, last.id);
  if (next !== cursor) {
    await db
      .update(workspaceSettings)
      .set({ searchBackfillCursor: next })
      .where(and(eq(workspaceSettings.workspaceId, workspaceId), isNotNull(workspaceSettings.searchIndexedAt)));
  }
  return rewritten;
}

async function repairStep(db: Db, workspaceId: string, cursor: string | null): Promise<SearchTickResult> {
  const kindNow = sql`case when ${orders.shopifyOrderId} is null then 'draft' else 'order' end`;
  const closedNow = sql`coalesce(${statuses.closed}, 0)`;
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .leftJoin(orderSearch, eq(orderSearch.orderId, orders.id))
    .leftJoin(statuses, and(eq(statuses.workspaceId, orders.workspaceId), eq(statuses.key, orders.statusKey)))
    .where(
      and(
        eq(orders.workspaceId, workspaceId),
        or(
          isNull(orderSearch.orderId),
          ne(orderSearch.statusKey, orders.statusKey),
          sql`${orderSearch.statusSetAt} is not ${orders.statusSetAt}`,
          sql`${orderSearch.kind} <> ${kindNow}`,
          sql`${orderSearch.locationId} is not ${orders.locationId}`,
          sql`${orderSearch.closed} <> ${closedNow}`,
          ne(orderSearch.createdAt, orders.createdAt),
        ),
      ),
    )
    .limit(REPAIR_ROWS);
  const repaired = stale.length > 0 ? (await indexOrders(db, workspaceId, stale.map((row) => row.id))).indexed : 0;
  const orphans = await db
    .delete(orderSearch)
    .where(
      and(
        eq(orderSearch.workspaceId, workspaceId),
        sql.raw("not exists (select 1 from orders o where o.id = order_search.order_id)"),
      ),
    );
  const verified = await verifyStep(db, workspaceId, cursor);
  return { backfilled: 0, repaired: repaired + verified, removed: rowsAffected(orphans, "search") };
}

export async function runSearchTick(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  opts?: SearchTickOptions,
): Promise<SearchTickResult> {
  const now = opts?.now?.() ?? Date.now();
  const rows = await db
    .select({ indexedAt: workspaceSettings.searchIndexedAt, cursor: workspaceSettings.searchBackfillCursor })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const settings = rows[0];
  if (!settings) {
    return { backfilled: 0, repaired: 0, removed: 0, skipped: "no-settings" };
  }
  if (settings.indexedAt === null) {
    return backfillStep(db, env, workspaceId, settings.cursor, now, opts);
  }
  return repairStep(db, workspaceId, settings.cursor);
}
