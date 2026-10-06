import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import { MAX_PAGES, ORDERS_PER_PAGE } from "../shopify/client";
import fixture from "../shopify/__fixtures__/orders-graphql.json";
import { runSync, applyPair, EXISTENCE_CHUNK, type SyncResult } from "./run";
import { runAllSyncs } from "./cron";
import { deleteConnection, saveConnection } from "../desk/connection";

// runSync against a real migrated SQLite database. @cloudflare/vitest-pool-workers
// peer-requires vitest 4 and this repo is on vitest 5, so the D1 in these tests
// is played by better-sqlite3-backed drizzle injected as Db (same migrations,
// same schema SQL; run.ts falls back from db.batch to sequential awaits).

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");

const TEST_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const FAKE_TOKEN = "shpat_fake_token_for_tests_0001";
const WS = "ws_impact";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const LATER = NOW + 600000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 300000;

const TOKEN_UNREADABLE = "Token unreadable, re-enter it in Settings";
const TOKEN_REJECTED = "Shopify rejected the token. Update the connection in Settings.";

const fixtureNodes = (fixture as { data: { orders: { nodes: unknown[] } } }).data.orders.nodes;

const rileyNode = {
  id: "gid://shopify/Order/6101",
  legacyResourceId: "6101",
  name: "#1101",
  createdAt: "2026-09-20T10:00:00Z",
  email: "riley.oakes@example.com",
  customer: { displayName: "Riley Oakes" },
  note: "original note",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  currentTotalPriceSet: { shopMoney: { amount: "120.00", currencyCode: "CAD" } },
  tags: [],
  lineItems: { nodes: [] },
};

// opts.through stops at a migration number ("0003"), for the test that pins
// which schema the sync engine needs.
function openDb(opts?: { through?: string }) {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => opts?.through === undefined || f.slice(0, 4) <= opts.through)
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        raw.prepare(trimmed).run();
      }
    }
  }
  const db = drizzle(raw, { schema }) as unknown as Db;
  const env = { ENCRYPTION_KEY: TEST_KEY } as CloudflareEnv;
  return { db, raw, env };
}

async function seedWorkspace(
  db: Db,
  wsId: string,
  opts?: {
    statuses?: boolean;
    connection?: boolean;
    connectionStatus?: "ok" | "error" | "disabled";
    encryptedToken?: string;
  },
) {
  await db.insert(schema.workspaces).values({
    id: wsId,
    name: "Impact " + wsId,
    slug: wsId,
    createdBy: "user_admin",
    createdAt: 1,
  });
  if (opts?.statuses !== false) {
    await db.insert(schema.statuses).values([
      {
        id: wsId + "_st_received",
        workspaceId: wsId,
        key: "received",
        label: "Received",
        color: "#91d500",
        sort: 0,
      },
      {
        id: wsId + "_st_progress",
        workspaceId: wsId,
        key: "in_progress",
        label: "In progress",
        color: "#101820",
        sort: 10,
      },
    ]);
  }
  if (opts?.connection !== false) {
    await db.insert(schema.storeConnections).values({
      workspaceId: wsId,
      shopDomain: "impact-rentals.myshopify.com",
      encryptedToken: opts?.encryptedToken ?? (await encryptSecret(FAKE_TOKEN, TEST_KEY, wsId)),
      status: opts?.connectionStatus ?? "ok",
    });
  }
}

async function makeDb(opts?: Parameters<typeof seedWorkspace>[2]) {
  const ctx = openDb();
  await seedWorkspace(ctx.db, WS, opts);
  return ctx;
}

type RecordedCall = {
  url: string;
  body: { query?: string; variables?: { cursor?: unknown; search?: unknown } };
};

type ScriptedPage = { nodes: unknown[]; hasNextPage: boolean; endCursor?: string | null };

// Returns one scripted page per call; the last page repeats if calls overrun.
function scriptedFetch(script: ScriptedPage[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    const page = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            nodes: page.nodes,
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor ?? null },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, calls };
}

function pageFetch(nodes: unknown[]) {
  return scriptedFetch([{ nodes, hasNextPage: false }]);
}

function statusFetch(status: number) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { impl, calls };
}

function errorsFetch(errors: unknown[]) {
  const impl = (async () =>
    new Response(JSON.stringify({ errors }), { status: 200 })) as typeof fetch;
  return { impl };
}

type SimOrder = { idNum: number; updatedAtMs: number };

type SimRequest = { query: string; variables: { cursor: string | null; search: string } };

function simRequest(init?: RequestInit): SimRequest {
  return JSON.parse(String(init?.body ?? "{}")) as SimRequest;
}

// The simulators serve the page size the query asks for, read from the query
// document itself, so a run sees the same number of pages it would see live.
function requestedPageSize(request: SimRequest): number {
  const size = request.query.match(/orders\(first: (\d+)/);
  if (!size) {
    throw new Error("simulator: the query names no orders page size");
  }
  return Number(size[1]);
}

// The value a truncated run leaves in store_connections.sync_cursor: the run
// start of the tick that opened the cursor chain, then the Shopify cursor.
// Spelled out here, not imported from run.ts, so the tests pin the stored
// format as well.
function chainToken(openedAt: number, cursor: string): string {
  return `${openedAt}|${cursor}`;
}

// Window-honoring Shopify simulator (adapted from the review repro harness):
// filters the dataset by the updated_at search window, sorts ascending by
// (updated_at, id) like the Admin API's stable tie-break, pages by the
// requested page size, and optionally rejects any cursor to simulate
// staleness.
function shopifySim(dataset: SimOrder[], opts?: { rejectCursors?: boolean }) {
  let requests = 0;
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const request = simRequest(init);
    const vars = request.variables;
    if (vars.cursor !== null && opts?.rejectCursors) {
      return new Response(
        JSON.stringify({ errors: [{ message: `cursor ${vars.cursor} is invalid` }] }),
        { status: 200 },
      );
    }
    const sinceMs = Date.parse(vars.search.match(/'(.*)'/)![1]);
    const windowed = dataset
      .filter((o) => o.updatedAtMs >= sinceMs)
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.idNum - b.idNum);
    const start = vars.cursor ? parseInt(vars.cursor.slice(4), 10) : 0;
    const page = windowed.slice(start, start + requestedPageSize(request));
    const end = start + page.length;
    const nodes = page.map((o) => ({
      id: `gid://shopify/Order/${o.idNum}`,
      legacyResourceId: String(o.idNum),
      name: `#${o.idNum}`,
      createdAt: new Date(o.updatedAtMs - 1000).toISOString(),
      updatedAt: new Date(o.updatedAtMs).toISOString(),
      tags: [],
      lineItems: { nodes: [] },
    }));
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            nodes,
            pageInfo: { hasNextPage: end < windowed.length, endCursor: `idx:${end}` },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, count: () => requests };
}

type LaggyOrder = SimOrder & {
  visibleAtMs?: number;
  // A later edit the search index has not caught up with: from editedAtMs on
  // the node carries the new updatedAt, but until reindexedAtMs the order is
  // still filtered and sorted by its old one.
  editedAtMs?: number;
  reindexedAtMs?: number;
};

// Shopify simulator whose updated_at search index lags behind the primary
// store. An order is only returned once the injected clock has reached its
// visibleAtMs, and an edited order keeps its old sort position until the
// index has caught up while its node is already hydrated fresh. Cursors are
// keyset positions (indexed updatedAt, id), like Shopify's own, so an order
// that surfaces behind a cursor is never returned by that cursor's chain.
// opts.cursorless picks requests (1-based) that are answered with a null
// endCursor, the upstream anomaly of more pages and no way to reach them.
function laggyShopifySim(
  dataset: LaggyOrder[],
  clock: () => number,
  opts?: { cursorless?: (request: number) => boolean },
) {
  let requests = 0;
  const cursors: Array<string | null> = [];
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const request = simRequest(init);
    const vars = request.variables;
    cursors.push(vars.cursor);
    const at = clock();
    const indexed = (o: LaggyOrder) =>
      o.editedAtMs !== undefined && at >= (o.reindexedAtMs ?? o.editedAtMs)
        ? o.editedAtMs
        : o.updatedAtMs;
    const hydrated = (o: LaggyOrder) =>
      o.editedAtMs !== undefined && at >= o.editedAtMs ? o.editedAtMs : o.updatedAtMs;
    const sinceMs = Date.parse(vars.search.match(/'(.*)'/)![1]);
    const after = vars.cursor ? vars.cursor.split(":").slice(1).map(Number) : null;
    const remaining = dataset
      .filter((o) => indexed(o) >= sinceMs && (o.visibleAtMs ?? 0) <= at)
      .filter(
        (o) =>
          after === null ||
          indexed(o) > after[0] ||
          (indexed(o) === after[0] && o.idNum > after[1]),
      )
      .sort((a, b) => indexed(a) - indexed(b) || a.idNum - b.idNum);
    const page = remaining.slice(0, requestedPageSize(request));
    const last = page[page.length - 1];
    const nodes = page.map((o) => ({
      id: `gid://shopify/Order/${o.idNum}`,
      legacyResourceId: String(o.idNum),
      name: `#${o.idNum}`,
      createdAt: new Date(o.updatedAtMs - 1000).toISOString(),
      updatedAt: new Date(hydrated(o)).toISOString(),
      tags: [],
      lineItems: { nodes: [] },
    }));
    const endCursor = opts?.cursorless?.(requests)
      ? null
      : last
        ? `key:${indexed(last)}:${last.idNum}`
        : vars.cursor;
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            nodes,
            pageInfo: { hasNextPage: remaining.length > page.length, endCursor },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, count: () => requests, cursors: () => cursors };
}

// Shopify's rate bucket in miniature: after refill() the next `burst`
// requests are served, every one after that is answered the way Shopify
// answers an empty bucket (HTTP 200 with a THROTTLED GraphQL error).
function throttledAfter(inner: typeof fetch, burst: number) {
  let served = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (served >= burst) {
      return new Response(
        JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
        { status: 200 },
      );
    }
    served++;
    return inner(input, init);
  }) as typeof fetch;
  return {
    impl,
    refill: () => {
      served = 0;
    },
  };
}

