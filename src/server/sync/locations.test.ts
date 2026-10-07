import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import { indexOrders } from "../search/index-orders";
import type { CompanyLocationRecord } from "../shopify/locations";
import { draftSnapshotOf, openTestDb, seedDraft, seedLocation, seedOrder, seedWorkspace, snapshotOf } from "../desk/test-helpers";
import {
  LOCATIONS_SYNC_EVERY_MS,
  applyLocationWebhook,
  backfillLocationIds,
  getLocation,
  listLocations,
  syncLocations,
  syncLocationsIfDue,
  upsertLocation,
} from "./locations";

// The locations table (comprehensive design section 2) against the real
// migrations and a stubbed Shopify.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_locations_sync_token";
const NOW = Date.parse("2026-10-06T07:00:00.000Z");
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;

type ShopLocation = { id: number; name: string; companyId?: number };

// A store with company locations, two per page so paging is exercised.
// failPage answers that page with a 503.
function fakeShop(initial: ShopLocation[], opts: { failPage?: number } = {}) {
  const state = { list: [...initial], failPage: opts.failPage };
  const ops: string[] = [];
  const toNode = (location: ShopLocation) => ({
    id: `gid://shopify/CompanyLocation/${location.id}`,
    name: location.name,
    company: { id: `gid://shopify/Company/${location.companyId ?? 7}` },
    shippingAddress: {
      address1: "100 Example Way",
      address2: "",
      city: "Buford",
      province: "Georgia",
      zoneCode: "GA",
      zip: "30518",
      country: "United States",
      countryCode: "US",
      phone: "",
      companyName: "Example Rentals",
    },
  });
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/query (\w+)/)?.[1] ?? "unknown";
    ops.push(op);
    if (op === "CompanyLocations") {
      const index = typeof body.variables.cursor === "string" ? Number(body.variables.cursor) : 0;
      if (state.failPage === index) {
        return new Response("busy", { status: 503 });
      }
      const slice = state.list.slice(index * 2, index * 2 + 2);
      const more = state.list.length > index * 2 + 2;
      return Response.json({
        data: { companyLocations: { nodes: slice.map(toNode), pageInfo: { hasNextPage: more, endCursor: more ? String(index + 1) : null } } },
      });
    }
    if (op === "CompanyLocationById") {
      const found = state.list.find((location) => `gid://shopify/CompanyLocation/${location.id}` === body.variables.id);
      return Response.json({ data: { companyLocation: found ? toNode(found) : null } });
    }
    throw new Error("unexpected Shopify request: " + op);
  }) as typeof fetch;
  return { impl, state, ops };
}

async function setup(scopes: string[] | null = ["read_orders", "write_orders", "read_customers", "read_companies"]) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes,
  });
  return db;
}

function rows(db: Db) {
  return db
    .select()
    .from(schema.locations)
    .where(eq(schema.locations.workspaceId, WS))
    .orderBy(asc(schema.locations.shopifyLocationId));
}

async function locationIdOf(db: Db, orderId: string) {
  const found = await db.select({ locationId: schema.orders.locationId }).from(schema.orders).where(eq(schema.orders.id, orderId));
  return found[0]?.locationId ?? null;
}

const THREE: ShopLocation[] = [
  { id: 101, name: "Buford HQ" },
  { id: 102, name: "Mableton" },
  { id: 103, name: "Athens" },
];

