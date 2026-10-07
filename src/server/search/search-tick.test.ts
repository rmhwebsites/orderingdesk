import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { indexOrders } from "./index-orders";
import { BACKFILL_ROWS, backfillCursor, parseBackfillCursor, runSearchTick } from "./search-tick";
import { openTestDb, seedDraft, seedOrder, seedWorkspace, snapshotOf } from "@/server/desk/test-helpers";

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_search_tick_token_never_leak";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;

type Call = { query: string; variables: Record<string, unknown> };

function shopify(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

// Every card stored before snapshots kept customer ids belongs to customer 77.
const everyoneIs77 = (call: Call) => ({
  data: {
    nodes: (call.variables.ids as string[]).map((id) => ({ id, customer: { id: "gid://shopify/Customer/77" }, purchasingEntity: null })),
  },
});

async function setup(opts: { store?: boolean } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  if (opts.store !== false) {
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: SHOP,
      encryptedToken: await encryptSecret(TOKEN, KEY, WS),
      scopes: ["read_orders", "read_customers", "read_draft_orders"],
    });
  }
  return db;
}

async function settingsOf(db: Db) {
  return (await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, WS)))[0];
}

async function searchCount(db: Db) {
  return (await db.select().from(schema.orderSearch)).length;
}

describe("backfill cursors", () => {
  it("round-trip and refuse anything else", () => {
    expect(parseBackfillCursor(backfillCursor(1000, "o-1"))).toEqual({ createdAt: 1000, id: "o-1" });
    expect(parseBackfillCursor(null)).toBeNull();
    expect(parseBackfillCursor("1000")).toBeNull();
    expect(parseBackfillCursor("x~o1")).toBeNull();
  });
});

describe("runSearchTick backfill", () => {
  it("indexes every stored card in batches, oldest first, then stamps the workspace", async () => {
    const db = await setup();
    const total = BACKFILL_ROWS * 2 + 50;
    for (let i = 0; i < total; i++) {
      await seedOrder(db, WS, { id: `o${String(i).padStart(4, "0")}`, createdAt: 1000 + i, shopify: snapshotOf({ customerId: "77" }) });
    }
    const shop = shopify(everyoneIs77);
    const opts = { fetchImpl: shop.impl, now: () => NOW };
    expect(await runSearchTick(db, env, WS, opts)).toMatchObject({ backfilled: BACKFILL_ROWS });
    expect((await settingsOf(db)).searchBackfillCursor).toBe(backfillCursor(1000 + BACKFILL_ROWS - 1, "o0199"));
    expect(await runSearchTick(db, env, WS, opts)).toMatchObject({ backfilled: BACKFILL_ROWS });
    expect(await runSearchTick(db, env, WS, opts)).toMatchObject({ backfilled: 50, finished: true });
    expect(await searchCount(db)).toBe(total);
    expect(await settingsOf(db)).toMatchObject({ searchIndexedAt: NOW, searchBackfillCursor: null });
    // Every snapshot named its customer: Shopify was never asked.
    expect(shop.calls).toHaveLength(0);
    expect((await db.select().from(schema.people)).map((p) => p.shopifyCustomerId)).toEqual(["77"]);
  });

  it("asks Shopify for the requester of cards stored without one, and links them", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", createdAt: 1000, shopify: snapshotOf() });
    await seedDraft(db, WS, { id: "d1", draftId: "12", createdAt: 2000 });
    const shop = shopify(everyoneIs77);
    const result = await runSearchTick(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result).toMatchObject({ backfilled: 2, finished: true });
    expect(shop.calls).toHaveLength(1);
    expect(shop.calls[0].variables.ids).toEqual(["gid://shopify/Order/shop-o1", "gid://shopify/DraftOrder/12"]);
    const [person] = await db.select().from(schema.people);
    const rows = await db.select().from(schema.orderSearch).orderBy(asc(schema.orderSearch.orderId));
    expect(rows.map((row) => [row.orderId, row.requesterId])).toEqual([
      ["d1", person.id],
      ["o1", person.id],
    ]);
  });

  it("waits without moving on while Shopify is busy", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", shopify: snapshotOf() });
    const busy = shopify(() => new Response("busy", { status: 503 }));
    expect(await runSearchTick(db, env, WS, { fetchImpl: busy.impl, now: () => NOW })).toMatchObject({ skipped: "shopify-busy", backfilled: 0 });
    expect(await searchCount(db)).toBe(0);
    expect((await settingsOf(db)).searchBackfillCursor).toBeNull();
  });

  it("indexes without requesters when no store is connected", async () => {
    const db = await setup({ store: false });
    await seedOrder(db, WS, { id: "o1", shopify: snapshotOf() });
    const shop = shopify(everyoneIs77);
    expect(await runSearchTick(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toMatchObject({ backfilled: 1, finished: true });
    expect(shop.calls).toHaveLength(0);
    expect((await db.select().from(schema.orderSearch))[0].requesterId).toBeNull();
  });
});

describe("runSearchTick repair", () => {
  async function indexedWorkspace() {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "new", shopify: snapshotOf({ customerId: "77" }) });
    await seedOrder(db, WS, { id: "o2", statusKey: "new", shopify: snapshotOf({ customerId: "77" }) });
    await indexOrders(db, WS, ["o1", "o2"]);
    await db.update(schema.workspaceSettings).set({ searchIndexedAt: 1 }).where(eq(schema.workspaceSettings.workspaceId, WS));
    return db;
  }

  it("rewrites rows whose card changed behind the index's back, adds missing ones and drops orphans", async () => {
    const db = await indexedWorkspace();
    await db.update(schema.orders).set({ statusKey: "processing", statusSetAt: 5 }).where(eq(schema.orders.id, "o1"));
    await seedOrder(db, WS, { id: "o3" });
    await db.delete(schema.orders).where(eq(schema.orders.id, "o2"));
    const result = await runSearchTick(db, env, WS, { now: () => NOW });
    expect(result).toMatchObject({ backfilled: 0, repaired: 2, removed: 1 });
    const rows = await db.select().from(schema.orderSearch).orderBy(asc(schema.orderSearch.orderId));
    expect(rows.map((row) => [row.orderId, row.statusKey, row.statusSetAt])).toEqual([
      ["o1", "processing", 5],
      ["o3", "new", null],
    ]);
  });

  it("does nothing on a workspace whose index is current", async () => {
    const db = await indexedWorkspace();
    expect(await runSearchTick(db, env, WS, { now: () => NOW })).toEqual({ backfilled: 0, repaired: 0, removed: 0 });
  });
});