// Proxy whose existence query sees nothing, simulating a racing run that
// inserted the same orders after this run built its existence map.
function withBlindExistenceCheck(db: Db): Db {
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          const fields = args[0] as Record<string, unknown> | undefined;
          if (fields && "shopifyOrderId" in fields) {
            return { from: () => ({ where: async () => [] }) };
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Proxy that adds a D1-style batch to the better-sqlite3 Db so the batch
// branch of applyPair runs in-flow.
function withBatch(db: Db, record: unknown[][]): Db {
  const batch = async (statements: PromiseLike<unknown>[]) => {
    record.push([...statements]);
    const out: unknown[] = [];
    for (const statement of statements) {
      out.push(await statement);
    }
    return out;
  };
  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "batch") {
        return batch;
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Proxy that rewraps every update result into the D1 shape ({meta: {changes}}),
// to prove the lease CAS reads rows-affected from both driver shapes.
function d1Wrap(builder: unknown): unknown {
  return new Proxy(builder as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "then") {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          (target as PromiseLike<{ changes?: number }>).then(
            (res) => onFulfilled?.({ success: true, meta: { changes: res?.changes } }),
            onRejected,
          );
      }
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          d1Wrap((value as (...a: unknown[]) => unknown).apply(target, args));
      }
      return value;
    },
  });
}

function withD1UpdateResults(db: Db): Db {
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "update" && typeof value === "function") {
        return (...args: unknown[]) =>
          d1Wrap((value as (...a: unknown[]) => unknown).apply(target, args));
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Proxy whose Nth bare db.select() (no field list: the two whole-row
// connection reads in runSync) rejects, simulating a transient database error
// on exactly that statement. Every other statement passes through untouched.
function withFailingBareSelect(db: Db, failOnCall: number, message: string): Db {
  let bareSelects = 0;
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          if (args.length === 0) {
            bareSelects++;
            if (bareSelects === failOnCall) {
              return {
                from: () => ({
                  where: () => ({
                    limit: async () => {
                      throw new Error(message);
                    },
                  }),
                }),
              };
            }
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Starts a run whose fetch parks until finish() is called: a zombie that is
// still alive after its 120 second lease has expired. Resolves once the run
// holds the lease and is parked inside its fetch.
async function parkedZombie(db: Db, env: CloudflareEnv, at: number, nodes: unknown[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let parked!: () => void;
  const atFetch = new Promise<void>((resolve) => {
    parked = resolve;
  });
  const page = pageFetch(nodes);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    parked();
    await gate;
    return page.impl(input, init);
  }) as typeof fetch;
  const done = runSync(db, env, WS, { fetchImpl, now: () => at });
  await Promise.race([atFetch, done]);
  return {
    finish: async () => {
      release();
      return done;
    },
  };
}

// Proxy that runs a hook right after this run's first existence read has
// resolved and before the run acts on it: the exact gap in which another
// run's order writes can land unseen. The read itself passes through.
function withHookAfterExistenceRead(db: Db, hook: () => Promise<void>): Db {
  let fired = false;
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          const builder = (value as (...a: unknown[]) => unknown).apply(target, args) as {
            from: (table: unknown) => { where: (condition: unknown) => PromiseLike<unknown[]> };
          };
          const fields = args[0] as Record<string, unknown> | undefined;
          if (!fields || !("shopifyOrderId" in fields)) {
            return builder;
          }
          return {
            from: (table: unknown) => ({
              where: async (condition: unknown) => {
                const rows = await builder.from(table).where(condition);
                if (!fired) {
                  fired = true;
                  await hook();
                }
                return rows;
              },
            }),
          };
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// A fetch that parks until release() is called, so a test can act while a
// run sits inside its Shopify request holding the lease. atFetch resolves
// once the run is parked there.
function heldFetch(nodes: unknown[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const atFetch = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const page = pageFetch(nodes);
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    entered();
    await gate;
    return page.impl(input, init);
  }) as typeof fetch;
  return { impl, atFetch, release };
}

// Answers the connection-settings verification query for a second store.
const shopBVerified = (async () =>
  new Response(
    JSON.stringify({
      data: {
        shop: { name: "Shop B" },
        currentAppInstallation: {
          accessScopes: [
            "read_orders",
            "write_orders",
            "read_customers",
            "read_merchant_managed_fulfillment_orders",
            "write_merchant_managed_fulfillment_orders",
          ].map((handle) => ({ handle })),
        },
      },
    }),
    { status: 200 },
  )) as typeof fetch;

function storeOrders(count: number, firstId: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...rileyNode,
    id: `gid://shopify/Order/${firstId + i}`,
    legacyResourceId: String(firstId + i),
    name: `#${firstId + i}`,
  }));
}

// Proxy that runs hook(n) after the run's n-th existence read (1-based) has
// resolved, before the run acts on it. The reads themselves pass through.
function withExistenceReadHook(db: Db, hook: (n: number) => Promise<void> | void): Db {
  let reads = 0;
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          const builder = (value as (...a: unknown[]) => unknown).apply(target, args) as {
            from: (table: unknown) => { where: (condition: unknown) => PromiseLike<unknown[]> };
          };
          const fields = args[0] as Record<string, unknown> | undefined;
          if (!fields || !("shopifyOrderId" in fields)) {
            return builder;
          }
          return {
            from: (table: unknown) => ({
              where: async (condition: unknown) => {
                const rows = await builder.from(table).where(condition);
                reads++;
                await hook(reads);
                return rows;
              },
            }),
          };
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

// Proxy whose FIRST existence read sees nothing (a racing run stored the
// order right after it); every later read, including the re-read after an
// insert conflict, sees the table as it is.
function withBlindFirstExistenceRead(db: Db): Db {
  let blinded = false;
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          const fields = args[0] as Record<string, unknown> | undefined;
          if (!blinded && fields && "shopifyOrderId" in fields) {
            blinded = true;
            return { from: () => ({ where: async () => [] }) };
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

function allEventsIn(db: Db, wsId: string) {
  return db.select().from(schema.events).where(eq(schema.events.workspaceId, wsId));
}

const SUPERSEDED_EMPTY: SyncResult = {
  added: 0,
  updated: 0,
  addedOrderIds: [],
  updatedOrderIds: [],
  superseded: true,
};

function ordersIn(db: Db, wsId: string) {
  return db.select().from(schema.orders).where(eq(schema.orders.workspaceId, wsId));
}

function eventsIn(db: Db, wsId: string, type: "order_new" | "sync_error") {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.workspaceId, wsId), eq(schema.events.type, type)));
}

async function connectionOf(db: Db, wsId: string) {
  const rows = await db
    .select()
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, wsId));
  return rows[0];
}

