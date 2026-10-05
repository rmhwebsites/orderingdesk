import { describe, it, expect } from "vitest";
import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
import {
  applyLiveEvent,
  arrivalNotice,
  deskKindCounts,
  optimisticStatus,
  rollbackStatus,
  selectOrders,
  statusChips,
  totalOrders,
  touchesPurchaseOrders,
  type DeskState,
} from "./desk-state";

const ME = "user_me";
const MARTA = "user_marta";

function order(id: string, overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id,
    name: "#" + id,
    statusKey: "new",
    statusSetBy: null,
    statusSetAt: null,
    createdAt: 1000,
    syncedAt: 2000,
    customerName: "Riley Oakes",
    email: "riley.oakes@example.com",
    total: "120.00",
    currency: "CAD",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    itemCount: 1,
    itemsPreview: ["1 x Hard Hat"],
    itemTitles: ["Hard Hat"],
    itemsTruncated: false,
    kind: "order",
    draftName: null,
    draftStatus: null,
    draftDeleted: false,
    company: "",
    location: "",
    requestFor: "",
    branch: "",
    searchText: [],
    ...overrides,
  };
}

function timelineEvent(id: string, overrides: Partial<EventView> = {}): EventView {
  return {
    id,
    orderId: "o1",
    type: "note",
    text: "note " + id,
    actorId: MARTA,
    meta: null,
    createdAt: 5000,
    source: "app",
    ...overrides,
  };
}

function state(overrides: Partial<DeskState> = {}): DeskState {
  return {
    orders: [order("o1"), order("o2", { statusKey: "processing", statusSetAt: 3000 })],
    statusCounts: { new: 1, processing: 1, shipped: 0 },
    timeline: null,
    ...overrides,
  };
}

function statusEvent(orderId: string, from: string, to: string, at: number, actor = MARTA) {
  return {
    kind: "order.status" as const,
    event: timelineEvent("se-" + orderId + "-" + at, {
      orderId,
      type: "status",
      text: "Status set to " + to,
      actorId: actor,
      meta: { from, to },
      createdAt: at,
    }),
    order: { id: orderId, statusKey: to, statusSetBy: actor, statusSetAt: at },
  };
}

describe("applyLiveEvent: orders.synced", () => {
  it("asks for a refetch and names the new orders to announce", () => {
    const before = state();
    const { state: after, effects } = applyLiveEvent(
      before,
      { kind: "orders.synced", addedOrderIds: ["o9"], updatedOrderIds: ["o2"] },
      ME,
    );
    expect(after).toBe(before);
    expect(effects).toEqual({
      refetch: true,
      reloadOpenOrder: false,
      announceOrderIds: ["o9"],
      flashOrderIds: ["o9", "o2"],
    });
  });

  it("reloads the open order when its snapshot changed", () => {
    const { effects } = applyLiveEvent(
      state({ timeline: { orderId: "o2", events: [] } }),
      { kind: "orders.synced", addedOrderIds: [], updatedOrderIds: ["o2"] },
      ME,
    );
    expect(effects.reloadOpenOrder).toBe(true);
  });

  it("does nothing for an empty sync", () => {
    const { effects } = applyLiveEvent(
      state(),
      { kind: "orders.synced", addedOrderIds: [], updatedOrderIds: [] },
      ME,
    );
    expect(effects.refetch).toBe(false);
  });
});

describe("applyLiveEvent: orders.imported", () => {
  // Older orders from the order history import: the list refreshes, but
  // nothing is announced as new or flashed.
  it("asks for a refetch and announces nothing", () => {
    const before = state();
    const { state: after, effects } = applyLiveEvent(before, { kind: "orders.imported", count: 40 }, ME);
    expect(after).toBe(before);
    expect(effects).toEqual({ refetch: true, reloadOpenOrder: false, announceOrderIds: [], flashOrderIds: [] });
  });
});

