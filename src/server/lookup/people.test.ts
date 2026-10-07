import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { indexOrders } from "@/server/search/index-orders";
import { getPersonPage, listPeople, PEOPLE_LIST_MAX } from "./people";
import {
  draftSnapshotOf,
  openTestDb,
  seedCancelledStatus,
  seedDraft,
  seedDraftStatuses,
  seedLocation,
  seedOrder,
  seedWorkspace,
  setOrderLocation,
  setStatusClosed,
  snapshotOf,
} from "@/server/desk/test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";
const DAY = 86400000;
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const hat = (variant: string, qty: number) => ({ title: "Hard Hat", qty, sku: "HH-1", variant, props: [] });

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  await seedDraftStatuses(db, WS);
  await setStatusClosed(db, WS, "shipped", true);
  await setStatusClosed(db, WS, "rejected", true);
  await seedLocation(db, WS, { shopifyLocationId: "loc_north", name: "North Yard" });
  const riley = (extra: Record<string, unknown> = {}) => snapshotOf({ customerId: "77", customerName: "Riley Oakes", email: "riley@example.com", ...extra });
  await seedOrder(db, WS, { id: "o_open", statusKey: "new", createdAt: NOW - 2 * DAY, shopify: riley({ items: [hat("White", 2)] }) });
  await seedOrder(db, WS, { id: "o_done", statusKey: "shipped", createdAt: NOW - 30 * DAY, shopify: riley({ items: [hat("White", 1)] }) });
  await seedOrder(db, WS, { id: "o_old", statusKey: "shipped", createdAt: NOW - 400 * DAY, shopify: riley({ items: [hat("Yellow", 9)] }) });
  await seedDraft(db, WS, {
    id: "d_rejected",
    statusKey: "rejected",
    createdAt: NOW - 5 * DAY,
    shopify: draftSnapshotOf({ customerId: "77", items: [{ ...hat("Black", 4), custom: false }] }),
  });
  await seedOrder(db, WS, { id: "o_casey", statusKey: "new", createdAt: NOW - DAY, shopify: snapshotOf({ customerId: "78", customerName: "Casey Lin", email: "casey@example.com" }) });
  await seedOrder(db, OTHER, { id: "x_riley", shopify: riley() });
  await setOrderLocation(db, "o_open", "loc_north");
  await indexOrders(db, WS, ["o_done", "o_old", "d_rejected", "o_casey", "o_open"]);
  await indexOrders(db, OTHER, ["x_riley"]);
  return db;
}

async function personId(db: Db, workspaceId: string, customerId: string) {
  const rows = await db.select().from(schema.people).where(eq(schema.people.shopifyCustomerId, customerId));
  return rows.find((row) => row.workspaceId === workspaceId)!.id;
}

describe("listPeople", () => {
  it("lists the workspace's people, latest first, with open and total cards", async () => {
    const db = await setup();
    const { people, total } = await listPeople(db, WS);
    expect(total).toBe(2);
    expect(people.map((person) => [person.name, person.openCount, person.cardCount, person.locationName])).toEqual([
      ["Casey Lin", 1, 1, null],
      ["Riley Oakes", 1, 4, "North Yard"],
    ]);
  });

  it("finds people by name or email", async () => {
    const db = await setup();
    expect((await listPeople(db, WS, { q: "RILEY" })).people.map((person) => person.name)).toEqual(["Riley Oakes"]);
    expect((await listPeople(db, WS, { q: "casey@" })).people.map((person) => person.name)).toEqual(["Casey Lin"]);
    expect((await listPeople(db, WS, { q: "nobody" })).people).toEqual([]);
  });

  it("finds a name with an uppercase accented letter however it is typed", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o_oscar", statusKey: "new", createdAt: NOW - DAY, shopify: snapshotOf({ customerId: "79", customerName: "Óscar Vale", email: "oscar@example.com" }) });
    await indexOrders(db, WS, ["o_oscar"]);
    for (const q of ["Óscar", "óscar", "ÓSCAR", "vale", "óscar vale"]) {
      const found = await listPeople(db, WS, { q });
      expect(found.people.map((person) => person.name), q).toEqual(["Óscar Vale"]);
      expect(found.total, q).toBe(1);
    }
    expect((await listPeople(db, WS, { q: "óscar riley" })).people).toEqual([]);
  });

  // The MCP tools (src/mcp/tools/lookup.ts) show and match the stored name
  // only: the display name falls back to the email.
  it("keeps the stored name beside the display name, and matches the text a caller picks", async () => {
    const db = await setup();
    await db.update(schema.people).set({ name: null }).where(eq(schema.people.shopifyCustomerId, "78"));
    const all = await listPeople(db, WS);
    expect(all.people.map((person) => [person.name, person.storedName])).toEqual([
      ["casey@example.com", null],
      ["Riley Oakes", "Riley Oakes"],
    ]);
    const byName = (person: { name: string | null }) => person.name ?? "";
    expect((await listPeople(db, WS, { q: "casey", matchOn: byName })).total).toBe(0);
    expect((await listPeople(db, WS, { q: "riley@", matchOn: byName })).total).toBe(0);
    expect((await listPeople(db, WS, { q: "riley", matchOn: byName })).people.map((person) => person.storedName)).toEqual(["Riley Oakes"]);
    const page = await getPersonPage(db, WS, await personId(db, WS, "78"), NOW);
    expect(page?.person).toMatchObject({ name: "casey@example.com", storedName: null });
  });

  it("lists at most PEOPLE_LIST_MAX people but counts every match", async () => {
    const db = await setup();
    const extra = Array.from({ length: PEOPLE_LIST_MAX + 5 }, (_, i) => ({
      id: `p_extra_${i}`,
      workspaceId: WS,
      shopifyCustomerId: `9${i}`,
      name: `Ávila Stone ${i}`,
      email: `avila${i}@example.com`,
      firstSeenAt: NOW - DAY,
      lastSeenAt: NOW - i,
    }));
    for (let start = 0; start < extra.length; start += 20) {
      await db.insert(schema.people).values(extra.slice(start, start + 20));
    }
    const found = await listPeople(db, WS, { q: "ávila" });
    expect(found.total).toBe(PEOPLE_LIST_MAX + 5);
    expect(found.people).toHaveLength(PEOPLE_LIST_MAX);
    expect(found.people[0]?.name).toBe("Ávila Stone 0");
    expect((await listPeople(db, WS)).total).toBe(PEOPLE_LIST_MAX + 7);
  });
});

