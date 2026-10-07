import { describe, it, expect, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { applyBatch } from "@/db/batch";
import { closedFlagsStatement, indexOrders, INDEX_CHUNK, reindexLocation, safeIndexOrders } from "./index-orders";
import {
  draftSnapshotOf,
  openTestDb,
  seedDraft,
  seedLocation,
  seedOrder,
  seedWorkspace,
  setOrderLocation,
  setStatusClosed,
  snapshotOf,
} from "@/server/desk/test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  await seedLocation(db, WS, { shopifyLocationId: "loc_north", name: "North Yard" });
  return db;
}

async function searchRow(db: Db, orderId: string) {
  return (await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, orderId)))[0];
}

async function seedPo(db: Db, orderId: string, poNumber: string) {
  await db.insert(schema.purchaseOrders).values({
    id: `po_${poNumber}`,
    workspaceId: WS,
    orderId,
    vendorId: "v1",
    poNumber,
    lineItems: [],
    createdBy: "u1",
    createdAt: 1,
  });
}

describe("indexOrders", () => {
  it("writes the haystack and filter columns of an order and a draft", async () => {
    const db = await setup();
    await setStatusClosed(db, WS, "shipped", true);
    await seedOrder(db, WS, {
      id: "o1",
      name: "#1042",
      statusKey: "shipped",
      createdAt: 1000,
      shopify: snapshotOf({
        customerId: "77",
        customerName: "Riley Oakes",
        items: [{ title: "Hard Hat", qty: 2, sku: "HH-1", variant: "White", props: [] }],
      }),
    });
    await setOrderLocation(db, "o1", "loc_north");
    await seedPo(db, "o1", "IMP-2026-0007");
    await seedPo(db, "o1", "draft:po_unsent");
    await seedDraft(db, WS, { id: "d1", name: "#D19", createdAt: 2000 });

    expect(await indexOrders(db, WS, ["o1", "d1"])).toEqual({ indexed: 2, missing: 0 });

    const order = await searchRow(db, "o1");
    expect(order).toMatchObject({ workspaceId: WS, kind: "order", statusKey: "shipped", closed: 1, locationId: "loc_north", createdAt: 1000 });
    for (const part of ["#1042", "north yard", "hh-1", "white", "imp-2026-0007"]) {
      expect(order.haystack).toContain(part);
    }
    expect(order.haystack).not.toContain("draft:");
    expect(order.requesterId).not.toBeNull();
    const draft = await searchRow(db, "d1");
    expect(draft).toMatchObject({ kind: "draft", statusKey: "new", closed: 0, locationId: null, requesterId: null });
    expect(draft.haystack).toContain("#d19");
  });

  it("follows a snapshot change and a status change when indexed again", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", shopify: snapshotOf({ items: [{ title: "Hard Hat", qty: 1, sku: "HH-1", variant: "", props: [] }] }) });
    await indexOrders(db, WS, ["o1"]);
    await db
      .update(schema.orders)
      .set({ statusKey: "processing", statusSetAt: 5000, shopify: snapshotOf({ items: [{ title: "Safety Vest", qty: 1, sku: "SV-2", variant: "", props: [] }] }) })
      .where(eq(schema.orders.id, "o1"));
    await indexOrders(db, WS, ["o1"]);
    const row = await searchRow(db, "o1");
    expect(row).toMatchObject({ statusKey: "processing", statusSetAt: 5000 });
    expect(row.haystack).toContain("safety vest");
    expect(row.haystack).not.toContain("hard hat");
  });

  it("drops the search row of a card that no longer exists, and never indexes another workspace's card", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1" });
    await seedOrder(db, OTHER, { id: "x1" });
    await indexOrders(db, WS, ["o1"]);
    await db.delete(schema.orders).where(eq(schema.orders.id, "o1"));
    expect(await indexOrders(db, WS, ["o1", "x1"])).toEqual({ indexed: 0, missing: 2 });
    expect(await searchRow(db, "o1")).toBeUndefined();
    expect(await searchRow(db, "x1")).toBeUndefined();
  });

  it("indexes more cards than one chunk", async () => {
    const db = await setup();
    const ids = Array.from({ length: INDEX_CHUNK * 2 + 7 }, (_, i) => `o${i}`);
    for (const id of ids) {
      await seedOrder(db, WS, { id });
    }
    expect((await indexOrders(db, WS, ids)).indexed).toBe(ids.length);
  });
});

