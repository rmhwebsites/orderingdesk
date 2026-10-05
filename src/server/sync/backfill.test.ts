import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { STATUS_TAG_PREFIX } from "../../lib/status-label";
import { encryptSecret } from "../crypto";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace, snapshotOf } from "../desk/test-helpers";
import { loadActivityFeed } from "../activity";
import { notifyNewOrders } from "../notify";
import {
  BACKFILL_PAGES_PER_TICK,
  cancelBackfill,
  getBackfillView,
  runBackfillTick,
  startBackfill,
} from "./backfill";
import { runAllSyncs } from "./cron";
import { runSync } from "./run";

// The order history import against a real migrated SQLite database and a
// stubbed Shopify that serves a store's orders by creation date, newest
// first, honoring the created_at range in the search and the cursor.

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_backfill_test_token_0001";
const WS = "ws_impact";
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const REQUIRED = [
  "read_orders",
  "write_orders",
  "read_customers",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
];
const WITH_ALL_ORDERS = [...REQUIRED, "read_all_orders"];

type HistoryOrder = { id: number; createdAtMs: number; fulfilled?: boolean; tags?: string[] };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function nodeOf(order: HistoryOrder) {
  return {
    id: `gid://shopify/Order/${order.id}`,
    legacyResourceId: String(order.id),
    name: `#${order.id}`,
    createdAt: iso(order.createdAtMs),
    updatedAt: iso(order.createdAtMs + 60000),
    email: "riley.oakes@example.com",
    tags: order.tags ?? [],
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: order.fulfilled ? "FULFILLED" : "UNFULFILLED",
    customer: { displayName: "Riley Oakes" },
    currentTotalPriceSet: { shopMoney: { amount: "40.00", currencyCode: "CAD" } },
    lineItems: { nodes: [] },
  };
}

type Request = { query: string; variables: { cursor: string | null; search: string } };

function page(nodes: unknown[], hasNextPage: boolean, endCursor: string | null) {
  return Response.json({ data: { orders: { nodes, pageInfo: { hasNextPage, endCursor } } } });
}

// history: what the import's created_at query sees. recent: what the
// regular sync's updated_at query returns (one page). before: runs before
// each request is answered, with the request number (1-based). override: a
// response that replaces the simulated one for that request.
function shop(
  history: HistoryOrder[],
  opts: {
    recent?: HistoryOrder[];
    before?: (n: number) => Promise<void> | void;
    override?: (n: number) => Response | null;
  } = {},
) {
  const requests: Request[] = [];
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as Request;
    requests.push(request);
    await opts.before?.(requests.length);
    const replaced = opts.override?.(requests.length);
    if (replaced) {
      return replaced;
    }
    if (!request.query.includes("OrderHistory")) {
      return page((opts.recent ?? []).map(nodeOf), false, null);
    }
    const since = request.variables.search.match(/created_at:>='([^']+)'/);
    const until = request.variables.search.match(/created_at:<'([^']+)'/);
    const sinceMs = since ? Date.parse(since[1]) : -Infinity;
    const untilMs = until ? Date.parse(until[1]) : Infinity;
    const inRange = history
      .filter((order) => order.createdAtMs >= sinceMs && order.createdAtMs < untilMs)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id - a.id);
    const start = request.variables.cursor ? Number(request.variables.cursor.slice(2)) : 0;
    const size = Number(request.query.match(/orders\(first: (\d+)/)![1]);
    const slice = inRange.slice(start, start + size);
    const end = start + slice.length;
    return page(slice.map(nodeOf), end < inRange.length, `h:${end}`);
  }) as typeof fetch;
  return {
    impl,
    requests,
    history: () => requests.filter((request) => request.query.includes("OrderHistory")),
  };
}

// A store's orders created daily, the newest `newestAgeDays` days ago.
function ordersOverDays(count: number, newestAgeDays: number, extra: Partial<HistoryOrder> = {}): HistoryOrder[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 9000 + i,
    createdAtMs: NOW - (newestAgeDays + i) * DAY,
    ...extra,
  }));
}

