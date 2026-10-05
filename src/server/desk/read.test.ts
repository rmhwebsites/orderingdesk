import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import {
  EVENT_FEED_CAP,
  ORDER_LIST_CAP,
  getOrderDetail,
  listEvents,
  loadDesk,
} from "./read";
import { openTestDb, seedOrder, seedWorkspace, snapshotOf } from "./test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  return db;
}

async function seedEvent(
  db: Db,
  workspaceId: string,
  opts: { id: string; createdAt: number; orderId?: string | null; text?: string },
) {
  await db.insert(schema.events).values({
    id: opts.id,
    workspaceId,
    orderId: opts.orderId ?? null,
    type: "note",
    text: opts.text ?? "note " + opts.id,
    actorId: "user_marta",
    createdAt: opts.createdAt,
  });
}

describe("loadDesk", () => {
  it("returns the workspace, statuses by sort, and the settings row", async () => {
    const db = await setup();
    await db
      .update(schema.workspaceSettings)
      .set({ notificationEmails: ["desk@example.com"], poPrefix: "IMP", replyTo: "ops@example.com" })
      .where(eq(schema.workspaceSettings.workspaceId, WS));
    // Reverse the stored sort of two statuses: the payload must follow sort,
    // not insertion order.
    await db.update(schema.statuses).set({ sort: 9 }).where(eq(schema.statuses.id, WS + "_st_new"));

    const desk = await loadDesk(db, WS);
    expect(desk).not.toBeNull();
    expect(desk?.workspace).toEqual({
      id: WS,
      name: "Workspace " + WS,
      slug: WS,
      accentColor: "#91d500",
    });
    expect(desk?.statuses.map((s) => s.key)).toEqual(["processing", "approved", "shipped", "new"]);
    expect(desk?.statuses[1]).toEqual({
      key: "approved",
      label: "Approved",
      color: "green",
      sort: 2,
      triggersPo: true,
      shopifyLink: null,
    });
    expect(desk?.settings).toEqual({
      notificationEmails: ["desk@example.com"],
      poPrefix: "IMP",
      replyTo: "ops@example.com",
      fromName: null,
    });
  });

  it("derives each summary from the snapshot and never sends the snapshot itself", async () => {
    const db = await setup();
    await seedOrder(db, WS, {
      id: "o1",
      name: "#1001",
      statusKey: "approved",
      createdAt: 5000,
      syncedAt: 6000,
      shopify: snapshotOf({
        items: [
          { title: "Hard Hat", qty: 3 },
          { title: "Safety Vest", qty: 2 },
          { title: "Caster Wheel", qty: 1 },
          { title: "Ladder", qty: 4 },
        ],
      }),
    });
    await db
      .update(schema.orders)
      .set({ statusSetBy: "user_marta", statusSetAt: 5500 })
      .where(eq(schema.orders.id, "o1"));

    const desk = await loadDesk(db, WS);
    expect(desk?.orders).toEqual([
      {
        id: "o1",
        name: "#1001",
        statusKey: "approved",
        statusSetBy: "user_marta",
        statusSetAt: 5500,
        createdAt: 5000,
        syncedAt: 6000,
        customerName: "Riley Oakes",
        email: "riley.oakes@example.com",
        total: "120.00",
        currency: "CAD",
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        itemCount: 10,
        itemsPreview: ["3 x Hard Hat", "2 x Safety Vest", "1 x Caster Wheel"],
        // Every title, so a desk search covers items past the preview.
        itemTitles: ["Hard Hat", "Safety Vest", "Caster Wheel", "Ladder"],
        itemsTruncated: false,
      },
    ]);
    expect(JSON.stringify(desk)).not.toContain("shipping");
  });

  // The sync marks an order whose line items did not fit the fetched page;
  // only an explicit false means the stored list is whole (a snapshot stored
  // before the marker existed has no key and counts as unconfirmed).
  it("carries the line item truncation marker, reading anything but false as truncated", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "whole", createdAt: 3, shopify: snapshotOf({ itemsTruncated: false }) });
    await seedOrder(db, WS, { id: "partial", createdAt: 2, shopify: snapshotOf({ itemsTruncated: true }) });
    const legacy = snapshotOf();
    delete legacy.itemsTruncated;
    await seedOrder(db, WS, { id: "legacy", createdAt: 1, shopify: legacy });

    const desk = await loadDesk(db, WS);
    expect(desk?.orders.map((o) => [o.id, o.itemsTruncated])).toEqual([
      ["whole", false],
      ["partial", true],
      ["legacy", true],
    ]);
  });

  it("degrades a malformed snapshot to empty fields instead of throwing", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o_array", shopify: ["not", "a", "snapshot"], createdAt: 2 });
    await seedOrder(db, WS, {
      id: "o_odd",
      createdAt: 1,
      shopify: { items: [{ title: 7 }, "junk", { title: "Rope", qty: "lots" }], total: 99 },
    });

    const desk = await loadDesk(db, WS);
    const [arraySnapshot, oddSnapshot] = desk?.orders ?? [];
    expect(arraySnapshot).toMatchObject({
      id: "o_array",
      customerName: "",
      email: "",
      total: "",
      itemCount: 0,
      itemsPreview: [],
      itemTitles: [],
    });
    // A quantity that is not a finite number counts as 1, as in the
    // normalizer; an empty title gets a readable placeholder in the preview
    // and is left out of the searchable titles.
    expect(oddSnapshot).toMatchObject({
      id: "o_odd",
      total: "",
      itemCount: 2,
      itemsPreview: ["1 x Untitled item", "1 x Rope"],
      itemTitles: ["Rope"],
    });
  });

  it("lists orders newest first and pins the list cap at 1000 with hasMore", async () => {
    const db = await setup();
    expect(ORDER_LIST_CAP).toBe(1000);
    const rows = Array.from({ length: ORDER_LIST_CAP + 1 }, (_, i) => ({
      id: `o${String(i).padStart(4, "0")}`,
      workspaceId: WS,
      shopifyOrderId: String(9000 + i),
      name: `#${9000 + i}`,
      shopify: snapshotOf(),
      statusKey: "new",
      createdAt: 100000 + i,
      syncedAt: 1,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(schema.orders).values(rows.slice(i, i + 200));
    }

    const desk = await loadDesk(db, WS);
    expect(desk?.orders).toHaveLength(ORDER_LIST_CAP);
    expect(desk?.hasMore).toBe(true);
    // The oldest order is the one left out.
    expect(desk?.orders[0].id).toBe("o1000");
    expect(desk?.orders[ORDER_LIST_CAP - 1].id).toBe("o0001");
  });

  it("reports hasMore only when more orders exist than the limit", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "a", createdAt: 1 });
    await seedOrder(db, WS, { id: "b", createdAt: 2 });

    const exact = await loadDesk(db, WS, { limit: 2 });
    expect(exact?.orders.map((o) => o.id)).toEqual(["b", "a"]);
    expect(exact?.hasMore).toBe(false);

    await seedOrder(db, WS, { id: "c", createdAt: 3 });
    const over = await loadDesk(db, WS, { limit: 2 });
    expect(over?.orders.map((o) => o.id)).toEqual(["c", "b"]);
    expect(over?.hasMore).toBe(true);
  });

  it("counts every order per status, beyond the list limit, with zero for unused statuses", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "a", statusKey: "new", createdAt: 1 });
    await seedOrder(db, WS, { id: "b", statusKey: "new", createdAt: 2 });
    await seedOrder(db, WS, { id: "c", statusKey: "approved", createdAt: 3 });
    // An order whose status was removed out from under it still counts.
    await seedOrder(db, WS, { id: "d", statusKey: "retired", createdAt: 4 });
    await seedOrder(db, OTHER, { id: "x", statusKey: "new", createdAt: 5 });

    const desk = await loadDesk(db, WS, { limit: 1 });
    expect(desk?.orders).toHaveLength(1);
    expect(desk?.statusCounts).toEqual({
      new: 2,
      processing: 0,
      approved: 1,
      shipped: 0,
      retired: 1,
    });
  });

  it("keeps other workspaces' orders and statuses out", async () => {
    const db = await setup();
    await seedOrder(db, OTHER, { id: "x" });
    await db.insert(schema.statuses).values({
      id: "other_extra",
      workspaceId: OTHER,
      key: "other_only",
      label: "Other only",
      color: "pink",
      sort: 99,
    });

    const desk = await loadDesk(db, WS);
    expect(desk?.orders).toEqual([]);
    expect(desk?.hasMore).toBe(false);
    expect(desk?.statuses.map((s) => s.key)).not.toContain("other_only");
  });

  it("returns null for a workspace that does not exist", async () => {
    const db = await setup();
    expect(await loadDesk(db, "ws_missing")).toBeNull();
  });
});