describe("applyLiveEvent: order.status", () => {
  it("moves the row and the counts, and flashes a change made by someone else", () => {
    const { state: after, effects } = applyLiveEvent(state(), statusEvent("o1", "new", "shipped", 4000), ME);
    expect(after.orders[0]).toMatchObject({ statusKey: "shipped", statusSetBy: MARTA, statusSetAt: 4000 });
    expect(after.statusCounts).toEqual({ new: 0, processing: 1, shipped: 1 });
    expect(effects.flashOrderIds).toEqual(["o1"]);
    expect(effects.refetch).toBe(false);
  });

  it("does not flash a change this user made", () => {
    const { effects } = applyLiveEvent(state(), statusEvent("o1", "new", "shipped", 4000, ME), ME);
    expect(effects.flashOrderIds).toEqual([]);
  });

  it("treats the echo of an optimistic change as a confirmation (no double count)", () => {
    const optimistic = optimisticStatus(state(), "o1", "shipped");
    expect(optimistic).not.toBeNull();
    const { state: after } = applyLiveEvent(optimistic!.state, statusEvent("o1", "new", "shipped", 4000, ME), ME);
    expect(after.statusCounts).toEqual({ new: 0, processing: 1, shipped: 1 });
    expect(after.orders[0]).toMatchObject({ statusKey: "shipped", statusSetAt: 4000, statusSetBy: ME });
  });

  it("ignores an event older than the row's current status", () => {
    const before = state();
    const { state: after } = applyLiveEvent(before, statusEvent("o2", "new", "shipped", 2000), ME);
    expect(after.orders[1].statusKey).toBe("processing");
    expect(after.statusCounts).toEqual(before.statusCounts);
  });

  it("moves an unknown status key's count and drops it at zero", () => {
    const before = state({
      orders: [order("o1", { statusKey: "legacy_review" })],
      statusCounts: { new: 0, legacy_review: 1 },
    });
    const { state: after } = applyLiveEvent(before, statusEvent("o1", "legacy_review", "new", 4000), ME);
    expect(after.statusCounts).toEqual({ new: 1, legacy_review: 0 });
  });

  it("adjusts the counts from the event for an order outside the loaded list", () => {
    const { state: after } = applyLiveEvent(state(), statusEvent("o-old", "processing", "shipped", 4000), ME);
    expect(after.statusCounts).toEqual({ new: 1, processing: 0, shipped: 1 });
    expect(after.orders).toHaveLength(2);
  });

  it("prepends the entry to the open drawer's timeline once", () => {
    const opened = state({ timeline: { orderId: "o1", events: [timelineEvent("e-old", { createdAt: 3000 })] } });
    const event = statusEvent("o1", "new", "shipped", 4000);
    const once = applyLiveEvent(opened, event, ME).state;
    const twice = applyLiveEvent(once, event, ME).state;
    expect(twice.timeline?.events.map((e) => e.id)).toEqual([event.event.id, "e-old"]);
  });

  it("leaves another order's timeline alone", () => {
    const opened = state({ timeline: { orderId: "o2", events: [] } });
    const { state: after } = applyLiveEvent(opened, statusEvent("o1", "new", "shipped", 4000), ME);
    expect(after.timeline).toEqual({ orderId: "o2", events: [] });
  });
});

