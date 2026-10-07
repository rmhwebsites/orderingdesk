import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { DESK_PAGE_MAX, EMPTY_QUERY, type DeskQuery } from "@/lib/desk-query";
import { indexOrders } from "./index-orders";
import { decodeCursor, likePattern, searchOrders, type SearchPage } from "./query";
import {
  draftSnapshotOf,
  openTestDb,
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
// Monday, October 5, 2026, 10:00 in New York.
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const ctx = { now: NOW, timeZone: "America/New_York" };
const q = (overrides: Partial<DeskQuery> = {}): DeskQuery => ({ ...EMPTY_QUERY, ...overrides });
const ids = (page: SearchPage) => page.orders.map((entry) => entry.row.id);
const item = (title: string, sku: string, variant = "", props: { key: string; value: string }[] = []) => ({ title, qty: 1, sku, variant, props });

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  await setStatusClosed(db, WS, "shipped", true);
  await seedLocation(db, WS, { shopifyLocationId: "loc_north", name: "North Yard" });
  await seedLocation(db, WS, { shopifyLocationId: "loc_harbor", name: "Harbor Point" });
  await seedOrder(db, WS, {
    id: "o_hat",
    name: "#1024",
    statusKey: "new",
    createdAt: NOW - 2 * DAY,
    shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes", items: [item("Hard Hat", "HH-1", "White")] }),
  });
  await seedOrder(db, WS, {
    id: "o_cards",
    name: "#10245",
    statusKey: "shipped",
    createdAt: NOW - 40 * DAY,
    shopify: snapshotOf({
      customerId: "78",
      customerName: "Casey Lin",
      email: "casey@example.com",
      items: [item("Business Cards", "BC-500", "Matte", [{ key: "Name", value: "Avery Stone" }])],
    }),
  });
  await seedOrder(db, WS, {
    id: "o_pct",
    name: "#1030",
    statusKey: "processing",
    createdAt: NOW - 5 * DAY,
    shopify: snapshotOf({ customerName: "Jordan Vale", email: "jordan@example.com", items: [item("Decal 100% vinyl", "DC_1")] }),
  });
  await seedDraft(db, WS, {
    id: "d_new",
    name: "#D19",
    createdAt: NOW - DAY,
    shopify: draftSnapshotOf({ shopifyDraftId: "d-d_new", name: "#D19", items: [{ ...item("Safety Vest", "SV-2", "Large"), custom: false }] }),
  });
  await seedDraft(db, WS, { id: "d_gone", name: "#D20", createdAt: NOW - 3 * DAY, draftDeletedAt: NOW - DAY });
  await seedOrder(db, OTHER, { id: "x_hat", name: "#1024", shopify: snapshotOf({ items: [item("Hard Hat", "HH-1")] }) });
  await setOrderLocation(db, "o_hat", "loc_north");
  await setOrderLocation(db, "o_cards", "loc_north");
  await setOrderLocation(db, "d_new", "loc_harbor");
  await indexOrders(db, WS, ["o_hat", "o_cards", "o_pct", "d_new", "d_gone"]);
  await indexOrders(db, OTHER, ["x_hat"]);
  return db;
}

async function personId(db: Db, customerId: string) {
  return (await db.select().from(schema.people).where(eq(schema.people.shopifyCustomerId, customerId)))[0].id;
}