describe("getOrderDetail", () => {
  it("returns the full row including the full snapshot", async () => {
    const db = await setup();
    const shopify = snapshotOf({
      shipping: { name: "Riley Oakes", a1: "1 Main St", a2: "", city: "Halifax", prov: "NS", zip: "B3H", country: "CA" },
      note: "Leave at the side door",
    });
    await seedOrder(db, WS, { id: "o1", shopify, createdAt: 10, syncedAt: 20 });

    const detail = await getOrderDetail(db, WS, "o1");
    expect(detail).toEqual({
      order: {
        id: "o1",
        workspaceId: WS,
        shopifyOrderId: "shop-o1",
        name: "#o1",
        shopify,
        statusKey: "new",
        statusSetBy: null,
        statusSetAt: null,
        createdAt: 10,
        syncedAt: 20,
        notifiedAt: null,
        // Draft columns (migration 0010): null for a card that never was a
        // draft.
        shopifyDraftId: null,
        draftName: null,
        draftSnapshot: null,
        draftDeletedAt: null,
      },
      itemsTruncated: false,
    });
  });

  it("computes itemsTruncated with the same rule as the list: anything but false is truncated", async () => {
    const db = await setup();
    const legacy = snapshotOf();
    delete legacy.itemsTruncated;
    await seedOrder(db, WS, { id: "partial", shopify: snapshotOf({ itemsTruncated: true }) });
    await seedOrder(db, WS, { id: "legacy", shopify: legacy });
    await seedOrder(db, WS, { id: "odd", shopify: ["not", "a", "snapshot"] });
    for (const id of ["partial", "legacy", "odd"]) {
      expect((await getOrderDetail(db, WS, id))?.itemsTruncated, id).toBe(true);
    }
  });

  it("returns null for an order that belongs to another workspace", async () => {
    const db = await setup();
    await seedOrder(db, OTHER, { id: "x" });
    expect(await getOrderDetail(db, WS, "x")).toBeNull();
    expect(await getOrderDetail(db, WS, "missing")).toBeNull();
  });
});