describe("syncLocations", () => {
  it("asks Shopify nothing without a companies scope or a connection", async () => {
    const shop = fakeShop(THREE);
    const db = await setup(["read_orders", "read_customers"]);
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toEqual({
      kind: "skipped",
      reason: "no-companies-scope",
    });
    expect(await syncLocations(db, env, "ws_nobody", { fetchImpl: shop.impl, now: () => NOW })).toEqual({
      kind: "skipped",
      reason: "no-connection",
    });
    expect(shop.ops).toEqual([]);
  });

  it("stores every company location, page by page, with its company and address", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toEqual({
      kind: "ok",
      upserted: 3,
      deactivated: 0,
      backfilled: 0,
      complete: true,
    });
    const stored = await rows(db);
    expect(stored.map((row) => [row.shopifyLocationId, row.name, row.companyId, row.active, row.updatedAt])).toEqual([
      ["101", "Buford HQ", "7", true, NOW],
      ["102", "Mableton", "7", true, NOW],
      ["103", "Athens", "7", true, NOW],
    ]);
    expect(stored[0].address).toMatchObject({ address1: "100 Example Way", provinceCode: "GA", countryCode: "US" });
    expect(shop.ops).toEqual(["CompanyLocations", "CompanyLocations"]);
  });

  it("renames, deactivates what Shopify dropped after a complete run, and never deletes", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    shop.state.list = [{ id: 101, name: "Buford Main" }, { id: 103, name: "Athens" }];
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 1000 })).toMatchObject({
      kind: "ok",
      deactivated: 1,
      complete: true,
    });
    expect((await rows(db)).map((row) => [row.shopifyLocationId, row.name, row.active])).toEqual([
      ["101", "Buford Main", true],
      ["102", "Mableton", false],
      ["103", "Athens", true],
    ]);

    // A run that stops early (page 2 fails) deactivates nothing.
    shop.state.list = [...THREE];
    shop.state.failPage = 1;
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 2000 })).toMatchObject({
      kind: "ok",
      upserted: 2,
      deactivated: 0,
      complete: false,
    });
    expect((await rows(db)).map((row) => [row.shopifyLocationId, row.active])).toEqual([
      ["101", true],
      ["102", true],
      ["103", true],
    ]);
  });
});

describe("backfillLocationIds", () => {
  it("names the location of cards stored before 0012 by an exact, unambiguous name", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ" });
    await seedLocation(db, WS, { shopifyLocationId: "102", name: "Mableton" });
    await seedLocation(db, WS, { shopifyLocationId: "103", name: "Mableton" });
    await seedDraft(db, WS, { id: "d1", shopify: draftSnapshotOf({ location: "Buford HQ" }) });
    await seedDraft(db, WS, { id: "d2", shopify: draftSnapshotOf({ location: "Mableton" }) });
    await seedDraft(db, WS, { id: "d3", shopify: draftSnapshotOf({ location: "Elsewhere" }) });
    await seedDraft(db, WS, { id: "d4", shopify: draftSnapshotOf({ location: "Buford HQ" }) });
    await db.update(schema.orders).set({ locationId: "999" }).where(eq(schema.orders.id, "d4"));
    await seedOrder(db, WS, { id: "o1" });
    await db.update(schema.orders).set({ draftSnapshot: draftSnapshotOf({ location: "Buford HQ" }) }).where(eq(schema.orders.id, "o1"));

    expect(await backfillLocationIds(db, WS)).toBe(2);
    expect(await locationIdOf(db, "d1")).toBe("101");
    expect(await locationIdOf(db, "d2")).toBeNull();
    expect(await locationIdOf(db, "d3")).toBeNull();
    expect(await locationIdOf(db, "d4")).toBe("999");
    expect(await locationIdOf(db, "o1")).toBe("101");
  });

  // Plain orders never carry a location name, so their cards stay null for
  // good; they must not hide an older card that names its location.
  it("reaches an older named card behind 500 newer cards that carry no name", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ" });
    await seedDraft(db, WS, { id: "older", createdAt: 1, shopify: draftSnapshotOf({ location: "Buford HQ" }) });
    await db.insert(schema.orders).values(
      Array.from({ length: 500 }, (_, i) => ({
        id: `plain${i}`,
        workspaceId: WS,
        shopifyOrderId: `plain-${i}`,
        name: `#${2000 + i}`,
        shopify: snapshotOf({ shopifyOrderId: `plain-${i}`, name: `#${2000 + i}` }),
        statusKey: "new",
        createdAt: 1000 + i,
        syncedAt: 2000,
      })),
    );

    expect(await backfillLocationIds(db, WS)).toBe(1);
    expect(await locationIdOf(db, "older")).toBe("101");
    expect(await backfillLocationIds(db, WS)).toBe(0);
  });

  it("trims the stored name and stays inside the workspace", async () => {
    const db = await setup();
    await seedWorkspace(db, "ws_other");
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ" });
    await seedLocation(db, "ws_other", { shopifyLocationId: "201", name: "Buford HQ" });
    await seedDraft(db, WS, { id: "padded", shopify: draftSnapshotOf({ location: "  Buford HQ  " }) });
    await seedDraft(db, WS, { id: "blank", shopify: draftSnapshotOf({ location: "   " }) });
    await seedDraft(db, "ws_other", { id: "theirs", shopify: draftSnapshotOf({ location: "Buford HQ" }) });

    expect(await backfillLocationIds(db, WS)).toBe(1);
    expect(await locationIdOf(db, "padded")).toBe("101");
    expect(await locationIdOf(db, "blank")).toBeNull();
    expect(await locationIdOf(db, "theirs")).toBeNull();
  });
});