describe("applyLiveEvent: order.note", () => {
  it("appends to the open drawer's timeline newest first, deduped by id", () => {
    const opened = state({ timeline: { orderId: "o1", events: [timelineEvent("e1", { createdAt: 3000 })] } });
    const note = { kind: "order.note" as const, event: timelineEvent("e2", { createdAt: 6000 }) };
    const after = applyLiveEvent(applyLiveEvent(opened, note, ME).state, note, ME);
    expect(after.state.timeline?.events.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(after.state.orders).toBe(opened.orders);
    expect(after.effects.flashOrderIds).toEqual(["o1"]);
  });

  it("keeps the timeline sorted when an older event arrives late", () => {
    const opened = state({ timeline: { orderId: "o1", events: [timelineEvent("e3", { createdAt: 9000 })] } });
    const late = { kind: "order.note" as const, event: timelineEvent("e1", { createdAt: 1000 }) };
    expect(applyLiveEvent(opened, late, ME).state.timeline?.events.map((e) => e.id)).toEqual(["e3", "e1"]);
  });

  it("does not flash a note this user wrote", () => {
    const note = { kind: "order.note" as const, event: timelineEvent("e2", { actorId: ME }) };
    expect(applyLiveEvent(state(), note, ME).effects.flashOrderIds).toEqual([]);
  });
});

describe("applyLiveEvent: order.activity", () => {
  const activity = (id: string, orderId = "o1") => ({
    kind: "order.activity" as const,
    event: timelineEvent(id, {
      orderId,
      type: "shopify_write",
      actorId: null,
      source: "system",
      text: "Shopify was not updated: Shopify responded with HTTP 503. The status here is kept.",
      createdAt: 7000,
    }),
  });

  it("adds the entry to the open drawer's timeline once, without touching rows or flashing", () => {
    const opened = state({ timeline: { orderId: "o1", events: [timelineEvent("e1", { createdAt: 3000 })] } });
    const once = applyLiveEvent(opened, activity("a1"), ME);
    const twice = applyLiveEvent(once.state, activity("a1"), ME);
    expect(twice.state.timeline?.events.map((e) => e.id)).toEqual(["a1", "e1"]);
    expect(once.state.orders).toBe(opened.orders);
    expect(once.effects).toEqual({ refetch: false, reloadOpenOrder: false, announceOrderIds: [], flashOrderIds: [] });
  });

  it("is a no-op for another order or a closed drawer", () => {
    const opened = state({ timeline: { orderId: "o2", events: [] } });
    expect(applyLiveEvent(opened, activity("a1"), ME).state).toBe(opened);
    const closed = state();
    expect(applyLiveEvent(closed, activity("a1"), ME).state).toBe(closed);
  });
});

describe("touchesPurchaseOrders", () => {
  const entry = (type: string, orderId = "o1") => ({
    kind: "order.activity" as const,
    event: timelineEvent("p1", { orderId, type: type as EventView["type"], actorId: ME }),
  });

  it("is true for a purchase order entry on the open order only", () => {
    for (const type of ["po_draft", "po_sent", "po_failed"]) {
      expect(touchesPurchaseOrders(entry(type), "o1")).toBe(true);
    }
    expect(touchesPurchaseOrders(entry("po_sent", "o2"), "o1")).toBe(false);
    expect(touchesPurchaseOrders(entry("po_sent"), null)).toBe(false);
    expect(touchesPurchaseOrders(entry("shopify_write"), "o1")).toBe(false);
    expect(touchesPurchaseOrders({ kind: "orders.imported", count: 2 }, "o1")).toBe(false);
  });
});

describe("applyLiveEvent: a status change from Shopify", () => {
  it("moves the row with no actor and flashes it", () => {
    const fromShopify = statusEvent("o1", "new", "shipped", 4000);
    const event = {
      ...fromShopify,
      event: { ...fromShopify.event, actorId: null, source: "shopify" as const },
      order: { ...fromShopify.order, statusSetBy: null },
    };
    const { state: after, effects } = applyLiveEvent(state(), event, ME);
    expect(after.orders[0]).toMatchObject({ statusKey: "shipped", statusSetBy: null, statusSetAt: 4000 });
    expect(effects.flashOrderIds).toEqual(["o1"]);
  });
});

describe("optimisticStatus and rollbackStatus", () => {
  it("moves the row and counts at once and reports the previous key", () => {
    const result = optimisticStatus(state(), "o1", "processing");
    expect(result?.previousKey).toBe("new");
    expect(result?.state.orders[0].statusKey).toBe("processing");
    expect(result?.state.statusCounts).toEqual({ new: 0, processing: 2, shipped: 0 });
  });

  it("is null for a missing order or the same status", () => {
    expect(optimisticStatus(state(), "nope", "processing")).toBeNull();
    expect(optimisticStatus(state(), "o1", "new")).toBeNull();
  });

  it("rolls back while the row still shows the attempted status", () => {
    const moved = optimisticStatus(state(), "o1", "processing")!.state;
    const back = rollbackStatus(moved, "o1", "processing", "new");
    expect(back.orders[0].statusKey).toBe("new");
    expect(back.statusCounts).toEqual({ new: 1, processing: 1, shipped: 0 });
  });

  it("does not roll back over a newer change from someone else", () => {
    const moved = optimisticStatus(state(), "o1", "processing")!.state;
    const theirs = applyLiveEvent(moved, statusEvent("o1", "processing", "shipped", 9000), ME).state;
    const back = rollbackStatus(theirs, "o1", "processing", "new");
    expect(back).toBe(theirs);
  });
});

describe("selectOrders", () => {
  const orders = [
    order("a", { name: "#1001", createdAt: 3, total: "50.00", customerName: "Riley Oakes" }),
    order("b", {
      name: "#1002",
      createdAt: 1,
      total: "250.00",
      customerName: "Dana Whitfield",
      email: "dana@harbourfreight.example",
      statusKey: "shipped",
    }),
    order("c", {
      name: "#1003",
      createdAt: 2,
      total: "not a number",
      itemTitles: ["Hi-Vis Vest", "Steel Toe Boots"],
    }),
  ];

  it("sorts newest, oldest and by total", () => {
    expect(selectOrders(orders, { query: "", statusKey: null, sort: "newest" }).map((o) => o.id)).toEqual(["a", "c", "b"]);
    expect(selectOrders(orders, { query: "", statusKey: null, sort: "oldest" }).map((o) => o.id)).toEqual(["b", "c", "a"]);
    expect(selectOrders(orders, { query: "", statusKey: null, sort: "total" }).map((o) => o.id)).toEqual(["b", "a", "c"]);
  });

  it("searches order name, customer, email and every item title, ignoring case", () => {
    const find = (query: string) =>
      selectOrders(orders, { query, statusKey: null, sort: "newest" }).map((o) => o.id);
    expect(find("1002")).toEqual(["b"]);
    expect(find("  whitfield ")).toEqual(["b"]);
    expect(find("HARBOUR")).toEqual(["b"]);
    expect(find("steel toe")).toEqual(["c"]);
    expect(find("zzz")).toEqual([]);
  });

  it("filters by status key, including unknown keys", () => {
    expect(selectOrders(orders, { query: "", statusKey: "shipped", sort: "newest" }).map((o) => o.id)).toEqual(["b"]);
  });
});

// Draft orders spec sections 11.2 and 11.7, and section 18 item 7.
describe("requests in the list", () => {
  const list = [
    order("o1", { createdAt: 4 }),
    order("d1", { name: "#D12", kind: "draft", draftName: "#D12", createdAt: 3, searchText: ["#D12", "Impact Rentals", "Casey Lin", "Buford HQ"] }),
    order("d2", { name: "#D13", kind: "draft", draftName: "#D13", draftDeleted: true, createdAt: 2 }),
    order("o2", { name: "#1234", draftName: "#D11", draftStatus: "completed", createdAt: 1, searchText: ["#D11"] }),
  ];
  const ids = (kind: "all" | "drafts" | "orders" | "deleted", query = "") =>
    selectOrders(list, { query, statusKey: null, sort: "newest", kind }).map((row) => row.id);

  it("filters requests and orders, keeping deleted drafts out of everything but their own filter", () => {
    expect(ids("all")).toEqual(["o1", "d1", "o2"]);
    expect(ids("drafts")).toEqual(["d1"]);
    expect(ids("orders")).toEqual(["o1", "o2"]);
    expect(ids("deleted")).toEqual(["d2"]);
    // No kind given reads as all.
    expect(selectOrders(list, { query: "", statusKey: null, sort: "newest" }).map((row) => row.id)).toEqual(["o1", "d1", "o2"]);
  });

  it("searches the draft name, company and request fields too", () => {
    expect(ids("all", "casey")).toEqual(["d1"]);
    expect(ids("all", "buford hq")).toEqual(["d1"]);
    expect(ids("all", "#d11")).toEqual(["o2"]);
  });

  it("counts the loaded requests, orders and deleted drafts", () => {
    expect(deskKindCounts(list)).toEqual({ drafts: 1, orders: 2, deleted: 1 });
  });

  it("announces requests as requests and a mixed batch as both", () => {
    expect(arrivalNotice([order("d1", { name: "#D12", kind: "draft", customerName: "Jordan Vale" })])).toEqual({
      title: "New request #D12 from Jordan Vale",
    });
    expect(arrivalNotice([order("o1", { name: "#1001" })])).toEqual({ title: "New order #1001 from Riley Oakes", body: "CA$120.00" });
    expect(arrivalNotice([order("d1", { kind: "draft" }), order("d2", { kind: "draft" })]).title).toBe("2 new requests");
    expect(arrivalNotice([order("d1", { kind: "draft" }), order("o1")])).toEqual({
      title: "2 new orders and requests",
      body: "#d1, #o1",
    });
    expect(arrivalNotice([order("o1"), order("o2"), order("o3"), order("o4")])).toEqual({
      title: "4 new orders",
      body: "#o1, #o2, #o3 and 1 more",
    });
  });

  it("drops an order card folded into its request card, with its count, and says where it went", () => {
    const merged = state({
      orders: [order("o1"), order("d1", { statusKey: "processing", kind: "draft" })],
      statusCounts: { new: 1, processing: 1 },
      timeline: { orderId: "o1", events: [] },
    });
    const { state: next, effects } = applyLiveEvent(merged, { kind: "order.merged", fromId: "o1", toId: "d1" }, ME);
    expect(next.orders.map((row) => row.id)).toEqual(["d1"]);
    expect(next.statusCounts).toEqual({ new: 0, processing: 1 });
    expect(effects).toMatchObject({ refetch: true, merged: { fromId: "o1", toId: "d1" } });
    // An id this desk never loaded changes nothing but still refetches.
    const unknown = applyLiveEvent(state(), { kind: "order.merged", fromId: "zz", toId: "d1" }, ME);
    expect(unknown.state.orders).toHaveLength(2);
    expect(unknown.effects.refetch).toBe(true);
  });
});

describe("statusChips", () => {
  const statuses: StatusView[] = [
    { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null },
    { key: "shipped", label: "Shipped", color: "violet", sort: 1, triggersPo: false, shopifyLink: "fulfilled" },
  ];

  it("lists every status in order, then unknown keys that still have orders", () => {
    expect(statusChips(statuses, { new: 4, shipped: 0, zeta_gone: 2, alpha_gone: 1, empty_gone: 0 })).toEqual([
      { key: "new", label: "New", color: "lime", count: 4, known: true },
      { key: "shipped", label: "Shipped", color: "violet", count: 0, known: true },
      { key: "alpha_gone", label: "Unknown status", color: "slate", count: 1, known: false },
      { key: "zeta_gone", label: "Unknown status", color: "slate", count: 2, known: false },
    ]);
  });

  it("totals every count", () => {
    expect(totalOrders({ new: 4, shipped: 0, gone: 2 })).toBe(6);
  });
});
