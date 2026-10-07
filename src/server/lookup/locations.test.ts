import { describe, it, expect } from "vitest";
import { indexOrders } from "@/server/search/index-orders";
import { getLocationPage, listLocationSummaries } from "./locations";
import {
  openTestDb,
  seedCancelledStatus,
  seedDraft,
  seedLocation,
  seedOrder,
  seedWorkspace,
  setOrderLocation,
  setStatusClosed,
  snapshotOf,
} from "@/server/desk/test-helpers";

const WS = "ws_impact";
const DAY = 86400000;
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const vest = (qty: number) => ({ title: "Safety Vest", qty, sku: "SV-2", variant: "L", props: [] });

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await setStatusClosed(db, WS, "shipped", true);
  await seedLocation(db, WS, { shopifyLocationId: "loc_north", name: "North Yard" });
  await seedLocation(db, WS, { shopifyLocationId: "loc_old", name: "Old Yard", active: false });
  await seedOrder(db, WS, { id: "o_open", statusKey: "new", createdAt: NOW - DAY, shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes", items: [vest(2)] }) });
  await seedOrder(db, WS, { id: "o_shipped", statusKey: "shipped", createdAt: NOW - 20 * DAY, shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes", items: [vest(3)] }) });
  await seedDraft(db, WS, { id: "d_open", createdAt: NOW - 2 * DAY });
  await seedOrder(db, WS, { id: "o_elsewhere", statusKey: "new", createdAt: NOW });
  for (const id of ["o_open", "o_shipped", "d_open"]) {
    await setOrderLocation(db, id, "loc_north");
  }
  await indexOrders(db, WS, ["o_open", "o_shipped", "d_open", "o_elsewhere"]);
  return db;
}

describe("listLocationSummaries", () => {
  it("lists active locations first, with open and total cards", async () => {
    const db = await setup();
    expect((await listLocationSummaries(db, WS)).map((row) => [row.id, row.name, row.active, row.openCount, row.cardCount])).toEqual([
      ["loc_north", "North Yard", true, 2, 3],
      ["loc_old", "Old Yard", false, 0, 0],
    ]);
  });
});

describe("getLocationPage", () => {
  it("shows the location, its open cards, every order for it, top items and who ordered", async () => {
    const db = await setup();
    const page = await getLocationPage(db, WS, "loc_north", NOW);
    expect(page?.location).toMatchObject({ name: "North Yard", active: true });
    expect(page?.openCards.map((card) => card.id)).toEqual(["o_open", "d_open"]);
    expect(page?.openCount).toBe(2);
    expect(page?.orders.map((card) => card.id)).toEqual(["o_open", "o_shipped"]);
    expect(page?.ordersCount).toBe(2);
    expect(page?.openCards[0]).toMatchObject({ locationName: "North Yard" });
    // The open request (seedDraft's default snapshot) asks for one box of business cards.
    expect(page?.topItems).toEqual([
      { title: "Safety Vest", variant: "L", quantity: 5 },
      { title: "Business cards", variant: "", quantity: 1 },
    ]);
    expect(page?.people.map((person) => [person.name, person.cards])).toEqual([["Riley Oakes", 2]]);
  });

  it("leaves out the items of an order Shopify cancelled, inside the Cancelled status or not", async () => {
    const db = await setup();
    await seedCancelledStatus(db, WS);
    await seedOrder(db, WS, {
      id: "o_shop_cancelled",
      statusKey: "shipped",
      createdAt: NOW - 3 * DAY,
      shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes", items: [vest(8)], cancelledAt: NOW - 2 * DAY }),
    });
    await seedOrder(db, WS, {
      id: "o_in_cancelled",
      statusKey: "cancelled",
      createdAt: NOW - 4 * DAY,
      shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes", items: [vest(6)], cancelledAt: NOW - 3 * DAY }),
    });
    for (const id of ["o_shop_cancelled", "o_in_cancelled"]) {
      await setOrderLocation(db, id, "loc_north");
    }
    await indexOrders(db, WS, ["o_shop_cancelled", "o_in_cancelled"]);
    const page = await getLocationPage(db, WS, "loc_north", NOW);
    expect(page?.topItems).toEqual([
      { title: "Safety Vest", variant: "L", quantity: 5 },
      { title: "Business cards", variant: "", quantity: 1 },
    ]);
    expect(page?.orders.find((card) => card.id === "o_shop_cancelled")).toMatchObject({ statusKey: "shipped", cancelled: true });
  });

  it("is null for a location of another workspace or none at all", async () => {
    const db = await setup();
    expect(await getLocationPage(db, WS, "loc_missing", NOW)).toBeNull();
    expect(await getLocationPage(db, "ws_other", "loc_north", NOW)).toBeNull();
  });
});