describe("runSync", () => {
  it("inserts new orders with an order_new event each, idempotently", async () => {
    const { db, env } = await makeDb();

    const first = pageFetch(fixtureNodes);
    const result = await runSync(db, env, WS, { fetchImpl: first.impl, now: () => NOW });
    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.updatedOrderIds).toEqual([]);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toBeUndefined();

    const orderRows = await ordersIn(db, WS);
    expect(orderRows).toHaveLength(3);
    expect(new Set(result.addedOrderIds)).toEqual(new Set(orderRows.map((o) => o.id)));
    for (const row of orderRows) {
      expect(row.statusKey).toBe("received");
      expect(row.syncedAt).toBe(NOW);
    }
    const o1001 = orderRows.find((o) => o.name === "#1001");
    expect(o1001?.shopifyOrderId).toBe("6001");
    expect(o1001?.createdAt).toBe(Date.parse("2026-09-12T14:03:22Z"));

    const newEvents = await eventsIn(db, WS, "order_new");
    expect(newEvents).toHaveLength(3);
    const e1001 = newEvents.find((e) => e.orderId === o1001?.id);
    expect(e1001?.text).toBe("New order #1001 from Riley Oakes");
    expect(e1001?.meta).toEqual({ orderName: "#1001" });
    // New orders come from Shopify (the timeline shows where a change came from).
    expect(newEvents.map((e) => e.source)).toEqual(["shopify", "shopify", "shopify"]);

    const afterFirst = await connectionOf(db, WS);
    expect(afterFirst.lastSyncAt).toBe(NOW);
    expect(afterFirst.runningUntil).toBe(0);
    expect(afterFirst.status).toBe("ok");
    expect(afterFirst.lastError).toBeNull();

    const second = pageFetch(fixtureNodes);
    const again = await runSync(db, env, WS, { fetchImpl: second.impl, now: () => LATER });
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.addedOrderIds).toEqual([]);
    expect(await ordersIn(db, WS)).toHaveLength(3);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(3);
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(LATER);
  });

  it("updates a changed snapshot without a second event and preserves custom status fields", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });

    // A teammate moves the order to a custom status between syncs.
    await db
      .update(schema.orders)
      .set({ statusKey: "in_progress", statusSetBy: "user_marta", statusSetAt: 777 })
      .where(eq(schema.orders.workspaceId, WS));

    const changed = { ...rileyNode, note: "updated note" };
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([changed]).impl,
      now: () => LATER,
    });
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(result.updatedOrderIds).toEqual([rows[0].id]);
    expect(rows[0].statusKey).toBe("in_progress");
    expect(rows[0].statusSetBy).toBe("user_marta");
    expect(rows[0].statusSetAt).toBe(777);
    expect((rows[0].shopify as { note: string }).note).toBe("updated note");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(rows[0].name).toBe("#1101");
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  // The desk and the purchase order modal read line items from the stored
  // snapshot, so the marker has to travel with it.
  it("stores the line item truncation marker with the snapshot", async () => {
    const { db, env } = await makeDb();
    const item = { title: "Hard Hat", quantity: 3, sku: "HH-1", variantTitle: "White" };
    const partial = { ...rileyNode, lineItems: { nodes: [item], pageInfo: { hasNextPage: true } } };
    await runSync(db, env, WS, { fetchImpl: pageFetch([partial]).impl, now: () => NOW });
    const [stored] = await ordersIn(db, WS);
    expect(stored.shopify).toMatchObject({
      items: [{ title: "Hard Hat", qty: 3 }],
      itemsTruncated: true,
    });

    // The same items, now confirmed whole: the marker alone refreshes it.
    const whole = { ...rileyNode, lineItems: { nodes: [item], pageInfo: { hasNextPage: false } } };
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([whole]).impl,
      now: () => LATER,
    });
    expect(result.updated).toBe(1);
    const [refreshed] = await ordersIn(db, WS);
    expect(refreshed.shopify).toMatchObject({ itemsTruncated: false });
  });

  it("gives the order_new event a cross-run deterministic id", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });
    const [event] = await eventsIn(db, WS, "order_new");
    expect(event.id).toBe(`evt-order-new-${WS}-6101`);
  });

  it("handles the same order twice in one batch: one row, one event, no throw", async () => {
    const { db, env } = await makeDb();
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode, { ...rileyNode }]).impl,
      now: () => NOW,
    });
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.error).toBeUndefined();
    expect(await ordersIn(db, WS)).toHaveLength(1);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("counts an intra-batch duplicate with a changed snapshot as added only", async () => {
    const { db, env } = await makeDb();
    const changed = { ...rileyNode, note: "second copy" };
    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode, changed]).impl,
      now: () => NOW,
    });
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.addedOrderIds).toHaveLength(1);
    expect(result.updatedOrderIds).toEqual([]);
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    // The newest snapshot in the batch still wins.
    expect((rows[0].shopify as { note: string }).note).toBe("second copy");
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("a losing racer neither double-counts nor double-events a new order", async () => {
    const { db, env } = await makeDb();
    // Winner lands the order and its event first.
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });
    // The loser's existence map was built before the winner's insert.
    const result = await runSync(withBlindExistenceCheck(db), env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => LATER,
    });
    expect(result.error).toBeUndefined();
    expect(result.added).toBe(0);
    expect(result.addedOrderIds).toEqual([]);
    expect(await ordersIn(db, WS)).toHaveLength(1);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("a superseded run cannot clobber connection state or release the new lease", async () => {
    const { db, raw, env } = await makeDb();
    const hijackedLease = NOW + 999999;
    // Mid-run (after the CAS, before any terminal write) another run takes
    // over the lease; this run's terminal auth-failure write must not land.
    const impl = (async () => {
      raw
        .prepare("UPDATE store_connections SET running_until = ? WHERE workspace_id = ?")
        .run(hijackedLease, WS);
      return new Response("{}", { status: 401 });
    }) as typeof fetch;

    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.superseded).toBe(true);

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.lastError).toBeNull();
    expect(connection.runningUntil).toBe(hijackedLease);
  });

  it("a zombie run cannot regress a snapshot written by a newer run", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW - 600000,
    });

    // Run A starts at NOW and its fetch hangs past the 120 second lease.
    // While it hangs, run B (started at LATER) takes the expired lease, writes
    // a newer snapshot of the same order and finishes. Only then does A's
    // fetch return, carrying the older snapshot.
    const stale = { ...rileyNode, note: "stale note from zombie run A" };
    const fresh = { ...rileyNode, note: "fresh note from run B" };
    const stalePage = pageFetch([stale]);
    let runB: SyncResult | undefined;
    const zombieFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      runB = await runSync(db, env, WS, { fetchImpl: pageFetch([fresh]).impl, now: () => LATER });
      return stalePage.impl(input, init);
    }) as typeof fetch;

    const runA = await runSync(db, env, WS, { fetchImpl: zombieFetch, now: () => NOW });

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(runB?.updated).toBe(1);
    expect(runB?.updatedOrderIds).toEqual([rows[0].id]);
    expect(runB?.superseded).toBeUndefined();

    // A's stale update changed nothing and is not reported.
    expect((rows[0].shopify as { note: string }).note).toBe("fresh note from run B");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(runA.updated).toBe(0);
    expect(runA.updatedOrderIds).toEqual([]);
    expect(runA.added).toBe(0);
    expect(runA.addedOrderIds).toEqual([]);
    expect(runA.superseded).toBe(true);

    // B's terminal connection state stands.
    const connection = await connectionOf(db, WS);
    expect(connection.lastSyncAt).toBe(LATER);
    expect(connection.runningUntil).toBe(0);
  });

  it("a superseded run writes nothing, not even an order nobody has stored yet", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW - 600000,
    });

    // Zombie run A carries a stale snapshot of the existing order plus an
    // order nobody has seen yet. B takes the expired lease and refreshes the
    // existing order meanwhile. A checks its lease once its fetch returns and
    // stops: the order it alone fetched is not lost in practice, because A
    // never advanced lastSyncAt or the cursor, so B's window covers it (B's
    // scripted page here simply does not carry it).
    const stale = { ...rileyNode, note: "stale note from zombie run A" };
    const fresh = { ...rileyNode, note: "fresh note from run B" };
    const unseen = {
      ...rileyNode,
      id: "gid://shopify/Order/6102",
      legacyResourceId: "6102",
      name: "#1102",
    };
    const zombiePage = pageFetch([stale, unseen]);
    const zombieFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await runSync(db, env, WS, { fetchImpl: pageFetch([fresh]).impl, now: () => LATER });
      return zombiePage.impl(input, init);
    }) as typeof fetch;

    const runA = await runSync(db, env, WS, { fetchImpl: zombieFetch, now: () => NOW });
    expect(runA).toEqual(SUPERSEDED_EMPTY);

    const rows = await ordersIn(db, WS);
    expect(rows.map((o) => o.shopifyOrderId)).toEqual(["6101"]);
    expect((rows[0].shopify as { note: string }).note).toBe("fresh note from run B");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("a run superseded by a store change while its fetch is in flight writes nothing", async () => {
    const { db, env } = await makeDb();
    const held = heldFetch(storeOrders(3, 8001));
    const running = runSync(db, env, WS, { fetchImpl: held.impl, now: () => NOW });
    await held.atFetch;

    const saved = await saveConnection(
      db,
      { workspaceId: WS, encryptionKey: TEST_KEY, fetchImpl: shopBVerified },
      { shopDomain: "shop-b", token: "shpat_shop_b_token_0002" },
    );
    expect(saved.kind).toBe("saved");
    held.release();

    expect(await running).toEqual(SUPERSEDED_EMPTY);
    expect(await ordersIn(db, WS)).toEqual([]);
    expect(await allEventsIn(db, WS)).toEqual([]);
    expect(await connectionOf(db, WS)).toMatchObject({
      shopDomain: "shop-b.myshopify.com",
      status: "ok",
      lastError: null,
      lastSyncAt: 0,
      runningUntil: 0,
      syncCursor: null,
      syncCursorSince: null,
    });
  });

  it("a run superseded by a disconnect while its fetch is in flight writes nothing", async () => {
    const { db, env } = await makeDb();
    const held = heldFetch(storeOrders(3, 8101));
    const running = runSync(db, env, WS, { fetchImpl: held.impl, now: () => NOW });
    await held.atFetch;

    await deleteConnection(db, WS);
    held.release();

    expect(await running).toEqual(SUPERSEDED_EMPTY);
    expect(await ordersIn(db, WS)).toEqual([]);
    expect(await allEventsIn(db, WS)).toEqual([]);
    // Disconnect is disable: the row stays, disabled, secrets cleared, and
    // the superseded run left it exactly so.
    expect(await connectionOf(db, WS)).toMatchObject({
      status: "disabled",
      encryptedToken: "",
      lastError: null,
      runningUntil: 0,
      lastSyncAt: 0,
    });
    // The next tick skips it.
    expect(await runSync(db, env, WS, { fetchImpl: pageFetch([]).impl, now: () => LATER })).toMatchObject({
      skipped: "disabled",
    });
  });

  // Pins the check right after the fetch returns (before any existence
  // chunk). The later checks would still stop the run before it writes an
  // order, but only after the first chunk had been claimed and read; this
  // test fails if the post-fetch check goes away.
  it("stops right after the fetch when the lease was released meanwhile: no claim, no existence read", async () => {
    const { db, raw, env } = await makeDb();
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW - 600000 });
    const [stored] = await ordersIn(db, WS);
    expect(stored.syncedAt).toBe(NOW - 600000);

    let reads = 0;
    const counting = withExistenceReadHook(db, (n) => {
      reads = n;
    });
    const held = heldFetch([{ ...rileyNode, note: "edited while the lease was released" }]);
    const running = runSync(counting, env, WS, { fetchImpl: held.impl, now: () => NOW });
    await held.atFetch;
    // A connection save (or a disconnect) releases the lease mid-fetch.
    raw.prepare("UPDATE store_connections SET running_until = 0 WHERE workspace_id = ?").run(WS);
    held.release();

    expect(await running).toEqual(SUPERSEDED_EMPTY);
    expect(reads).toBe(0);
    const [after] = await ordersIn(db, WS);
    expect(after.syncedAt).toBe(NOW - 600000);
    expect((after.shopify as { note: string }).note).toBe("original note");
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
    expect((await connectionOf(db, WS)).runningUntil).toBe(0);
  });

  it("re-checks the lease before every existence chunk", async () => {
    const { db, raw, env } = await makeDb();
    let reads = 0;
    // Another run takes the lease right after the first chunk was read.
    const racing = withExistenceReadHook(db, (n) => {
      reads = n;
      if (n === 1) {
        raw
          .prepare("UPDATE store_connections SET running_until = ? WHERE workspace_id = ?")
          .run(NOW + 999999, WS);
      }
    });
    const result = await runSync(racing, env, WS, {
      fetchImpl: pageFetch(storeOrders(EXISTENCE_CHUNK + 5, 8201)).impl,
      now: () => NOW,
    });

    expect(result).toEqual(SUPERSEDED_EMPTY);
    // The second chunk was never claimed or read.
    expect(reads).toBe(1);
    expect(await ordersIn(db, WS)).toEqual([]);
    expect(await allEventsIn(db, WS)).toEqual([]);
    expect((await connectionOf(db, WS)).runningUntil).toBe(NOW + 999999);
  });

  it("re-checks the lease once more after the last chunk, before any order is written", async () => {
    const { db, raw, env } = await makeDb();
    const racing = withExistenceReadHook(db, () => {
      raw
        .prepare("UPDATE store_connections SET running_until = ? WHERE workspace_id = ?")
        .run(NOW + 999999, WS);
    });
    const result = await runSync(racing, env, WS, {
      fetchImpl: pageFetch(storeOrders(3, 8301)).impl,
      now: () => NOW,
    });

    expect(result).toEqual(SUPERSEDED_EMPTY);
    expect(await ordersIn(db, WS)).toEqual([]);
    expect(await allEventsIn(db, WS)).toEqual([]);
  });

  it("a zombie run cannot regress a row a newer run verified as unchanged", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW - 600000,
    });

    // Zombie run A (started at NOW) fetched the order mid-flap: a note edit
    // that was undone in Shopify a minute later. Run B (started at LATER)
    // fetches the reverted order, which equals the stored snapshot, so B has
    // no snapshot to write. Only then does A's fetch return.
    const flapped = { ...rileyNode, note: "edit that Shopify reverted" };
    const flappedPage = pageFetch([flapped]);
    let runB: SyncResult | undefined;
    const zombieFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      runB = await runSync(db, env, WS, {
        fetchImpl: pageFetch([rileyNode]).impl,
        now: () => LATER,
      });
      return flappedPage.impl(input, init);
    }) as typeof fetch;

    const runA = await runSync(db, env, WS, { fetchImpl: zombieFetch, now: () => NOW });

    expect(runB?.updated).toBe(0);
    expect(runB?.updatedOrderIds).toEqual([]);
    expect(runB?.superseded).toBeUndefined();

    // B verified the row as current, so A's stale snapshot must not land and
    // must not be reported.
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect((rows[0].shopify as { note: string }).note).toBe("original note");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(runA.updated).toBe(0);
    expect(runA.updatedOrderIds).toEqual([]);
    expect(runA.superseded).toBe(true);
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(LATER);
  });

  it("a zombie write landing between a newer run's read and its verification cannot stick", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW - 600000,
    });

    // Same flap, tighter interleaving: zombie A's whole write loop runs after
    // run B has read the stored snapshot and before B acts on what it read.
    const flapped = { ...rileyNode, note: "edit that Shopify reverted" };
    const zombie = await parkedZombie(db, env, NOW, [flapped]);
    let runA: SyncResult | undefined;
    const racing = withHookAfterExistenceRead(db, async () => {
      runA = await zombie.finish();
    });
    const runB = await runSync(racing, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => LATER,
    });

    expect(runB.superseded).toBeUndefined();
    expect(runA?.superseded).toBe(true);
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect((rows[0].shopify as { note: string }).note).toBe("original note");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(runA?.updated).toBe(0);
    expect(runA?.updatedOrderIds).toEqual([]);
    expect(runB.updated).toBe(0);
  });

  it("a zombie that wakes during a newer run's existence read inserts nothing", async () => {
    const { db, env } = await makeDb();
    // Nobody has stored the order yet. Zombie A fetched it before an edit,
    // run B after. A's fetch returns after B's existence read (B saw no row);
    // B holds the lease by then, so A stops at its lease check and the
    // insert, the event and the snapshot are all B's.
    const staleUnseen = { ...rileyNode, note: "note before the edit" };
    const freshUnseen = { ...rileyNode, note: "note after the edit" };
    const zombie = await parkedZombie(db, env, NOW, [staleUnseen]);
    let runA: SyncResult | undefined;
    const racing = withHookAfterExistenceRead(db, async () => {
      runA = await zombie.finish();
    });
    const runB = await runSync(racing, env, WS, {
      fetchImpl: pageFetch([freshUnseen]).impl,
      now: () => LATER,
    });

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(runA).toEqual(SUPERSEDED_EMPTY);
    expect((rows[0].shopify as { note: string }).note).toBe("note after the edit");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(runB.error).toBeUndefined();
    expect(runB.superseded).toBeUndefined();
    expect(runB.added).toBe(1);
    expect(runB.addedOrderIds).toEqual([rows[0].id]);
    expect(runB.updated).toBe(0);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("a run whose insert conflicts with a row stored after its existence read still applies its newer snapshot", async () => {
    const { db, env } = await makeDb();
    // Another run stored the order (with an older snapshot) right after this
    // run's existence read: this run's insert is a conflict no-op, so it
    // claims and loads that row and refreshes the snapshot instead.
    await runSync(db, env, WS, {
      fetchImpl: pageFetch([{ ...rileyNode, note: "note before the edit" }]).impl,
      now: () => NOW,
    });
    const result = await runSync(withBlindFirstExistenceRead(db), env, WS, {
      fetchImpl: pageFetch([{ ...rileyNode, note: "note after the edit" }]).impl,
      now: () => LATER,
    });

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(result.error).toBeUndefined();
    expect(result.added).toBe(0);
    expect(result.addedOrderIds).toEqual([]);
    expect(result.updated).toBe(1);
    expect(result.updatedOrderIds).toEqual([rows[0].id]);
    expect((rows[0].shopify as { note: string }).note).toBe("note after the edit");
    expect(rows[0].syncedAt).toBe(LATER);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });

  it("counts a landed snapshot update from the D1 result shape", async () => {
    const { db, env } = await makeDb();
    const d1ish = withD1UpdateResults(db);
    await runSync(d1ish, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });

    const changed = { ...rileyNode, note: "updated note" };
    const result = await runSync(d1ish, env, WS, {
      fetchImpl: pageFetch([changed]).impl,
      now: () => LATER,
    });
    const rows = await ordersIn(db, WS);
    expect(result.updated).toBe(1);
    expect(result.updatedOrderIds).toEqual([rows[0].id]);
    expect((rows[0].shopify as { note: string }).note).toBe("updated note");
  });

  it("releases the lease and records lastError when the post-lease connection re-read throws", async () => {
    const { db, env } = await makeDb();
    const { impl, calls } = pageFetch([rileyNode]);
    // Bare select 1 is the pre-lease read; bare select 2 is the fresh re-read
    // taken right after the lease compare-and-swap succeeds.
    const flaky = withFailingBareSelect(db, 2, "D1_ERROR: transient read failure");

    const result = await runSync(flaky, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe("D1_ERROR: transient read failure");
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.superseded).toBeUndefined();
    expect(calls).toHaveLength(0);

    const connection = await connectionOf(db, WS);
    expect(connection.runningUntil).toBe(0);
    expect(connection.lastError).toBe("D1_ERROR: transient read failure");
    expect(connection.status).toBe("ok");
    expect(connection.lastSyncAt).toBe(0);

    // The lease is free again: the very next tick runs normally.
    const next = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW + 1000,
    });
    expect(next.skipped).toBeUndefined();
    expect(next.added).toBe(1);
  });

  it("clears the lease and records lastError when the write loop throws", async () => {
    const { db, raw, env } = openDb();
    await seedWorkspace(db, WS);
    // Remove the workspace row behind the foreign key's back so the order
    // insert throws mid-loop.
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM workspaces WHERE id = ?").run(WS);
    raw.pragma("foreign_keys = ON");

    const result = await runSync(db, env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW,
    });
    expect(result.error).toBeTruthy();
    expect(result.added).toBe(0);

    const connection = await connectionOf(db, WS);
    expect(connection.runningUntil).toBe(0);
    expect(connection.lastError).toContain("FOREIGN KEY");
    expect(connection.lastSyncAt).toBe(0);
  });

  it("skips while another run holds the lease", async () => {
    const { db, env } = await makeDb();
    await db
      .update(schema.storeConnections)
      .set({ runningUntil: NOW + 60000 })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.skipped).toBe("running");
    expect(result.added).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("reads the lease CAS rows-affected from the D1 result shape too", async () => {
    const { db, env } = await makeDb();
    const d1ish = withD1UpdateResults(db);

    const free = pageFetch([rileyNode]);
    const first = await runSync(d1ish, env, WS, { fetchImpl: free.impl, now: () => NOW });
    expect(first.added).toBe(1);

    await db
      .update(schema.storeConnections)
      .set({ runningUntil: LATER + 60000 })
      .where(eq(schema.storeConnections.workspaceId, WS));
    const blocked = pageFetch([rileyNode]);
    const second = await runSync(d1ish, env, WS, { fetchImpl: blocked.impl, now: () => LATER });
    expect(second.skipped).toBe("running");
    expect(blocked.calls).toHaveLength(0);
  });

  it("skips when the workspace has no connection", async () => {
    const { db, env } = await makeDb({ connection: false });
    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.skipped).toBe("no-connection");
    expect(calls).toHaveLength(0);
  });

  it("skips a disabled connection", async () => {
    const { db, env } = await makeDb({ connectionStatus: "disabled" });
    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.skipped).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  it("marks the connection on auth failure and clears the lease", async () => {
    const { db, env } = await makeDb();
    const { impl } = statusFetch(401);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe(TOKEN_REJECTED);
    expect(result.added).toBe(0);

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("error");
    expect(connection.lastError).toBe(TOKEN_REJECTED);
    expect(connection.runningUntil).toBe(0);
    expect(connection.lastSyncAt).toBe(0);
  });

  it("keeps status and lastSyncAt on a transient failure", async () => {
    const { db, env } = await makeDb();
    const previousSync = NOW - 3600000;
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const { impl } = statusFetch(429);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toContain("429");

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.lastError).toContain("429");
    expect(connection.lastSyncAt).toBe(previousSync);
    expect(connection.runningUntil).toBe(0);
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(0);
  });

  it("treats an unexpected 2xx response shape as transient and keeps lastSyncAt", async () => {
    const { db, env } = await makeDb();
    const previousSync = NOW - 3600000;
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    // statusFetch(200) returns a bare {} body: no data.orders object.
    const { impl } = statusFetch(200);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe("unexpected response shape");

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.lastSyncAt).toBe(previousSync);
    expect(connection.runningUntil).toBe(0);
  });

  it("writes a sync_error event on fatal failure, truncated to 300 chars", async () => {
    const { db, env } = await makeDb();
    const longMessage = "Z".repeat(400);
    const { impl } = errorsFetch([{ message: longMessage }]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe(longMessage);

    const syncErrors = await eventsIn(db, WS, "sync_error");
    expect(syncErrors).toHaveLength(1);
    expect(syncErrors[0].text).toBe("Z".repeat(300));
    expect(syncErrors[0].orderId).toBeNull();
    expect(syncErrors[0].source).toBe("system");
    const connection = await connectionOf(db, WS);
    expect(connection.lastError).toBe("Z".repeat(300));
    expect(connection.lastSyncAt).toBe(0);
    expect(connection.runningUntil).toBe(0);
  });

  it("writes a sync_error event only when the fatal detail changes", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW,
    });
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW + 1000,
    });
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(1);

    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "different failure" }]).impl,
      now: () => NOW + 2000,
    });
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(2);
  });

  it("does not repeat a sync_error event when the same fatal recurs after transient blips", async () => {
    const { db, env } = await makeDb();
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW,
    });
    // A transient blip rewrites lastError in between.
    await runSync(db, env, WS, { fetchImpl: statusFetch(503).impl, now: () => NOW + 600000 });
    await runSync(db, env, WS, {
      fetchImpl: errorsFetch([{ message: "schema mismatch" }]).impl,
      now: () => NOW + 1200000,
    });
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(1);
  });

  it("caps alternating fatal texts at one event each per hour", async () => {
    const { db, env } = await makeDb();
    const failWith = (message: string, at: number) =>
      runSync(db, env, WS, { fetchImpl: errorsFetch([{ message }]).impl, now: () => at });

    await failWith("failure alpha", NOW);
    await failWith("failure beta", NOW + 600000);
    await failWith("failure alpha", NOW + 1200000);
    await failWith("failure beta", NOW + 1800000);
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(2);

    // Over an hour after the first alpha event, alpha may be recorded again.
    await failWith("failure alpha", NOW + 3700000);
    expect(await eventsIn(db, WS, "sync_error")).toHaveLength(3);
  });

  it("marks the connection when the token cannot be decrypted", async () => {
    const { db, env } = await makeDb({
      encryptedToken: await encryptSecret(FAKE_TOKEN, TEST_KEY, "ws_other"),
    });
    const { impl, calls } = pageFetch([rileyNode]);
    const result = await runSync(db, env, WS, { fetchImpl: impl, now: () => NOW });
    expect(result.error).toBe(TOKEN_UNREADABLE);
    expect(calls).toHaveLength(0);

    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("error");
    expect(connection.lastError).toBe(TOKEN_UNREADABLE);
    expect(connection.runningUntil).toBe(0);
  });

  it("uses a 60 day window on first sync and a 5 minute overlap after", async () => {
    const { db, env } = await makeDb();

    const first = pageFetch([]);
    await runSync(db, env, WS, { fetchImpl: first.impl, now: () => NOW });
    const firstWindow = new Date(NOW - SIXTY_DAYS_MS).toISOString();
    expect(first.calls[0].body.variables?.search).toBe(`updated_at:>='${firstWindow}'`);

    const second = pageFetch([]);
    await runSync(db, env, WS, { fetchImpl: second.impl, now: () => LATER });
    const overlapWindow = new Date(NOW - OVERLAP_MS).toISOString();
    expect(second.calls[0].body.variables?.search).toBe(`updated_at:>='${overlapWindow}'`);
  });

  it("drains a dense same-second cluster past the page cap via cursor resumption", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    // 600 orders bulk-updated on the same second, plus one genuinely new
    // order ten minutes later. The watermark approach livelocks here.
    const dataset: SimOrder[] = [];
    for (let i = 1; i <= 600; i++) {
      dataset.push({ idNum: i, updatedAtMs: T });
    }
    dataset.push({ idNum: 9999, updatedAtMs: T + 600000 });
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: T - 3600000 })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    let totalAdded = 0;
    for (let tick = 1; tick <= 3; tick++) {
      const result = await runSync(db, env, WS, {
        fetchImpl: sim.impl,
        now: () => T + (10 + tick * 10) * 60000,
      });
      expect(result.error).toBeUndefined();
      totalAdded += result.added;
    }

    expect(totalAdded).toBe(601);
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(601);
    expect(rows.some((o) => o.shopifyOrderId === "9999")).toBe(true);
    const connection = await connectionOf(db, WS);
    expect(connection.status).toBe("ok");
    expect(connection.syncCursor).toBeNull();
    expect(connection.syncCursorSince).toBeNull();
  });

  it("persists the cursor on truncation and leaves lastSyncAt untouched", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 620 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 60000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const r1 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 700 * 60000 });
    expect(r1.added).toBe(500);
    const afterTruncated = await connectionOf(db, WS);
    // The cursor is stored together with the run start of the tick that
    // opened the chain, in one value, so the two cannot come apart.
    expect(afterTruncated.syncCursor).toBe(chainToken(T + 700 * 60000, "idx:500"));
    expect(afterTruncated.syncCursorSince).toBe(previousSync - OVERLAP_MS);
    expect(afterTruncated.lastSyncAt).toBe(previousSync);
    expect(afterTruncated.status).toBe("ok");

    // The continuation reuses the persisted window, not a fresh one.
    const r2 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 701 * 60000 });
    expect(r2.added).toBe(120);
    const afterComplete = await connectionOf(db, WS);
    expect(afterComplete.syncCursor).toBeNull();
    expect(afterComplete.syncCursorSince).toBeNull();
    // A completed continuation anchors at the now of the tick that opened the
    // chain, not at the finishing tick's now and not at the chain watermark:
    // the next window (anchor minus overlap) must start before the chain did,
    // or orders the search index surfaced behind the cursor are never read.
    expect(afterComplete.lastSyncAt).toBe(T + 700 * 60000);
    expect(await ordersIn(db, WS)).toHaveLength(620);
  });

  it("never regresses lastSyncAt by more than the overlap and keeps every order", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    // A burst of 550 orders inside the overlap window just behind lastSyncAt.
    const dataset: SimOrder[] = Array.from({ length: 550 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T - 240000 + Math.floor((i + 1) / 3) * 1000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: T })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    let lastResult;
    for (let tick = 1; tick <= 4; tick++) {
      const before = (await connectionOf(db, WS)).lastSyncAt;
      lastResult = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + tick * 600000 });
      expect(lastResult.error).toBeUndefined();
      const after = (await connectionOf(db, WS)).lastSyncAt;
      expect(after).toBeGreaterThanOrEqual(before - OVERLAP_MS);
    }
    expect(await ordersIn(db, WS)).toHaveLength(550);
    expect(lastResult?.added).toBe(0);
  });

  it("settles to one cheap fetch per tick on an idle shop after draining a dense burst", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    // 550 orders bulk-updated in the same moment: more than one run's page cap.
    const dataset: SimOrder[] = Array.from({ length: 550 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: T - 3600000 })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const tickAt = (tick: number) => T + tick * 600000;

    // Tick 1 stops at the page cap and persists the cursor; tick 2 resumes
    // from it and completes the window.
    const r1 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(1) });
    expect(r1.added).toBe(500);
    expect((await connectionOf(db, WS)).syncCursor).toBe(chainToken(tickAt(1), "idx:500"));
    const r2 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(2) });
    expect(r2.added).toBe(50);
    expect(await ordersIn(db, WS)).toHaveLength(550);

    // The shop is now idle. Every further tick must be a single non-truncated
    // request that adds nothing and persists no cursor, never a re-fetch of
    // the burst.
    for (let tick = 3; tick <= 7; tick++) {
      const requestsBefore = sim.count();
      const result = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(tick) });
      expect(result.error).toBeUndefined();
      expect(sim.count() - requestsBefore).toBe(1);
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      const connection = await connectionOf(db, WS);
      expect(connection.syncCursor).toBeNull();
      expect(connection.syncCursorSince).toBeNull();
      expect(connection.lastSyncAt).toBe(tickAt(tick));
    }
    expect(await ordersIn(db, WS)).toHaveLength(550);
  });

  it("carries the chain start unchanged through a multi-tick chain and anchors there", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 1100 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 1000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const tickAt = (tick: number) => T + 3600000 + tick * 600000;

    await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(1) });
    const afterOpen = await connectionOf(db, WS);
    expect(afterOpen.syncCursor).toBe(chainToken(tickAt(1), "idx:500"));

    // Still truncated: the cursor advances, the window and the chain start
    // stay exactly as the opening tick wrote them.
    await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(2) });
    const afterMiddle = await connectionOf(db, WS);
    expect(afterMiddle.syncCursor).toBe(chainToken(tickAt(1), "idx:1000"));
    expect(afterMiddle.syncCursorSince).toBe(previousSync - OVERLAP_MS);
    expect(afterMiddle.lastSyncAt).toBe(previousSync);

    await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => tickAt(3) });
    const afterComplete = await connectionOf(db, WS);
    expect(afterComplete.syncCursor).toBeNull();
    expect(afterComplete.syncCursorSince).toBeNull();
    expect(afterComplete.lastSyncAt).toBe(tickAt(1));
    expect(await ordersIn(db, WS)).toHaveLength(1100);
  });

  it("re-covers an order the search index surfaced behind a persisted cursor", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    // 600 orders created by one bulk action in the same second. Order 300
    // reaches the updated_at search index 90 seconds late.
    const dataset: LaggyOrder[] = Array.from({ length: 600 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T,
      ...(i + 1 === 300 ? { visibleAtMs: T + 90000 } : {}),
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: T - 3600000 })
      .where(eq(schema.storeConnections.workspaceId, WS));

    let clock = 0;
    const sim = laggyShopifySim(dataset, () => clock);
    const tick = async (at: number) => {
      clock = at;
      const before = sim.count();
      const result = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => at });
      expect(result.error).toBeUndefined();
      return { result, requests: sim.count() - before };
    };
    const tickAt = (n: number) => T + 60000 + (n - 1) * 600000;

    // Tick 1 lands 60 seconds into the burst: order 300 is not searchable
    // yet, so the page cap falls after order 501 and the persisted cursor
    // already sits past order 300's sort position.
    const t1 = await tick(tickAt(1));
    expect(t1.result.added).toBe(500);
    expect((await ordersIn(db, WS)).some((o) => o.shopifyOrderId === "300")).toBe(false);

    // Tick 2 resumes from the cursor and finishes the chain without ever
    // seeing order 300. The chain anchors at tick 1's now, so tick 3's window
    // still starts before the burst.
    const t2 = await tick(tickAt(2));
    expect(t2.result.added).toBe(99);
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(tickAt(1));

    // Ticks 3 and 4 are the one bounded re-scan that picks the straggler up:
    // a full run of pages up to the cap, then the pages holding the last 100.
    const t3 = await tick(tickAt(3));
    expect(t3.result.added).toBe(1);
    expect(t3.requests).toBe(MAX_PAGES);
    const t4 = await tick(tickAt(4));
    expect(t4.result.added).toBe(0);
    expect(t4.requests).toBe(100 / ORDERS_PER_PAGE);
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(tickAt(3));

    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(600);
    expect(rows.some((o) => o.shopifyOrderId === "300")).toBe(true);

    // After that the shop is idle and every tick is one cheap request again.
    for (let n = 5; n <= 7; n++) {
      const idle = await tick(tickAt(n));
      expect(idle.requests).toBe(1);
      expect(idle.result.added).toBe(0);
      expect(idle.result.updated).toBe(0);
      const connection = await connectionOf(db, WS);
      expect(connection.syncCursor).toBeNull();
      expect(connection.syncCursorSince).toBeNull();
      expect(connection.lastSyncAt).toBe(tickAt(n));
    }
    expect(await ordersIn(db, WS)).toHaveLength(600);
  });

  it("moves nothing when the first page reports more pages without a cursor", async () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const cursorless = (updatedAtMs: number) =>
      scriptedFetch([
        {
          nodes: [{ ...rileyNode, updatedAt: iso(updatedAtMs) }],
          hasNextPage: true,
          endCursor: null,
        },
      ]);
    const NO_CURSOR = "Shopify reported more pages but returned no cursor";

    // Fresh window. Whether the gathered node's updatedAt lies behind the
    // run's now or ahead of it (an order edited while the fetch was in
    // flight) makes no difference: no node-derived watermark anchors
    // anything, the window is retried as it was.
    for (const nodeUpdatedAt of [NOW - 120000, NOW + 30000]) {
      const fresh = await makeDb();
      const previousSync = NOW - 3600000;
      await fresh.db
        .update(schema.storeConnections)
        .set({ lastSyncAt: previousSync })
        .where(eq(schema.storeConnections.workspaceId, WS));
      const result = await runSync(fresh.db, fresh.env, WS, {
        fetchImpl: cursorless(nodeUpdatedAt).impl,
        now: () => NOW,
      });
      expect(result.error).toBe(NO_CURSOR);
      const connection = await connectionOf(fresh.db, WS);
      expect(connection.lastSyncAt).toBe(previousSync);
      expect(connection.syncCursor).toBeNull();
      expect(connection.syncCursorSince).toBeNull();
      expect(connection.lastError).toBe(NO_CURSOR);
      expect(connection.status).toBe("ok");
      expect(connection.runningUntil).toBe(0);
    }

    // Resumed chain whose next page comes back cursorless: the chain stays
    // exactly as the opening tick left it, so the next tick retries from the
    // same cursor, and the failure is on record instead of passing for
    // progress.
    const resumed = await makeDb();
    const chainStart = NOW - 600000;
    const token = chainToken(chainStart, "cursor-from-opening-tick");
    await resumed.db
      .update(schema.storeConnections)
      .set({
        lastSyncAt: chainStart - 600000,
        syncCursor: token,
        syncCursorSince: chainStart - 600000 - OVERLAP_MS,
      })
      .where(eq(schema.storeConnections.workspaceId, WS));
    const page = cursorless(chainStart + 240000);
    const result = await runSync(resumed.db, resumed.env, WS, {
      fetchImpl: page.impl,
      now: () => NOW,
    });
    expect(page.calls[0].body.variables?.cursor).toBe("cursor-from-opening-tick");
    expect(result.error).toBe(NO_CURSOR);
    const connection = await connectionOf(resumed.db, WS);
    expect(connection.lastSyncAt).toBe(chainStart - 600000);
    expect(connection.syncCursor).toBe(token);
    expect(connection.syncCursorSince).toBe(chainStart - 600000 - OVERLAP_MS);
    expect(connection.lastError).toBe(NO_CURSOR);
    expect(connection.runningUntil).toBe(0);
  });

  it("loses no order when a cursorless first page carries a node edited seconds ago", async () => {
    const { db, env } = await makeDb();
    const T0 = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T0 - 3600000;
    // 60 orders, 40 to 50 minutes old. Order 1 was edited again ten seconds
    // before the tick and the search index needs two minutes to catch up, so
    // it still sorts at its old position while its node already carries the
    // new updatedAt.
    const dataset: LaggyOrder[] = Array.from({ length: 60 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T0 - 3000000 + (i + 1) * 10000,
      ...(i === 0 ? { editedAtMs: T0 - 10000, reindexedAtMs: T0 + 110000 } : {}),
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    let clock = 0;
    // The very first request is answered with hasNextPage true, no endCursor.
    const sim = laggyShopifySim(dataset, () => clock, { cursorless: (request) => request === 1 });
    const tick = async (at: number) => {
      clock = at;
      return runSync(db, env, WS, { fetchImpl: sim.impl, now: () => at });
    };

    // The freshly edited node says "updated ten seconds ago", but it vouches
    // for nothing behind the missing cursor: lastSyncAt must stay put.
    const t1 = await tick(T0);
    const afterFault = await connectionOf(db, WS);
    expect.soft(afterFault.lastSyncAt).toBe(previousSync);
    expect.soft(afterFault.syncCursor).toBeNull();
    expect.soft(t1.error).toBe("Shopify reported more pages but returned no cursor");
    expect.soft(afterFault.lastError).toBe("Shopify reported more pages but returned no cursor");

    for (let n = 1; n <= 4; n++) {
      const result = await tick(T0 + n * 600000);
      expect.soft(result.error).toBeUndefined();
    }
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(60);
    // Orders 51 to 60 are the ones a window anchored on the fresh node's
    // updatedAt never came back for.
    for (let id = 51; id <= 60; id++) {
      expect(rows.some((o) => o.shopifyOrderId === String(id))).toBe(true);
    }
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(T0 + 4 * 600000);
  });

  it("resumes from the cursor it last used when a later page comes back cursorless", async () => {
    const { db, env } = await makeDb();
    const T0 = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T0 - 3600000;
    // 120 orders, 40 to 50 minutes old, order 1 freshly edited with the index
    // lagging as above. This time the second request is the cursorless one.
    const dataset: LaggyOrder[] = Array.from({ length: 120 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T0 - 3000000 + (i + 1) * 5000,
      ...(i === 0 ? { editedAtMs: T0 - 10000, reindexedAtMs: T0 + 110000 } : {}),
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    let clock = 0;
    const sim = laggyShopifySim(dataset, () => clock, { cursorless: (request) => request === 2 });
    const tick = async (at: number) => {
      clock = at;
      return runSync(db, env, WS, { fetchImpl: sim.impl, now: () => at });
    };

    // Tick 1 keeps both pages it read and opens a chain at the cursor the
    // cursorless request was sent with; lastSyncAt does not move.
    const t1 = await tick(T0);
    expect.soft(t1.error).toBeUndefined();
    const resumeFrom = sim.cursors()[1];
    expect.soft(typeof resumeFrom).toBe("string");
    const afterFault = await connectionOf(db, WS);
    expect.soft(afterFault.lastSyncAt).toBe(previousSync);
    expect.soft(afterFault.syncCursor).toBe(chainToken(T0, String(resumeFrom)));
    expect.soft(afterFault.syncCursorSince).toBe(previousSync - OVERLAP_MS);
    expect.soft(afterFault.lastError).toBeNull();

    // Tick 2 resumes at that keyset position and drains the window.
    const requestsBefore = sim.count();
    const t2 = await tick(T0 + 600000);
    expect.soft(t2.error).toBeUndefined();
    expect.soft(sim.cursors()[requestsBefore]).toBe(resumeFrom);
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(120);
    const afterChain = await connectionOf(db, WS);
    expect(afterChain.syncCursor).toBeNull();
    expect(afterChain.syncCursorSince).toBeNull();
    expect(afterChain.lastSyncAt).toBe(T0);
  });

  it("keeps what a throttled run gathered and drains a backlog across ticks", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 120 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 1000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    // The shop's rate bucket serves two requests per tick, then throttles.
    const bucket = throttledAfter(shopifySim(dataset).impl, 2);
    const tickAt = (n: number) => T + n * 600000;
    const tick = async (n: number) => {
      bucket.refill();
      return runSync(db, env, WS, { fetchImpl: bucket.impl, now: () => tickAt(n) });
    };

    // Tick 1 is throttled on its third request. The two pages it read are
    // stored and the chain resumes behind them; a throttle after progress is
    // flow control, not an error.
    const t1 = await tick(1);
    expect(t1.error).toBeUndefined();
    expect(t1.added).toBe(2 * ORDERS_PER_PAGE);
    const afterFirst = await connectionOf(db, WS);
    expect(afterFirst.syncCursor).toBe(chainToken(tickAt(1), `idx:${2 * ORDERS_PER_PAGE}`));
    expect(afterFirst.syncCursorSince).toBe(previousSync - OVERLAP_MS);
    expect(afterFirst.lastSyncAt).toBe(previousSync);
    expect(afterFirst.lastError).toBeNull();
    expect(afterFirst.status).toBe("ok");

    // Every further tick gets the same two requests and moves the chain on
    // until the window is drained.
    let ticks = 1;
    while ((await connectionOf(db, WS)).syncCursor !== null && ticks < 40) {
      ticks++;
      const result = await tick(ticks);
      expect(result.error).toBeUndefined();
      expect(result.added).toBe(2 * ORDERS_PER_PAGE);
    }
    expect(ticks).toBe(120 / (2 * ORDERS_PER_PAGE));
    expect(await ordersIn(db, WS)).toHaveLength(120);
    const drained = await connectionOf(db, WS);
    expect(drained.syncCursorSince).toBeNull();
    expect(drained.lastSyncAt).toBe(tickAt(1));
  });

  it("still reports a throttle that hits before a run has read anything", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const dataset: SimOrder[] = Array.from({ length: 20 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 1000,
    }));
    const chainStart = T + 600000;
    const token = chainToken(chainStart, `idx:${2 * ORDERS_PER_PAGE}`);
    await db
      .update(schema.storeConnections)
      .set({
        lastSyncAt: T - 3600000,
        syncCursor: token,
        syncCursorSince: T - 3600000 - OVERLAP_MS,
      })
      .where(eq(schema.storeConnections.workspaceId, WS));

    // An empty bucket: even the first request of the tick is throttled.
    const bucket = throttledAfter(shopifySim(dataset).impl, 0);
    const result = await runSync(db, env, WS, {
      fetchImpl: bucket.impl,
      now: () => T + 1200000,
    });
    expect(result.error).toBe("Shopify throttled the request");
    const connection = await connectionOf(db, WS);
    expect(connection.lastError).toBe("Shopify throttled the request");
    expect(connection.syncCursor).toBe(token);
    expect(connection.syncCursorSince).toBe(T - 3600000 - OVERLAP_MS);
    expect(connection.lastSyncAt).toBe(T - 3600000);
    expect(connection.runningUntil).toBe(0);
  });

  it("re-scans the window when a persisted cursor carries no chain start", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 60 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 1000,
    }));
    // A bare cursor, the way a row looked before the chain start was stored
    // alongside it.
    await db
      .update(schema.storeConnections)
      .set({
        lastSyncAt: previousSync,
        syncCursor: "idx:50",
        syncCursorSince: previousSync - OVERLAP_MS,
      })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const r1 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 600000 });
    expect(r1.added).toBe(10);
    // Without a known chain start the only safe anchor is the untouched
    // lastSyncAt: the next tick re-reads the whole window once.
    const afterResume = await connectionOf(db, WS);
    expect(afterResume.lastSyncAt).toBe(previousSync);
    expect(afterResume.syncCursor).toBeNull();

    const r2 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 1200000 });
    expect(r2.added).toBe(50);
    expect(await ordersIn(db, WS)).toHaveLength(60);
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(T + 1200000);
  });

  it("treats a chain start later than the finishing run's own clock as unknown", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 60 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 1000,
    }));
    // No tick can have opened a chain a day from now. A stored value like
    // that must never be allowed to carry lastSyncAt into the future, where
    // the next window would start after orders nobody has read.
    await db
      .update(schema.storeConnections)
      .set({
        lastSyncAt: previousSync,
        syncCursor: chainToken(T + 86400000, "idx:50"),
        syncCursorSince: previousSync - OVERLAP_MS,
      })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const r1 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 600000 });
    expect(r1.error).toBeUndefined();
    expect(r1.added).toBe(10);
    const afterResume = await connectionOf(db, WS);
    expect(afterResume.lastSyncAt).toBe(previousSync);
    expect(afterResume.syncCursor).toBeNull();

    const r2 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 1200000 });
    expect(r2.added).toBe(50);
    expect(await ordersIn(db, WS)).toHaveLength(60);
    expect((await connectionOf(db, WS)).lastSyncAt).toBe(T + 1200000);
  });

  it("runs a whole cursor chain on the schema as of migration 0011", async () => {
    // The sync engine reads and writes whole store_connections rows (and
    // writes events.source), so a column it needs from a migration that has
    // not been applied yet fails every run. This pins that the engine needs
    // nothing newer than 0011. Raised from 0003 by the platform phase (0004),
    // then by Phase 6 (0007: drizzle names orders.notified_at in every order
    // insert), then by the order history import (0008: runSync selects the
    // whole store_connections row, backfill columns included), then by draft
    // orders (0010: every order insert names the draft columns and runSync
    // reads the draft cursor columns), then by the work queue (0011: every
    // statuses insert names statuses.closed and every workspace_settings
    // insert names the age and price columns; the engine itself reads
    // neither). DEPLOY NOTE, run `npm run db:migrate:remote` (applies 0011)
    // BEFORE the code that needs it reaches production. Raise the number
    // again only together with a deploy note like this one.
    const { db, env } = openDb({ through: "0011" });
    await seedWorkspace(db, WS);
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 620 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 60000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const sim = shopifySim(dataset);
    const r1 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 700 * 60000 });
    expect(r1.error).toBeUndefined();
    expect(r1.added).toBe(500);
    expect((await connectionOf(db, WS)).syncCursor).toBe(chainToken(T + 700 * 60000, "idx:500"));

    const r2 = await runSync(db, env, WS, { fetchImpl: sim.impl, now: () => T + 701 * 60000 });
    expect(r2.error).toBeUndefined();
    expect(r2.added).toBe(120);
    const afterComplete = await connectionOf(db, WS);
    expect(afterComplete.syncCursor).toBeNull();
    expect(afterComplete.lastSyncAt).toBe(T + 700 * 60000);
    expect(await ordersIn(db, WS)).toHaveLength(620);
  });

  it("recovers when Shopify rejects a persisted cursor", async () => {
    const { db, env } = await makeDb();
    const T = Date.parse("2026-09-25T12:00:00.000Z");
    const previousSync = T - 3600000;
    const dataset: SimOrder[] = Array.from({ length: 620 }, (_, i) => ({
      idNum: i + 1,
      updatedAtMs: T + (i + 1) * 60000,
    }));
    await db
      .update(schema.storeConnections)
      .set({ lastSyncAt: previousSync })
      .where(eq(schema.storeConnections.workspaceId, WS));

    const honest = shopifySim(dataset);
    const r1 = await runSync(db, env, WS, { fetchImpl: honest.impl, now: () => T + 700 * 60000 });
    expect(r1.added).toBe(500);
    expect((await connectionOf(db, WS)).syncCursor).toBe(chainToken(T + 700 * 60000, "idx:500"));

    // The persisted cursor has gone stale: Shopify rejects it (fatal).
    const rejecting = shopifySim(dataset, { rejectCursors: true });
    const r2 = await runSync(db, env, WS, { fetchImpl: rejecting.impl, now: () => T + 701 * 60000 });
    expect(r2.error).toContain("cursor");
    // The rejected cursor is the Shopify cursor alone, without the chain
    // start it is stored with.
    expect(r2.error).toBe("cursor idx:500 is invalid");
    const afterReject = await connectionOf(db, WS);
    expect(afterReject.syncCursor).toBeNull();
    expect(afterReject.syncCursorSince).toBeNull();
    expect(afterReject.lastError).toContain("cursor");
    expect(afterReject.lastSyncAt).toBe(previousSync);

    // Next ticks fall back to the plain window path and still drain the rest.
    await runSync(db, env, WS, { fetchImpl: honest.impl, now: () => T + 702 * 60000 });
    await runSync(db, env, WS, { fetchImpl: honest.impl, now: () => T + 703 * 60000 });
    expect(await ordersIn(db, WS)).toHaveLength(620);
    expect((await connectionOf(db, WS)).syncCursor).toBeNull();
  });

  it("keeps a full existence chunk within the D1 bound-parameter limit", () => {
    const { db } = openDb();
    expect(EXISTENCE_CHUNK).toBe(50);
    const chunk = Array.from({ length: EXISTENCE_CHUNK }, (_, i) => String(9000 + i));
    const query = db
      .select({
        id: schema.orders.id,
        shopifyOrderId: schema.orders.shopifyOrderId,
        shopify: schema.orders.shopify,
      })
      .from(schema.orders)
      .where(
        and(eq(schema.orders.workspaceId, WS), inArray(schema.orders.shopifyOrderId, chunk)),
      );
    const bound = query.toSQL().params.length;
    expect(bound).toBe(EXISTENCE_CHUNK + 1);
    expect(bound).toBeLessThanOrEqual(100);

    // The claim that precedes each existence read binds the new synced_at,
    // the workspace, the chunk ids and the guard value.
    const claim = db
      .update(schema.orders)
      .set({ syncedAt: NOW })
      .where(
        and(
          eq(schema.orders.workspaceId, WS),
          inArray(schema.orders.shopifyOrderId, chunk),
          lt(schema.orders.syncedAt, NOW),
        ),
      );
    const claimBound = claim.toSQL().params.length;
    expect(claimBound).toBe(EXISTENCE_CHUNK + 3);
    expect(claimBound).toBeLessThanOrEqual(100);
  });

  it("falls back to status key new when the workspace has no statuses", async () => {
    const { db, env } = await makeDb({ statuses: false });
    await runSync(db, env, WS, { fetchImpl: pageFetch([rileyNode]).impl, now: () => NOW });
    const rows = await ordersIn(db, WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].statusKey).toBe("new");
  });

  it("handles batches larger than one existence-query chunk", async () => {
    const { db, env } = await makeDb();
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      id: `gid://shopify/Order/${8000 + i}`,
      legacyResourceId: String(8000 + i),
      name: `#8${String(i).padStart(3, "0")}`,
      tags: [],
      lineItems: { nodes: [] },
    }));

    const r1 = await runSync(db, env, WS, { fetchImpl: pageFetch(nodes).impl, now: () => NOW });
    expect(r1.added).toBe(120);
    const r2 = await runSync(db, env, WS, { fetchImpl: pageFetch(nodes).impl, now: () => LATER });
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(0);
    expect(await ordersIn(db, WS)).toHaveLength(120);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(120);
  });

  it("runs the insert pair through a shimmed db.batch in-flow", async () => {
    const { db, env } = await makeDb();
    const batched: unknown[][] = [];
    const result = await runSync(withBatch(db, batched), env, WS, {
      fetchImpl: pageFetch([rileyNode]).impl,
      now: () => NOW,
    });
    expect(result.added).toBe(1);
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    expect(await ordersIn(db, WS)).toHaveLength(1);
    expect(await eventsIn(db, WS, "order_new")).toHaveLength(1);
  });
});