describe("syncLocationsIfDue", () => {
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const NOT_DUE = { kind: "skipped", reason: "not-due" };
  const due = (db: Db, shop: { impl: typeof fetch }, at: number) => syncLocationsIfDue(db, env, WS, { fetchImpl: shop.impl, now: () => at });
  const syncedAt = async (db: Db) =>
    (await db.select().from(schema.storeConnections).where(eq(schema.storeConnections.workspaceId, WS)))[0]?.locationsSyncedAt;

  it("runs when it never ran, then once a day", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    expect((await due(db, shop, NOW)).kind).toBe("ok");
    expect(await syncedAt(db)).toBe(NOW);
    expect(await due(db, shop, NOW + HOUR)).toEqual(NOT_DUE);
    expect((await due(db, shop, NOW + LOCATIONS_SYNC_EVERY_MS)).kind).toBe("ok");
    expect(LOCATIONS_SYNC_EVERY_MS).toBe(24 * HOUR);
  });

  // The daily sync is the only path that heals a lost webhook, so a webhook
  // that touches one location never postpones it.
  it("runs a day after the last sync even when a webhook touched a location since", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    expect((await due(db, shop, NOW)).kind).toBe("ok");
    // 102 is deleted in Shopify and its webhook is lost; 101 is renamed and
    // its webhook arrives 23 hours after the sync.
    shop.state.list = [{ id: 101, name: "Buford Main" }, { id: 103, name: "Athens" }];
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/101" }, { fetchImpl: shop.impl, now: () => NOW + 23 * HOUR });
    shop.ops.length = 0;
    expect(await due(db, shop, NOW + 24 * HOUR)).toMatchObject({ kind: "ok", deactivated: 1, complete: true });
    expect(shop.ops).toEqual(["CompanyLocations"]);
    expect((await rows(db)).map((row) => [row.shopifyLocationId, row.name, row.active])).toEqual([
      ["101", "Buford Main", true],
      ["102", "Mableton", false],
      ["103", "Athens", true],
    ]);
  });

  it("asks a store with no company locations once a day, not on every cron tick", async () => {
    const shop = fakeShop([]);
    const db = await setup();
    expect(await due(db, shop, NOW)).toEqual({ kind: "ok", upserted: 0, deactivated: 0, backfilled: 0, complete: true });
    expect(await due(db, shop, NOW + 10 * MINUTE)).toEqual(NOT_DUE);
    expect(await due(db, shop, NOW + 23 * HOUR)).toEqual(NOT_DUE);
    expect(shop.ops).toEqual(["CompanyLocations"]);
    expect((await due(db, shop, NOW + 24 * HOUR)).kind).toBe("ok");
    expect(shop.ops).toEqual(["CompanyLocations", "CompanyLocations"]);
  });

  it("backs off a day after a failed sync too, while a save or refresh still syncs at once", async () => {
    const shop = fakeShop(THREE, { failPage: 0 });
    const db = await setup();
    expect((await due(db, shop, NOW)).kind).toBe("failed");
    const askedOnce = shop.ops.length;
    expect(askedOnce).toBeGreaterThan(0);
    expect(await due(db, shop, NOW + 10 * MINUTE)).toEqual(NOT_DUE);
    expect(shop.ops).toHaveLength(askedOnce);
    // Saving or refreshing the connection calls syncLocations directly.
    shop.state.failPage = undefined;
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 20 * MINUTE })).toMatchObject({ kind: "ok", upserted: 3 });
    expect(await due(db, shop, NOW + 20 * MINUTE + LOCATIONS_SYNC_EVERY_MS - 1)).toEqual(NOT_DUE);
    expect((await due(db, shop, NOW + 20 * MINUTE + LOCATIONS_SYNC_EVERY_MS)).kind).toBe("ok");
  });

  it("records nothing while skipped, so the first tick with a companies scope syncs", async () => {
    const shop = fakeShop(THREE);
    const db = await setup(["read_orders", "read_customers"]);
    expect(await due(db, shop, NOW)).toEqual({ kind: "skipped", reason: "no-companies-scope" });
    expect(await syncedAt(db)).toBeNull();
    await db
      .update(schema.storeConnections)
      .set({ scopes: ["read_orders", "read_customers", "read_companies"] })
      .where(eq(schema.storeConnections.workspaceId, WS));
    expect(await due(db, shop, NOW + 10 * MINUTE)).toMatchObject({ kind: "ok", upserted: 3 });
  });
});