describe("searchOrders filters", () => {
  it("opens on open cards, newest first, without deleted requests", async () => {
    const db = await setup();
    const page = await searchOrders(db, WS, q(), ctx);
    expect(ids(page)).toEqual(["d_new", "o_hat", "o_pct"]);
    expect(page.total).toBe(3);
    expect(page.nextCursor).toBeNull();
  });

  // Owner decision (Wave 1c): plain words search every card, open and
  // closed, whatever view is picked; without them the view counts again.
  it("searches every card for words whatever the view, and the view again without them", async () => {
    const db = await setup();
    for (const view of ["open", "approval", "all", "closed"] as const) {
      expect(ids(await searchOrders(db, WS, q({ q: "business", view }), ctx)), view).toEqual(["o_cards"]);
      expect(ids(await searchOrders(db, WS, q({ q: "hard hat", view }), ctx)), view).toEqual(["o_hat"]);
    }
    expect(ids(await searchOrders(db, WS, q({ q: "   " }), ctx))).toEqual(["d_new", "o_hat", "o_pct"]);
    // The filters AI search fills in keep the view it chose.
    expect(ids(await searchOrders(db, WS, q({ person: "avery" }), ctx))).toEqual([]);
    expect(ids(await searchOrders(db, WS, q({ person: "avery", view: "all" }), ctx))).toEqual(["o_cards"]);
  });

  it("needs every word, ignores case, and matches SKUs, sizes and personalization", async () => {
    const db = await setup();
    expect(ids(await searchOrders(db, WS, q({ q: "HARD white" }), ctx))).toEqual(["o_hat"]);
    expect(ids(await searchOrders(db, WS, q({ q: "hh-1" }), ctx))).toEqual(["o_hat"]);
    expect(ids(await searchOrders(db, WS, q({ q: "avery", view: "all" }), ctx))).toEqual(["o_cards"]);
    expect(ids(await searchOrders(db, WS, q({ q: "hard business" }), ctx))).toEqual([]);
  });

  it("takes % and _ literally", async () => {
    const db = await setup();
    expect(likePattern("100%_x")).toBe("%100\\%\\_x%");
    expect(ids(await searchOrders(db, WS, q({ q: "100%" }), ctx))).toEqual(["o_pct"]);
    expect(ids(await searchOrders(db, WS, q({ q: "_" }), ctx))).toEqual(["o_pct"]);
  });

  it("filters by view and kind", async () => {
    const db = await setup();
    expect(ids(await searchOrders(db, WS, q({ view: "closed" }), ctx))).toEqual(["o_cards"]);
    expect(ids(await searchOrders(db, WS, q({ view: "approval" }), ctx))).toEqual(["d_new"]);
    expect(ids(await searchOrders(db, WS, q({ view: "all" }), ctx))).toEqual(["d_new", "o_hat", "o_pct", "o_cards"]);
    expect(ids(await searchOrders(db, WS, q({ view: "all", kind: "drafts" }), ctx))).toEqual(["d_new"]);
    expect(ids(await searchOrders(db, WS, q({ view: "all", kind: "deleted" }), ctx))).toEqual(["d_gone"]);
    expect(ids(await searchOrders(db, WS, q({ view: "all", kind: "orders" }), ctx))).toEqual(["o_hat", "o_pct", "o_cards"]);
    // The approval queue shows every kind (the desk hides its kind filter).
    expect(ids(await searchOrders(db, WS, q({ view: "approval", kind: "orders" }), ctx))).toEqual(["d_new"]);
  });

  // Wave 1a final review: a rejected request never waits for approval.
  it("leaves a rejected request out of the approval queue by its status's link, closed or not", async () => {
    const db = await setup();
    await seedDraftStatuses(db, WS);
    await setStatusClosed(db, WS, "rejected", false);
    await seedDraft(db, WS, { id: "d_rejected", statusKey: "rejected", createdAt: NOW });
    expect(ids(await searchOrders(db, WS, q({ view: "approval" }), ctx))).toEqual(["d_new"]);
    expect(ids(await searchOrders(db, WS, q(), ctx))[0]).toBe("d_rejected");
  });

  it("filters by status, location, requester and number, and reads each card's location name", async () => {
    const db = await setup();
    expect(ids(await searchOrders(db, WS, q({ view: "all", status: "new" }), ctx))).toEqual(["d_new", "o_hat"]);
    const page = await searchOrders(db, WS, q({ view: "all", status: "processing" }), ctx);
    expect(ids(page)).toEqual(["o_pct"]);
    expect((await searchOrders(db, WS, q(), ctx)).orders.find((entry) => entry.row.id === "o_hat")?.locationName).toBe("North Yard");
    expect(ids(await searchOrders(db, WS, q({ view: "all", locations: ["loc_north"] }), ctx))).toEqual(["o_hat", "o_cards"]);
    expect(ids(await searchOrders(db, WS, q({ requester: await personId(db, "77") }), ctx))).toEqual(["o_hat"]);
    expect(ids(await searchOrders(db, WS, q({ number: "#1024" }), ctx))).toEqual(["o_hat"]);
    expect(ids(await searchOrders(db, WS, q({ number: "#d19" }), ctx))).toEqual(["d_new"]);
  });

  it("reads dates in the workspace's time zone", async () => {
    const db = await setup();
    // 23:30 on Sunday and 00:30 on Monday, New York time.
    await seedOrder(db, WS, { id: "o_late", createdAt: Date.parse("2026-10-05T03:30:00.000Z") });
    await seedOrder(db, WS, { id: "o_early", createdAt: Date.parse("2026-10-05T04:30:00.000Z") });
    expect(ids(await searchOrders(db, WS, q({ date: "today" }), ctx))).toEqual(["o_early"]);
    expect(ids(await searchOrders(db, WS, q({ date: "yesterday" }), ctx))).toEqual(["o_late", "d_new"]);
    expect(ids(await searchOrders(db, WS, q({ from: "2026-08-20", to: "2026-08-31", view: "all" }), ctx))).toEqual(["o_cards"]);
  });

  it("filters by days waiting in the current status", async () => {
    const db = await setup();
    expect(ids(await searchOrders(db, WS, q({ view: "all", older: 3 }), ctx))).toEqual(["o_pct", "o_cards"]);
    expect(ids(await searchOrders(db, WS, q({ newer: 3 }), ctx))).toEqual(["d_new", "o_hat"]);
  });

  it("never returns another workspace's cards", async () => {
    const db = await setup();
    const page = await searchOrders(db, WS, q({ q: "hard hat" }), ctx);
    expect(ids(page)).toEqual(["o_hat"]);
  });

  it("lists a card the index has not reached yet, but words cannot find it until then", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o_fresh", createdAt: NOW, shopify: snapshotOf({ customerName: "Riley Oakes" }) });
    expect(ids(await searchOrders(db, WS, q(), ctx))[0]).toBe("o_fresh");
    expect(ids(await searchOrders(db, WS, q({ q: "riley" }), ctx))).toEqual(["o_hat"]);
  });
});