describe("applyPair", () => {
  it("routes both statements through db.batch without awaiting them individually", async () => {
    const batch = vi.fn(async () => ["order-result", "event-result"]);
    const a = { then: vi.fn() };
    const b = { then: vi.fn() };
    const results = await applyPair(
      { batch } as unknown as Db,
      a as unknown as PromiseLike<unknown>,
      b as unknown as PromiseLike<unknown>,
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith([a, b]);
    expect(a.then).not.toHaveBeenCalled();
    expect(b.then).not.toHaveBeenCalled();
    expect(results).toEqual(["order-result", "event-result"]);
  });

  it("awaits the statements in order and returns their results when batch is unavailable", async () => {
    const executed: string[] = [];
    const statement = (name: string) =>
      ({
        then: (resolve: (value: unknown) => void) => {
          executed.push(name);
          resolve(`${name}-result`);
        },
      }) as PromiseLike<unknown>;
    const results = await applyPair({} as Db, statement("order"), statement("event"));
    expect(executed).toEqual(["order", "event"]);
    expect(results).toEqual(["order-result", "event-result"]);
  });
});

describe("runAllSyncs", () => {
  it("syncs every enabled connection and isolates one workspace's failure", async () => {
    const { db, raw, env } = openDb();
    await seedWorkspace(db, "ws_a");
    await seedWorkspace(db, "ws_b");
    await seedWorkspace(db, "ws_c", { connectionStatus: "disabled" });

    // Break ws_a behind the foreign key's back: deleting its workspace row
    // makes the order insert inside runSync fail, which must not stop ws_b.
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM workspaces WHERE id = 'ws_a'").run();
    raw.pragma("foreign_keys = ON");

    const { impl, calls } = pageFetch([rileyNode]);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      await runAllSyncs(db, env, { fetchImpl: impl, now: () => NOW });
    } finally {
      spy.mockRestore();
    }

    expect(await ordersIn(db, "ws_b")).toHaveLength(1);
    expect(await ordersIn(db, "ws_a")).toHaveLength(0);
    // One orders request per enabled connection (the cron also asks each
    // store for its tagged customers, which this stub does not serve).
    expect(calls.filter((call) => String(call.body.query).includes("orders(first:"))).toHaveLength(2);

    const joined = logged.join("\n");
    expect(joined).toContain("ws_a");
    expect(joined).toContain("ws_b");
    expect(joined).not.toContain("ws_c");
    expect(joined).not.toContain(FAKE_TOKEN);
  });
});