describe("listLocations and getLocation", () => {
  it("lists a company's active locations by name and reads one by its Shopify id", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Mableton" });
    await seedLocation(db, WS, { shopifyLocationId: "102", name: "Athens" });
    await seedLocation(db, WS, { shopifyLocationId: "103", name: "Closed Yard", active: false });
    await seedLocation(db, WS, { shopifyLocationId: "104", name: "Other Co", companyId: "8" });
    expect((await listLocations(db, WS, { companyId: "7", activeOnly: true })).map((row) => row.name)).toEqual(["Athens", "Mableton"]);
    expect((await listLocations(db, WS)).map((row) => row.shopifyLocationId)).toEqual(["102", "103", "101", "104"]);
    expect(await getLocation(db, WS, "103")).toMatchObject({ name: "Closed Yard", active: false, address: null });
    expect(await getLocation(db, WS, "999")).toBeNull();
  });
});

describe("applyLocationWebhook", () => {
  it("stores a created or updated location, and keeps a deleted or vanished one inactive", async () => {
    const shop = fakeShop([{ id: 104, name: "Greenville" }]);
    const db = await setup();
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW });
    expect((await rows(db)).map((row) => [row.shopifyLocationId, row.name, row.active])).toEqual([["104", "Greenville", true]]);
    await applyLocationWebhook(db, env, WS, { kind: "location-deleted", locationId: "104" }, { fetchImpl: shop.impl, now: () => NOW + 1 });
    expect((await rows(db))[0]).toMatchObject({ active: false, updatedAt: NOW + 1 });
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW + 2 });
    expect((await rows(db))[0]).toMatchObject({ active: true });
    shop.state.list = [];
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW + 3 });
    expect((await rows(db))[0]).toMatchObject({ active: false });
  });

  it("does nothing for a store without a companies scope", async () => {
    const shop = fakeShop([{ id: 104, name: "Greenville" }]);
    const db = await setup(["read_orders", "read_customers"]);
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW });
    expect(await rows(db)).toEqual([]);
    expect(shop.ops).toEqual([]);
  });
});

describe("upsertLocation and the search index", () => {
  it("rewrites the haystack of the cards at a renamed location", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "North Yard" });
    await seedOrder(db, WS, { id: "o1" });
    await db.update(schema.orders).set({ locationId: "101" }).where(eq(schema.orders.id, "o1"));
    await indexOrders(db, WS, ["o1"]);
    await upsertLocation(db, WS, { shopifyLocationId: "101", companyId: "7", name: "North Yard Annex", address: null } as CompanyLocationRecord, 5);
    const [row] = await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, "o1"));
    expect(row.haystack).toContain("north yard annex");
  });
});
