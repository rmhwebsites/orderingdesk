import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import { draftSnapshotOf, openTestDb, seedDraft, seedLocation, seedOrder, seedWorkspace } from "../desk/test-helpers";
import {
  LOCATIONS_SYNC_EVERY_MS,
  applyLocationWebhook,
  backfillLocationIds,
  getLocation,
  listLocations,
  syncLocations,
  syncLocationsIfDue,
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
});

describe("syncLocationsIfDue", () => {
  it("runs when the workspace has no locations, then once a day", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    expect((await syncLocationsIfDue(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).kind).toBe("ok");
    expect(await syncLocationsIfDue(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 3600000 })).toEqual({
      kind: "skipped",
      reason: "not-due",
    });
    expect((await syncLocationsIfDue(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + LOCATIONS_SYNC_EVERY_MS })).kind).toBe("ok");
    expect(LOCATIONS_SYNC_EVERY_MS).toBe(24 * 60 * 60 * 1000);
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
