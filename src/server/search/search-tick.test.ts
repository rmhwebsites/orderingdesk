import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { indexOrders } from "./index-orders";
import { BACKFILL_ROWS, backfillCursor, parseBackfillCursor, runSearchTick, VERIFY_ROWS } from "./search-tick";
import { openTestDb, seedDraft, seedLocation, seedOrder, seedWorkspace, snapshotOf } from "@/server/desk/test-helpers";

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

// Every card Shopify is asked about was bought by customer 77 (contact 501)
// for the company location given.
const boughtAt = (locationId: string) => (call: Call) => ({
  data: {
    nodes: (call.variables.ids as string[]).map((id) => ({
      id,
      customer: { id: "gid://shopify/Customer/77" },
      purchasingEntity: {
        __typename: "PurchasingCompany",
        contact: { id: "gid://shopify/CompanyContact/501" },
        location: { id: `gid://shopify/CompanyLocation/${locationId}` },
      },
    })),
  },
});

const COMPANIES = ["read_orders", "read_customers", "read_draft_orders", "read_companies"];

async function setup(opts: { store?: boolean; scopes?: string[] } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  if (opts.store !== false) {
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: SHOP,
      encryptedToken: await encryptSecret(TOKEN, KEY, WS),
      scopes: opts.scopes ?? ["read_orders", "read_customers", "read_draft_orders"],
    });
  }
  return db;
}

async function locationOf(db: Db, id: string) {
  return (await db.select({ locationId: schema.orders.locationId }).from(schema.orders).where(eq(schema.orders.id, id)))[0].locationId;
}