async function setup(opts: { scopes?: string[] | null; connection?: Partial<typeof schema.storeConnections.$inferInsert> } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    status: "ok",
    scopes: opts.scopes === undefined ? WITH_ALL_ORDERS : opts.scopes,
    lastSyncAt: NOW - 600000,
    ...opts.connection,
  });
  const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
  return { db, env };
}

async function connectionOf(db: Db) {
  const [row] = await db.select().from(schema.storeConnections).where(eq(schema.storeConnections.workspaceId, WS));
  return row;
}

async function ordersOf(db: Db) {
  return db.select().from(schema.orders).where(eq(schema.orders.workspaceId, WS));
}

async function startAll(db: Db, at = NOW) {
  const started = await startBackfill(db, WS, { range: "all" }, at);
  expect(started.kind).toBe("started");
}

const tick = (db: Db, env: CloudflareEnv, impl: typeof fetch, at = NOW + 60000) =>
  runBackfillTick(db, env, WS, { fetchImpl: impl, now: () => at });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startBackfill", () => {
  it("starts an import of all orders when the store's app may read them", async () => {
    const { db } = await setup();
    const result = await startBackfill(db, WS, { range: "all" }, NOW);
    expect(result).toEqual({
      kind: "started",
      backfill: expect.objectContaining({ status: "running", since: null, imported: 0, startedAt: NOW, finishedAt: null, error: null }),
    });
    const row = await connectionOf(db);
    expect(row.backfillStatus).toBe("running");
    expect(row.backfillCursor).toBeNull();
    // The regular sync's state is not part of an import.
    expect(row.lastSyncAt).toBe(NOW - 600000);
    expect(row.syncCursor).toBeNull();
  });

  it("refuses a range past 60 days when the app lacks read_all_orders, and says how to fix it", async () => {
    for (const scopes of [REQUIRED, null]) {
      const { db } = await setup({ scopes });
      for (const body of [{ range: "all" }, { range: "since", since: NOW - 61 * DAY }]) {
        const result = await startBackfill(db, WS, body, NOW);
        expect(result.kind).toBe("scope");
        if (result.kind === "scope") {
          expect(result.error).toContain("read_all_orders");
          expect(result.error).toContain("connect the store again");
        }
      }
      expect((await connectionOf(db)).backfillStatus).toBeNull();
    }
  });

  it("starts a range inside 60 days without read_all_orders", async () => {
    const { db } = await setup({ scopes: REQUIRED });
    const result = await startBackfill(db, WS, { range: "since", since: NOW - 30 * DAY }, NOW);
    expect(result).toMatchObject({ kind: "started", backfill: { status: "running", since: NOW - 30 * DAY } });
  });

  it("refuses a malformed request or a start date less than a day ago", async () => {
    const { db } = await setup();
    for (const body of [
      null,
      {},
      { range: "everything" },
      { range: "since" },
      { range: "since", since: "2026-01-01" },
      { range: "since", since: 1.5 },
      { range: "since", since: Date.UTC(1999, 0, 1) },
      { range: "since", since: NOW - 3600000 },
      { range: "since", since: NOW + DAY },
    ]) {
      const result = await startBackfill(db, WS, body, NOW);
      expect(result.kind, JSON.stringify(body)).toBe("invalid");
    }
    expect((await connectionOf(db)).backfillStatus).toBeNull();
  });

  it("refuses while an import is running, without a store, and while the store is disconnected", async () => {
    const { db } = await setup();
    await startAll(db);
    expect((await startBackfill(db, WS, { range: "all" }, NOW + 1000)).kind).toBe("conflict");
    expect((await connectionOf(db)).backfillStartedAt).toBe(NOW);

    const disconnected = await setup({ connection: { status: "disabled" } });
    expect((await startBackfill(disconnected.db, WS, { range: "all" }, NOW)).kind).toBe("conflict");

    const { db: empty } = openTestDb();
    await seedWorkspace(empty, WS);
    expect((await startBackfill(empty, WS, { range: "all" }, NOW)).kind).toBe("conflict");
  });

  it("starts over after a finished import", async () => {
    const { db } = await setup({
      connection: {
        backfillStatus: "failed",
        backfillImported: 40,
        backfillCursor: "h:40",
        backfillStartedAt: NOW - DAY,
        backfillFinishedAt: NOW - DAY + 5000,
        backfillError: "Shopify said no",
      },
    });
    const result = await startBackfill(db, WS, { range: "since", since: NOW - 90 * DAY }, NOW);
    expect(result).toMatchObject({
      kind: "started",
      backfill: { status: "running", since: NOW - 90 * DAY, imported: 0, startedAt: NOW, finishedAt: null, error: null },
    });
    expect((await connectionOf(db)).backfillCursor).toBeNull();
  });
});