describe("searchOrders sorting and pages", () => {
  it("sorts oldest first and by time waiting", async () => {
    const db = await setup();
    expect(ids(await searchOrders(db, WS, q({ sort: "oldest" }), ctx))).toEqual(["o_pct", "o_hat", "d_new"]);
    await db.update(schema.orders).set({ statusSetAt: NOW - 10 * DAY }).where(eq(schema.orders.id, "d_new"));
    expect(ids(await searchOrders(db, WS, q({ sort: "waiting" }), ctx))).toEqual(["d_new", "o_pct", "o_hat"]);
  });

  it("pages through more than a thousand cards with no card twice", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    const rows = Array.from({ length: 1050 }, (_, i) => ({
      id: `o${String(i).padStart(4, "0")}`,
      workspaceId: WS,
      shopifyOrderId: String(9000 + i),
      name: `#${9000 + i}`,
      shopify: snapshotOf(),
      statusKey: "new",
      createdAt: 100000 + i,
      syncedAt: 1,
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await db.insert(schema.orders).values(rows.slice(i, i + 50));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: SearchPage = await searchOrders(db, WS, q(), { ...ctx, limit: 500, cursor });
      expect(page.total).toBe(1050);
      seen.push(...ids(page));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(1050);
    expect(seen[0]).toBe("o1049");
    expect(seen[1049]).toBe("o0000");
    expect((await searchOrders(db, WS, q(), { ...ctx, limit: 5000 })).orders).toHaveLength(DESK_PAGE_MAX);
  });

  it("starts over on a cursor it cannot read", async () => {
    expect(decodeCursor("junk")).toBeNull();
    expect(decodeCursor("12~o1")).toEqual({ value: 12, id: "o1" });
    const db = await setup();
    expect(ids(await searchOrders(db, WS, q(), { ...ctx, cursor: "junk" }))).toEqual(["d_new", "o_hat", "o_pct"]);
  });
});