describe("listEvents", () => {
  it("returns the latest 300 workspace events, newest first", async () => {
    const db = await setup();
    expect(EVENT_FEED_CAP).toBe(300);
    const rows = Array.from({ length: EVENT_FEED_CAP + 1 }, (_, i) => ({
      id: `e${String(i).padStart(3, "0")}`,
      workspaceId: WS,
      orderId: null,
      type: "sync_error" as const,
      text: "event " + i,
      createdAt: 1000 + i,
      source: "system" as const,
    }));
    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(schema.events).values(rows.slice(i, i + 100));
    }
    await seedEvent(db, OTHER, { id: "other_newest", createdAt: 999999 });

    const result = await listEvents(db, WS, null);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.events).toHaveLength(EVENT_FEED_CAP);
      expect(result.events[0]).toEqual({
        id: "e300",
        orderId: null,
        type: "sync_error",
        text: "event 300",
        actorId: null,
        meta: null,
        createdAt: 1300,
        source: "system",
      });
      expect(result.events[EVENT_FEED_CAP - 1].id).toBe("e001");
      expect(result.events.map((e) => e.id)).not.toContain("other_newest");
    }
  });

  it("returns one order's full timeline, newest first", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1" });
    await seedOrder(db, WS, { id: "o2" });
    await seedEvent(db, WS, { id: "t1", orderId: "o1", createdAt: 10 });
    await seedEvent(db, WS, { id: "t2", orderId: "o2", createdAt: 20 });
    await seedEvent(db, WS, { id: "t3", orderId: "o1", createdAt: 30 });
    await seedEvent(db, WS, { id: "t4", orderId: null, createdAt: 40 });

    const result = await listEvents(db, WS, "o1");
    expect(result).toEqual({
      kind: "ok",
      events: [
        expect.objectContaining({ id: "t3", orderId: "o1" }),
        expect.objectContaining({ id: "t1", orderId: "o1" }),
      ],
    });
  });

  it("is not-found for an order outside this workspace, or no order at all", async () => {
    const db = await setup();
    await seedOrder(db, OTHER, { id: "x" });
    await seedEvent(db, OTHER, { id: "secret", orderId: "x", createdAt: 1 });

    expect(await listEvents(db, WS, "x")).toEqual({ kind: "not-found" });
    expect(await listEvents(db, WS, "missing")).toEqual({ kind: "not-found" });
    expect(await listEvents(db, WS, "")).toEqual({ kind: "not-found" });
  });
});