describe("runBackfillTick", () => {
  it("imports a bounded stretch per tick and resumes from its cursor on the next", async () => {
    const { db, env } = await setup();
    const perTick = BACKFILL_PAGES_PER_TICK * 5;
    const store = shop(ordersOverDays(perTick + 30, 70));
    await startAll(db);

    const first = await tick(db, env, store.impl);
    expect(first).toMatchObject({ imported: perTick });
    expect(first.importedOrderIds).toHaveLength(perTick);
    expect(store.history()).toHaveLength(BACKFILL_PAGES_PER_TICK);
    let row = await connectionOf(db);
    expect(row).toMatchObject({
      backfillStatus: "running",
      backfillImported: perTick,
      backfillCursor: `h:${perTick}`,
      backfillFinishedAt: null,
      runningUntil: 0,
    });
    // Newest first: the most recent history arrives first.
    expect((await ordersOf(db)).map((order) => order.name)).toContain("#9000");

    const second = await tick(db, env, store.impl, NOW + 660000);
    expect(second).toMatchObject({ imported: 30, finished: "done" });
    expect(store.history()[BACKFILL_PAGES_PER_TICK].variables.cursor).toBe(`h:${perTick}`);
    row = await connectionOf(db);
    expect(row).toMatchObject({
      backfillStatus: "done",
      backfillImported: perTick + 30,
      backfillCursor: null,
      backfillFinishedAt: NOW + 660000,
      backfillError: null,
      runningUntil: 0,
    });
    expect(await ordersOf(db)).toHaveLength(perTick + 30);

    // The second tick read the 30 left in 6 pages; a finished import then
    // does nothing more.
    expect(store.history()).toHaveLength(BACKFILL_PAGES_PER_TICK + 6);
    const third = await tick(db, env, store.impl, NOW + 1260000);
    expect(third.skipped).toBe("idle");
    expect(store.history()).toHaveLength(BACKFILL_PAGES_PER_TICK + 6);
  });

  it("asks only for orders created in the range and at least a day before it started", async () => {
    const { db, env } = await setup();
    const store = shop([]);
    await startBackfill(db, WS, { range: "since", since: NOW - 200 * DAY }, NOW);
    await tick(db, env, store.impl);
    expect(store.history()[0].variables.search).toBe(
      `created_at:>='${iso(NOW - 200 * DAY)}' created_at:<'${iso(NOW - DAY)}'`,
    );
    expect((await connectionOf(db)).backfillStatus).toBe("done");
  });

  it("never touches the regular sync's cursor, window or status", async () => {
    const { db, env } = await setup({ connection: { lastSyncAt: NOW - 900000, lastError: "a blip", syncCursorSince: null } });
    const store = shop(ordersOverDays(12, 80));
    await startAll(db);
    await tick(db, env, store.impl);
    const row = await connectionOf(db);
    expect(row).toMatchObject({
      lastSyncAt: NOW - 900000,
      syncCursor: null,
      syncCursorSince: null,
      lastError: "a blip",
      status: "ok",
      lastManualSyncAt: 0,
    });

    // The regular sync then runs from exactly where it was.
    const regular = shop([]);
    await runSync(db, env, WS, { fetchImpl: regular.impl, now: () => NOW + 120000 });
    expect(regular.requests[0].variables.search).toBe(`updated_at:>='${iso(NOW - 900000 - 300000)}'`);
  });

  it("starts orders at the status their Shopify state or tag implies, claims their notification and writes nothing to Shopify", async () => {
    const { db, env } = await setup();
    await seedUser(db, "u_lead", "lead@example.com");
    await seedMember(db, WS, "u_lead", "manager");
    const store = shop([
      { id: 501, createdAtMs: NOW - 100 * DAY, fulfilled: true },
      { id: 502, createdAtMs: NOW - 101 * DAY, tags: [`${STATUS_TAG_PREFIX}Processing`] },
      { id: 503, createdAtMs: NOW - 102 * DAY },
    ]);
    await startAll(db);
    const result = await tick(db, env, store.impl);
    expect(result.imported).toBe(3);

    const rows = await ordersOf(db);
    const statusOf = (name: string) => rows.find((row) => row.name === name)?.statusKey;
    expect(statusOf("#501")).toBe("shipped");
    expect(statusOf("#502")).toBe("processing");
    expect(statusOf("#503")).toBe("new");
    expect(rows.every((row) => row.notifiedAt === NOW + 60000)).toBe(true);
    // Every request was a read of the order history: no tag, no
    // fulfillment, no mutation of any kind.
    expect(store.requests.every((request) => request.query.includes("OrderHistory"))).toBe(true);
    expect(store.requests.some((request) => request.query.includes("mutation"))).toBe(false);

    const events = await db.select().from(schema.events).where(eq(schema.events.workspaceId, WS));
    expect(events.map((event) => event.type)).toEqual(["order_new", "order_new", "order_new"]);
    for (const event of events) {
      expect(event.meta).toMatchObject({ imported: true });
      expect(event.text).toMatch(/^Order #50\d imported from the store's order history$/);
      expect(event.source).toBe("shopify");
    }

    // No path announces them later: their notification is already claimed.
    const notified = await notifyNewOrders(db, env, WS, result.importedOrderIds, { now: () => NOW + 120000 });
    expect(notified.claimed).toBe(0);

    // The bell leaves imported orders out of the feed and the count.
    const feed = await loadActivityFeed(db, WS, "u_lead");
    expect(feed.items).toEqual([]);
    expect(feed.unread).toBe(0);
  });

  it("skips orders already stored, without touching them, and counts only what it inserted", async () => {
    const { db, env } = await setup();
    await seedOrder(db, WS, {
      id: "known",
      name: "#701",
      statusKey: "approved",
      syncedAt: NOW - 5000,
      shopify: snapshotOf({ shopifyOrderId: "701", name: "#701", note: "stored by the sync" }),
    });
    await db.update(schema.orders).set({ shopifyOrderId: "701" }).where(eq(schema.orders.id, "known"));
    const store = shop([
      { id: 701, createdAtMs: NOW - 90 * DAY },
      { id: 702, createdAtMs: NOW - 91 * DAY },
    ]);
    await startAll(db);
    const result = await tick(db, env, store.impl);
    expect(result.imported).toBe(1);
    expect((await connectionOf(db)).backfillImported).toBe(1);
    const [known] = await db.select().from(schema.orders).where(eq(schema.orders.id, "known"));
    expect(known.statusKey).toBe("approved");
    expect(known.syncedAt).toBe(NOW - 5000);
    expect(known.shopify).toMatchObject({ note: "stored by the sync" });
  });

  it("leaves orders from the last day and outside the range to the regular sync, whatever Shopify returns", async () => {
    const { db, env } = await setup();
    await startBackfill(db, WS, { range: "since", since: NOW - 100 * DAY }, NOW);
    // A Shopify that ignores the search returns everything.
    const nodes = [
      nodeOf({ id: 801, createdAtMs: NOW - 3600000 }),
      nodeOf({ id: 802, createdAtMs: NOW - 120 * DAY }),
      nodeOf({ id: 803, createdAtMs: NOW - 50 * DAY }),
    ];
    const store = shop([], { override: () => page(nodes, false, null) });
    const result = await tick(db, env, store.impl);
    expect(result.imported).toBe(1);
    expect((await ordersOf(db)).map((order) => order.name)).toEqual(["#803"]);
  });

  it("waits while the regular sync is still catching up", async () => {
    const { db, env } = await setup({ connection: { syncCursor: `${NOW}|abc`, syncCursorSince: NOW - 60 * DAY } });
    const store = shop(ordersOverDays(3, 70));
    await startAll(db);
    const result = await tick(db, env, store.impl);
    expect(result.skipped).toBe("waiting");
    expect(store.requests).toHaveLength(0);
    expect(await getBackfillView(db, WS)).toMatchObject({ status: "running", paused: "sync" });
  });

  it("does not run while a sync of the same workspace holds the lease", async () => {
    const { db, env } = await setup({ connection: { runningUntil: NOW + 120000 } });
    const store = shop(ordersOverDays(3, 70));
    await startAll(db);
    const result = await tick(db, env, store.impl, NOW + 1000);
    expect(result.skipped).toBe("running");
    expect(store.requests).toHaveLength(0);
    expect(await connectionOf(db)).toMatchObject({ runningUntil: NOW + 120000, backfillImported: 0 });
  });

  it("holds the sync lease while it runs, so a sync started meanwhile skips", async () => {
    const { db, env } = await setup();
    let syncDuringTick: Awaited<ReturnType<typeof runSync>> | null = null;
    const store = shop(ordersOverDays(3, 70), {
      before: async (n) => {
        if (n === 1) {
          syncDuringTick = await runSync(db, env, WS, { fetchImpl: shop([]).impl, now: () => NOW + 61000 });
        }
      },
    });
    await startAll(db);
    await tick(db, env, store.impl);
    expect(syncDuringTick).toMatchObject({ skipped: "running" });
    expect((await connectionOf(db)).runningUntil).toBe(0);
  });
});

describe("cancelBackfill", () => {
  it("stops a running import, keeps its count and fetches nothing more", async () => {
    const { db, env } = await setup();
    const store = shop(ordersOverDays(BACKFILL_PAGES_PER_TICK * 5 + 10, 70));
    await startAll(db);
    await tick(db, env, store.impl);
    const cancelled = await cancelBackfill(db, WS, NOW + 120000);
    expect(cancelled).toMatchObject({
      kind: "cancelled",
      backfill: { status: "cancelled", imported: BACKFILL_PAGES_PER_TICK * 5, finishedAt: NOW + 120000 },
    });
    expect((await connectionOf(db)).backfillCursor).toBeNull();
    const after = await tick(db, env, store.impl, NOW + 660000);
    expect(after.skipped).toBe("idle");
    expect(store.history()).toHaveLength(BACKFILL_PAGES_PER_TICK);
  });

  it("wins over a tick that is still fetching: that tick writes no orders and leaves it cancelled", async () => {
    const { db, env } = await setup();
    const store = shop(ordersOverDays(4, 70), {
      before: async (n) => {
        if (n === 1) {
          await cancelBackfill(db, WS, NOW + 61000);
        }
      },
    });
    await startAll(db);
    const result = await tick(db, env, store.impl);
    expect(result).toMatchObject({ imported: 0, superseded: true });
    expect(await ordersOf(db)).toHaveLength(0);
    expect(await connectionOf(db)).toMatchObject({ backfillStatus: "cancelled", runningUntil: 0, backfillImported: 0 });
  });

  it("answers a conflict when nothing is running", async () => {
    const { db } = await setup();
    expect((await cancelBackfill(db, WS, NOW)).kind).toBe("conflict");
  });
});

describe("runBackfillTick failures", () => {
  it("keeps running through a blip, with the error shown and the cursor kept", async () => {
    const { db, env } = await setup({ connection: { backfillStatus: "running", backfillStartedAt: NOW, backfillCursor: "h:5" } });
    const store = shop(ordersOverDays(20, 70), { override: () => new Response("busy", { status: 503 }) });
    const result = await tick(db, env, store.impl);
    expect(result.error).toContain("503");
    expect(await connectionOf(db)).toMatchObject({
      backfillStatus: "running",
      backfillCursor: "h:5",
      backfillError: expect.stringContaining("503"),
      runningUntil: 0,
    });
  });

  it("fails on an error Shopify will repeat, and on rejected credentials", async () => {
    const fatal = await setup({ connection: { backfillStatus: "running", backfillStartedAt: NOW, backfillCursor: "h:5" } });
    const refused = shop([], {
      override: () => Response.json({ errors: [{ message: "Invalid cursor for current pagination" }] }),
    });
    expect((await tick(fatal.db, fatal.env, refused.impl)).finished).toBe("failed");
    expect(await connectionOf(fatal.db)).toMatchObject({
      backfillStatus: "failed",
      backfillError: expect.stringContaining("Invalid cursor"),
      backfillFinishedAt: NOW + 60000,
      backfillCursor: null,
    });

    const auth = await setup({ connection: { backfillStatus: "running", backfillStartedAt: NOW } });
    const denied = shop([], { override: () => new Response("{}", { status: 401 }) });
    expect((await tick(auth.db, auth.env, denied.impl)).finished).toBe("failed");
    expect(await connectionOf(auth.db)).toMatchObject({ backfillStatus: "failed", runningUntil: 0 });
  });

  it("fails without asking Shopify when the store was reconnected without read_all_orders", async () => {
    const { db, env } = await setup({ scopes: REQUIRED, connection: { backfillStatus: "running", backfillStartedAt: NOW } });
    const store = shop(ordersOverDays(3, 70));
    const result = await tick(db, env, store.impl);
    expect(result.finished).toBe("failed");
    expect(store.requests).toHaveLength(0);
    expect((await connectionOf(db)).backfillError).toContain("read_all_orders");
  });

  it("pauses while the store is disconnected", async () => {
    const { db, env } = await setup({
      connection: { status: "disabled", backfillStatus: "running", backfillStartedAt: NOW, backfillCursor: "h:5" },
    });
    const store = shop(ordersOverDays(3, 70));
    expect((await tick(db, env, store.impl)).skipped).toBe("disabled");
    expect(store.requests).toHaveLength(0);
    expect(await getBackfillView(db, WS)).toMatchObject({ status: "running", paused: "disconnected" });
  });
});

describe("runAllSyncs with an import running", () => {
  const sent: Array<{ subject: string }> = [];
  const env = {
    ENCRYPTION_KEY: KEY,
    APP_URL: "https://orderingdesk.com",
    EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>",
    EMAIL: {
      send: async (message: { subject: string }) => {
        sent.push(message);
        return { messageId: `m${sent.length}` };
      },
    },
  } as unknown as CloudflareEnv;

  it("advances the import after the regular sync and announces only the regular sync's new order", async () => {
    sent.length = 0;
    const { db } = await setup();
    await seedUser(db, "u_lead", "lead@example.com");
    await seedMember(db, WS, "u_lead", "manager");
    await startAll(db);
    const store = shop(ordersOverDays(7, 70), { recent: [{ id: 1, createdAtMs: NOW + 30000 }] });

    await runAllSyncs(db, env, { fetchImpl: store.impl, now: () => NOW + 60000 });

    const orderRequests = store.requests.filter((request) => request.query.includes("orders(first:"));
    expect(orderRequests[0].query).not.toContain("OrderHistory");
    expect(store.history()).toHaveLength(2);
    expect(await ordersOf(db)).toHaveLength(8);
    expect(await connectionOf(db)).toMatchObject({ backfillStatus: "done", backfillImported: 7, lastSyncAt: NOW + 60000 });
    // One email: the regular sync's new order. The seven imported orders
    // announce nothing.
    expect(sent.map((message) => message.subject)).toEqual(["New order #1 from Riley Oakes"]);
    const imported = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.workspaceId, WS), eq(schema.events.type, "order_new")));
    expect(imported.filter((event) => (event.meta as { imported?: boolean }).imported === true)).toHaveLength(7);
  });
});