describe("getPersonPage", () => {
  it("shows who they are, their counts, their items over the last year and every card", async () => {
    const db = await setup();
    const page = await getPersonPage(db, WS, await personId(db, WS, "77"), NOW);
    expect(page?.person).toMatchObject({ name: "Riley Oakes", email: "riley@example.com", homeLocation: { id: "loc_north", name: "North Yard" } });
    expect(page?.counts).toEqual({ open: 1, approved: 3, rejected: 1, cancelled: 0, cards: 4 });
    expect(page?.items).toEqual([{ title: "Hard Hat", variant: "White", quantity: 3 }]);
    expect(page?.cards.map((card) => card.id)).toEqual(["o_open", "d_rejected", "o_done", "o_old"]);
    expect(page?.timeZone).toBe("America/New_York");
  });

  // Migration 0012 never moved orders Shopify had already cancelled, a
  // workspace with 20 statuses got no Cancelled status, and a manager may
  // move a card out of it: Shopify's cancelledAt counts as cancelled too.
  it("counts an order Shopify cancelled outside the Cancelled status as cancelled and leaves its items out", async () => {
    const db = await setup();
    await seedCancelledStatus(db, WS);
    const riley = (extra: Record<string, unknown>) => snapshotOf({ customerId: "77", customerName: "Riley Oakes", email: "riley@example.com", ...extra });
    await seedOrder(db, WS, {
      id: "o_shop_cancelled",
      statusKey: "shipped",
      createdAt: NOW - 3 * DAY,
      shopify: riley({ items: [hat("Orange", 8)], cancelledAt: NOW - 2 * DAY }),
    });
    await seedOrder(db, WS, {
      id: "o_in_cancelled",
      statusKey: "cancelled",
      createdAt: NOW - 4 * DAY,
      shopify: riley({ items: [hat("Red", 5)], cancelledAt: NOW - 3 * DAY }),
    });
    await indexOrders(db, WS, ["o_shop_cancelled", "o_in_cancelled"]);
    const page = await getPersonPage(db, WS, await personId(db, WS, "77"), NOW);
    expect(page?.counts).toEqual({ open: 1, approved: 3, rejected: 1, cancelled: 2, cards: 6 });
    expect(page?.items).toEqual([{ title: "Hard Hat", variant: "White", quantity: 3 }]);
    expect(page?.cards.find((card) => card.id === "o_shop_cancelled")).toMatchObject({ statusKey: "shipped", cancelled: true });
  });

  it("is null for an unknown person or another workspace's person", async () => {
    const db = await setup();
    expect(await getPersonPage(db, WS, "nobody", NOW)).toBeNull();
    expect(await getPersonPage(db, WS, await personId(db, OTHER, "77"), NOW)).toBeNull();
  });
});