async function searchRowOf(db: Db, id: string) {
  return (await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, id)))[0];
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

  // Orders stored before Wave 1b read the purchasing entity carry no
  // location (in production 9 of 12 cards), and the name backfill matches
  // none of them: with a companies scope the requester read names it too.
  it("gives an old order its company location from Shopify and indexes it with that location", async () => {
    const db = await setup({ scopes: COMPANIES });
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "North Yard" });
    await seedOrder(db, WS, { id: "o1", createdAt: 1000, shopify: snapshotOf() });
    await seedOrder(db, WS, { id: "o2", createdAt: 2000, shopify: snapshotOf({ customerId: "77" }) });
    const shop = shopify(boughtAt("101"));
    expect(await runSearchTick(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toMatchObject({ backfilled: 2, finished: true });
    expect(shop.calls).toHaveLength(1);
    expect(shop.calls[0].query).toContain("location { id }");
    expect(shop.calls[0].variables.ids).toEqual(["gid://shopify/Order/shop-o1", "gid://shopify/Order/shop-o2"]);
    expect(await locationOf(db, "o1")).toBe("101");
    expect(await locationOf(db, "o2")).toBe("101");
    for (const id of ["o1", "o2"]) {
      const row = await searchRowOf(db, id);
      expect(row.locationId).toBe("101");
      expect(row.haystack).toContain("north yard");
    }
    const [person] = await db.select().from(schema.people);
    expect(person).toMatchObject({ shopifyCustomerId: "77", companyContactId: "501", locationId: "101" });
    expect((await searchRowOf(db, "o1")).requesterId).toBe(person.id);
  });

  it("leaves the location of a card that already has one untouched", async () => {
    const db = await setup({ scopes: COMPANIES });
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "North Yard" });
    await seedLocation(db, WS, { shopifyLocationId: "202", name: "Harbor Point" });
    await seedOrder(db, WS, { id: "o1", createdAt: 1000, shopify: snapshotOf({ customerId: "77" }) });
    await seedOrder(db, WS, { id: "o2", createdAt: 2000, shopify: snapshotOf() });
    await db.update(schema.orders).set({ locationId: "101" });
    const shop = shopify(boughtAt("202"));
    expect(await runSearchTick(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toMatchObject({ backfilled: 2, finished: true });
    // o1 needs nothing; o2 is asked for its requester only.
    expect(shop.calls.map((call) => call.variables.ids)).toEqual([["gid://shopify/Order/shop-o2"]]);
    expect(await locationOf(db, "o1")).toBe("101");
    expect(await locationOf(db, "o2")).toBe("101");
    expect((await searchRowOf(db, "o2")).locationId).toBe("101");
    expect((await searchRowOf(db, "o2")).haystack).not.toContain("harbor point");
    expect((await searchRowOf(db, "o2")).requesterId).not.toBeNull();
  });

  // A store without read_companies or write_companies refuses the purchasing
  // entity's company fields, which used to fail every chunk.
  it("still links the requesters of a store without a companies scope, asking for the customer only", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", createdAt: 1000, shopify: snapshotOf() });
    await seedOrder(db, WS, { id: "o2", createdAt: 2000, shopify: snapshotOf({ customerId: "78" }) });
    const shop = shopify((call) =>
      call.query.includes("purchasingEntity")
        ? { errors: [{ message: "Access denied for purchasingEntity field. Required access: `read_companies` access scope." }] }
        : everyoneIs77(call),
    );
    expect(await runSearchTick(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toMatchObject({ backfilled: 2, finished: true });
    // o2 names its customer and no location can be read: it is not asked.
    expect(shop.calls.map((call) => call.variables.ids)).toEqual([["gid://shopify/Order/shop-o1"]]);
    expect(shop.calls[0].query).not.toContain("purchasingEntity");
    const person = (await db.select().from(schema.people).where(eq(schema.people.shopifyCustomerId, "77")))[0];
    expect((await searchRowOf(db, "o1")).requesterId).toBe(person.id);
    expect(await locationOf(db, "o1")).toBeNull();
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

  // The safety net behind every location writer (the name backfill in
  // src/server/sync/locations.ts indexes the cards it touches, but an index
  // failure is only logged): a card whose location changed behind the
  // index's back is rewritten with the location's name on the next tick.
  it("rewrites a card whose location was set behind the index's back", async () => {
    const db = await indexedWorkspace();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "North Yard" });
    await db.update(schema.orders).set({ locationId: "101" }).where(eq(schema.orders.id, "o1"));
    expect(await runSearchTick(db, env, WS, { now: () => NOW })).toEqual({ backfilled: 0, repaired: 1, removed: 0 });
    expect(await searchRowOf(db, "o1")).toMatchObject({ locationId: "101" });
    expect((await searchRowOf(db, "o1")).haystack).toContain("north yard");
  });

  it("does nothing on a workspace whose index is current", async () => {
    const db = await indexedWorkspace();
    expect(await runSearchTick(db, env, WS, { now: () => NOW })).toEqual({ backfilled: 0, repaired: 0, removed: 0 });
  });

  // A writer can miss its index call (a swallowed D1 error, a webhook resend
  // that upserts as "unchanged", a superseded drafts phase, two indexers
  // racing): the filter columns still agree, but the words and requester
  // are old.
  it("rewrites the haystack and requester of a card whose snapshot changed behind the index's back", async () => {
    const db = await indexedWorkspace();
    await db
      .update(schema.orders)
      .set({
        shopify: snapshotOf({
          customerId: "88",
          customerName: "Jordan Vale",
          email: "jordan.vale@example.com",
          items: [{ title: "Safety Vest", qty: 1, sku: "SV-2", variant: "", props: [] }],
        }),
      })
      .where(eq(schema.orders.id, "o1"));
    expect(await runSearchTick(db, env, WS, { now: () => NOW })).toEqual({ backfilled: 0, repaired: 1, removed: 0 });
    const row = (await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, "o1")))[0];
    expect(row.haystack).toContain("safety vest");
    expect(row.haystack).toContain("jordan vale");
    expect(row.haystack).not.toContain("hard hat");
    const jordan = (await db.select().from(schema.people).where(eq(schema.people.shopifyCustomerId, "88")))[0];
    expect(row.requesterId).toBe(jordan.id);
    expect(await runSearchTick(db, env, WS, { now: () => NOW })).toEqual({ backfilled: 0, repaired: 0, removed: 0 });
  });

  it("checks VERIFY_ROWS cards a tick, oldest first, and starts over after the newest", async () => {
    const db = await setup();
    const ids = Array.from({ length: VERIFY_ROWS + 10 }, (_, i) => `o${String(i).padStart(4, "0")}`);
    for (const [i, id] of ids.entries()) {
      await seedOrder(db, WS, { id, createdAt: 1000 + i });
    }
    await indexOrders(db, WS, ids);
    await db.update(schema.workspaceSettings).set({ searchIndexedAt: 1 }).where(eq(schema.workspaceSettings.workspaceId, WS));
    const newest = ids[ids.length - 1];
    await db.update(schema.orders).set({ name: "#9999" }).where(eq(schema.orders.id, newest));
    const opts = { now: () => NOW };
    // The first tick checks the oldest VERIFY_ROWS cards and remembers where it stopped.
    expect(await runSearchTick(db, env, WS, opts)).toMatchObject({ repaired: 0 });
    expect((await settingsOf(db)).searchBackfillCursor).toBe(backfillCursor(1000 + VERIFY_ROWS - 1, ids[VERIFY_ROWS - 1]));
    // The next one reaches the newest card, then wraps around.
    expect(await runSearchTick(db, env, WS, opts)).toMatchObject({ repaired: 1 });
    expect((await settingsOf(db)).searchBackfillCursor).toBeNull();
    expect((await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, newest)))[0].haystack).toContain("#9999");
    await db.update(schema.orders).set({ name: "#8888" }).where(eq(schema.orders.id, ids[0]));
    expect(await runSearchTick(db, env, WS, opts)).toMatchObject({ repaired: 1 });
    expect((await settingsOf(db)).searchIndexedAt).toBe(1);
  });

  it("keeps a requester the backfill found when the snapshot names none", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", shopify: snapshotOf() });
    await indexOrders(db, WS, ["o1"], { requesters: new Map([["o1", { customerId: "77", contactId: "" }]]) });
    await db.update(schema.workspaceSettings).set({ searchIndexedAt: 1 }).where(eq(schema.workspaceSettings.workspaceId, WS));
    const person = (await db.select().from(schema.people))[0];
    expect(await runSearchTick(db, env, WS, { now: () => NOW })).toEqual({ backfilled: 0, repaired: 0, removed: 0 });
    expect((await db.select().from(schema.orderSearch))[0].requesterId).toBe(person.id);
  });
});