// Seeded fuzz of the whole engine against a Shopify whose updated_at search
// index lags behind the primary store. Orders are created and edited over
// time; each change reaches the index up to MAX_INDEX_LAG_MS later, while
// nodes are always hydrated fresh, so a node's updatedAt can be ahead of its
// sort position. Requests take time, and while the shop is active they fail
// in every way the client distinguishes: more pages without a cursor,
// throttles, 5xx, timeouts, rejected cursors. Once the shop goes quiet the
// engine must converge: every order stored, every snapshot at its latest
// version. The lag bound sits below the 5 minute overlap on purpose; that
// overlap is the engine's whole allowance for late-surfacing orders.
type FuzzVersion = { at: number; indexedAt: number };
type FuzzOrder = { idNum: number; versions: FuzzVersion[] };

const MAX_INDEX_LAG_MS = 240000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FuzzFaults = { cursorless: number; throttle: number; http503: number; timeout: number; reject: number };

function fuzzShopify(
  orders: FuzzOrder[],
  clock: { now: number },
  rng: () => number,
  faults: () => FuzzFaults | null,
) {
  const graphqlError = (error: Record<string, unknown>) =>
    new Response(JSON.stringify({ errors: [error] }), { status: 200 });
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    // Every request takes between 0.1 and 1 second of shop time.
    clock.now += 100 + Math.floor(rng() * 900);
    const at = clock.now;
    const request = simRequest(init);
    const vars = request.variables;
    const active = faults();
    let cursorless = false;
    if (active) {
      const roll = rng();
      let edge = active.throttle;
      if (roll < edge) {
        return graphqlError({ message: "Throttled", extensions: { code: "THROTTLED" } });
      }
      edge += active.http503;
      if (roll < edge) {
        return new Response("{}", { status: 503 });
      }
      edge += active.timeout;
      if (roll < edge) {
        throw new DOMException("The operation timed out", "TimeoutError");
      }
      edge += active.reject;
      if (roll < edge && vars.cursor !== null) {
        return graphqlError({ message: "Invalid cursor for current pagination sort" });
      }
      edge += active.cursorless;
      cursorless = roll < edge;
    }
    // What the index knows of an order: its newest change that has been
    // indexed by now. What the primary store knows: its newest change.
    const indexedKey = (o: FuzzOrder) => {
      let key: number | null = null;
      for (const v of o.versions) {
        if (v.indexedAt <= at) {
          key = v.at;
        }
      }
      return key;
    };
    const primaryVersion = (o: FuzzOrder) => {
      let version = -1;
      o.versions.forEach((v, i) => {
        if (v.at <= at) {
          version = i;
        }
      });
      return version;
    };
    const sinceMs = Date.parse(vars.search.match(/'(.*)'/)![1]);
    const after = vars.cursor ? vars.cursor.split(":").slice(1).map(Number) : null;
    const remaining = orders
      .map((o) => ({ o, key: indexedKey(o) }))
      .filter((x): x is { o: FuzzOrder; key: number } => x.key !== null && x.key >= sinceMs)
      .filter(
        (x) =>
          after === null || x.key > after[0] || (x.key === after[0] && x.o.idNum > after[1]),
      )
      .sort((a, b) => a.key - b.key || a.o.idNum - b.o.idNum);
    const page = remaining.slice(0, requestedPageSize(request));
    const last = page[page.length - 1];
    const hasNextPage = remaining.length > page.length;
    const nodes = page.map(({ o }) => {
      const version = primaryVersion(o);
      return {
        id: `gid://shopify/Order/${o.idNum}`,
        legacyResourceId: String(o.idNum),
        name: `#${o.idNum}`,
        createdAt: new Date(o.versions[0].at).toISOString(),
        updatedAt: new Date(o.versions[version].at).toISOString(),
        note: `v${version}`,
        tags: [],
        lineItems: { nodes: [] },
      };
    });
    const endCursor =
      cursorless && hasNextPage ? null : last ? `key:${last.key}:${last.o.idNum}` : vars.cursor;
    return new Response(
      JSON.stringify({ data: { orders: { nodes, pageInfo: { hasNextPage, endCursor } } } }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl };
}

describe("runSync against a lagging search index (seeded fuzz)", () => {
  // The default set is seeds 1 to 24 plus the seeds that lost orders (up to
  // 455 in one run, silently) while a truncation without a cursor still
  // anchored lastSyncAt on the newest updatedAt it had gathered; seed 23 is
  // one of those too. SYNC_FUZZ_SEEDS=n soaks seeds 1 to n instead.
  const soak = Number(process.env.SYNC_FUZZ_SEEDS ?? 0);
  const seeds =
    soak > 0
      ? Array.from({ length: soak }, (_, i) => i + 1)
      : [...Array.from({ length: 24 }, (_, i) => i + 1), 66, 90, 111, 158, 165, 226, 230, 258, 282, 287];
  for (const seed of seeds) {
    it(`converges on every order and every latest snapshot, seed ${seed}`, async () => {
      const rng = mulberry32(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
      const T0 = Date.parse("2026-09-25T12:00:00.000Z");
      const TICK_MS = 600000;
      const ACTIVE_TICKS = 12;

      const orders: FuzzOrder[] = [];
      const change = (o: FuzzOrder, at: number) => {
        o.versions.push({ at, indexedAt: at + int(0, MAX_INDEX_LAG_MS) });
      };
      // Half the seeds start as a first sync (60 day window), the others
      // from an earlier sync an hour to a day back.
      const lastSyncAt = int(0, 1) === 0 ? 0 : T0 - 3600000 - int(0, 86400000);
      // A backlog the first tick has to pick up, all of it inside the first
      // window: usually small, sometimes larger than one run can drain.
      const oldest = lastSyncAt === 0 ? T0 - 40 * 86400000 : lastSyncAt;
      const backlog = int(0, 3) === 0 ? int(450, 700) : int(0, 80);
      for (let i = 0; i < backlog; i++) {
        const o: FuzzOrder = { idNum: orders.length + 1, versions: [] };
        change(o, int(oldest, T0 - 600000));
        orders.push(o);
      }
      // What happens while the ticks run, in time order: new orders and
      // edits at random moments, edits that land seconds before a tick (so
      // the tick sees a fresh node at a stale sort position), and now and
      // then a bulk edit that touches many orders in the same second.
      type FuzzEvent = { at: number; kind: "random" | "bulk" };
      const events: FuzzEvent[] = [];
      for (let i = int(0, 120); i > 0; i--) {
        events.push({ at: T0 + int(0, ACTIVE_TICKS * TICK_MS), kind: "random" });
      }
      for (let n = 1; n <= ACTIVE_TICKS; n++) {
        for (let i = int(0, 3); i > 0; i--) {
          events.push({ at: T0 + n * TICK_MS - int(5000, 200000), kind: "random" });
        }
      }
      if (int(0, 2) === 0) {
        events.push({ at: T0 + int(0, ACTIVE_TICKS * TICK_MS), kind: "bulk" });
      }
      const bulkShare = rng();
      events.sort((a, b) => a.at - b.at);
      for (const { at, kind } of events) {
        if (kind === "bulk") {
          for (const o of orders) {
            if (rng() < bulkShare && o.versions[o.versions.length - 1].at < at) {
              change(o, at);
            }
          }
          continue;
        }
        if (orders.length === 0 || rng() < 0.3) {
          const o: FuzzOrder = { idNum: orders.length + 1, versions: [] };
          change(o, at);
          orders.push(o);
          continue;
        }
        const o = orders[int(0, orders.length - 1)];
        if (o.versions[o.versions.length - 1].at < at) {
          change(o, at);
        }
      }

      const { db, env } = await makeDb();
      await db
        .update(schema.storeConnections)
        .set({ lastSyncAt })
        .where(eq(schema.storeConnections.workspaceId, WS));
      // Seeds differ in how hostile the shop is, from flawless to failing
      // on roughly one request in four.
      const hostility = [0, 0.3, 1, 3][int(0, 3)];
      const faults: FuzzFaults = {
        cursorless: 0.04 * hostility,
        throttle: 0.02 * hostility,
        http503: 0.01 * hostility,
        timeout: 0.005 * hostility,
        reject: 0.005 * hostility,
      };
      const clock = { now: T0 };
      let faulty = true;
      const shop = fuzzShopify(orders, clock, rng, () => (faulty ? faults : null));
      const tick = async (at: number) => {
        clock.now = Math.max(clock.now, at);
        const startedAt = clock.now;
        return runSync(db, env, WS, { fetchImpl: shop.impl, now: () => startedAt });
      };

      for (let n = 1; n <= ACTIVE_TICKS + 1; n++) {
        await tick(T0 + n * TICK_MS);
        // Sometimes somebody presses the sync button shortly after.
        if (int(0, 3) === 0) {
          await tick(clock.now + int(30000, 120000));
        }
      }

      // The shop goes quiet and stops failing. The engine has to finish any
      // chain and settle; the two idle ticks at the end prove it has.
      faulty = false;
      let idle = 0;
      let quietTicks = 0;
      while (idle < 2 && quietTicks < 80) {
        quietTicks++;
        const result = await tick(clock.now + TICK_MS);
        expect(result.error).toBeUndefined();
        const chain = (await connectionOf(db, WS)).syncCursor;
        idle = chain === null && result.added === 0 && result.updated === 0 ? idle + 1 : 0;
      }
      expect(idle).toBe(2);

      const rows = await ordersIn(db, WS);
      const stored = new Map(rows.map((row) => [row.shopifyOrderId, row]));
      const missing = orders.filter((o) => !stored.has(String(o.idNum))).map((o) => o.idNum);
      expect(missing).toEqual([]);
      const stale = orders
        .filter((o) => {
          const row = stored.get(String(o.idNum));
          return (row?.shopify as { note: string }).note !== `v${o.versions.length - 1}`;
        })
        .map((o) => o.idNum);
      expect(stale).toEqual([]);
      expect(rows).toHaveLength(orders.length);
    });
  }
});