describe("people", () => {
  it("keeps one person per customer, named by their newest card, at that card's location", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "loc_harbor", name: "Harbor Point" });
    await seedOrder(db, WS, { id: "o1", createdAt: 1000, shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes", email: "riley@example.com" }) });
    await setOrderLocation(db, "o1", "loc_north");
    await seedOrder(db, WS, { id: "o2", createdAt: 3000, shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes-Lin", email: "riley@example.com" }) });
    await setOrderLocation(db, "o2", "loc_harbor");
    await indexOrders(db, WS, ["o2"]);
    // An older card indexed later must not rename them or move them back.
    await indexOrders(db, WS, ["o1"]);
    const rows = await db.select().from(schema.people);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: WS,
      shopifyCustomerId: "77",
      name: "Riley Oakes-Lin",
      email: "riley@example.com",
      locationId: "loc_harbor",
      firstSeenAt: 1000,
      lastSeenAt: 3000,
    });
    expect((await searchRow(db, "o1")).requesterId).toBe(rows[0].id);
    expect((await searchRow(db, "o2")).requesterId).toBe(rows[0].id);
  });

  it("keeps people apart per workspace and takes the company contact from the draft", async () => {
    const db = await setup();
    await seedDraft(db, WS, { id: "d1", shopify: draftSnapshotOf({ customerId: "77", contactId: "501" }) });
    await seedDraft(db, OTHER, { id: "d2", shopify: draftSnapshotOf({ customerId: "77" }) });
    await indexOrders(db, WS, ["d1"]);
    await indexOrders(db, OTHER, ["d2"]);
    const rows = await db.select().from(schema.people).orderBy(asc(schema.people.workspaceId));
    expect(rows.map((row) => [row.workspaceId, row.shopifyCustomerId, row.companyContactId])).toEqual([
      [WS, "77", "501"],
      [OTHER, "77", null],
    ]);
  });

  it("uses a requester hint for a snapshot stored before requester ids, and keeps it on later indexing", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", shopify: snapshotOf() });
    await indexOrders(db, WS, ["o1"], { requesters: new Map([["o1", { customerId: "77", contactId: "" }]]) });
    const person = (await db.select().from(schema.people))[0];
    expect(person).toMatchObject({ shopifyCustomerId: "77", name: "Riley Oakes" });
    await indexOrders(db, WS, ["o1"]);
    expect((await searchRow(db, "o1")).requesterId).toBe(person.id);
  });
});

describe("closedFlagsStatement", () => {
  it("brings the closed flags in line with the statuses, inside a batch", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    await indexOrders(db, WS, ["o1"]);
    await setStatusClosed(db, WS, "shipped", true);
    await applyBatch(db, [closedFlagsStatement(db, WS)]);
    expect((await searchRow(db, "o1")).closed).toBe(1);
    await setStatusClosed(db, WS, "shipped", false);
    await applyBatch(db, [closedFlagsStatement(db, WS)]);
    expect((await searchRow(db, "o1")).closed).toBe(0);
  });
});

describe("reindexLocation", () => {
  it("rewrites the haystack of every card at a renamed location", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1" });
    await setOrderLocation(db, "o1", "loc_north");
    await indexOrders(db, WS, ["o1"]);
    await db.update(schema.locations).set({ name: "North Yard Annex" }).where(eq(schema.locations.shopifyLocationId, "loc_north"));
    await reindexLocation(db, WS, "loc_north");
    expect((await searchRow(db, "o1")).haystack).toContain("north yard annex");
  });
});

describe("safeIndexOrders", () => {
  it("never throws, and logs ids and counts only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      select: () => {
        throw new Error("D1 is down");
      },
    } as unknown as Db;
    await expect(safeIndexOrders(broken, WS, ["o1"])).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toContain("[search]");
    warn.mockRestore();
  });
});
