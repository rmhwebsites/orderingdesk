import { describe, it, expect } from "vitest";
import { parseLiveEvent } from "./live-events";

const event = {
  id: "e1",
  orderId: "o1",
  type: "status",
  text: "Status set to Processing",
  actorId: "u1",
  meta: { from: "new", to: "processing" },
  createdAt: 1700000000000,
};

describe("parseLiveEvent", () => {
  it("accepts the three event kinds the server broadcasts", () => {
    const synced = { kind: "orders.synced", addedOrderIds: ["a"], updatedOrderIds: [] };
    const status = {
      kind: "order.status",
      event,
      order: { id: "o1", statusKey: "processing", statusSetBy: "u1", statusSetAt: 1700000000000 },
    };
    const note = { kind: "order.note", event: { ...event, type: "note", meta: null } };
    expect(parseLiveEvent(JSON.stringify(synced))).toEqual(synced);
    expect(parseLiveEvent(JSON.stringify(status))).toEqual(status);
    expect(parseLiveEvent(JSON.stringify(note))).toEqual(note);
  });

  // Shopify-originated moves have no actor, and Shopify write outcomes reach
  // an open drawer as order.activity (platform amendment section 4).
  it("accepts a status change with no actor and an activity entry", () => {
    const fromShopify = {
      kind: "order.status",
      event: { ...event, actorId: null, source: "shopify" },
      order: { id: "o1", statusKey: "shipped", statusSetBy: null, statusSetAt: 1700000000000 },
    };
    const activity = {
      kind: "order.activity",
      event: { ...event, type: "shopify_write", actorId: null, text: "Shopify updated: tagged Ordering Desk: Shipped" },
    };
    expect(parseLiveEvent(JSON.stringify(fromShopify))).toEqual(fromShopify);
    expect(parseLiveEvent(JSON.stringify(activity))).toEqual(activity);
    expect(parseLiveEvent(JSON.stringify({ kind: "order.activity", event: { ...event, type: "bogus" } }))).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ kind: "order.activity" }))).toBeNull();
  });

  // Purchase order entries (drafted, sent, failed) reach open drawers the
  // same way.
  it("accepts purchase order activity entries", () => {
    for (const type of ["po_draft", "po_sent", "po_failed"]) {
      const activity = { kind: "order.activity", event: { ...event, type, text: "Purchase order IMP-2026-0001", meta: { poId: "po1" } } };
      expect(parseLiveEvent(JSON.stringify(activity))).toEqual(activity);
    }
  });

  // The order history import's refresh: a count, never ids to announce.
  it("accepts an import refresh with a positive whole count only", () => {
    expect(parseLiveEvent(JSON.stringify({ kind: "orders.imported", count: 12 }))).toEqual({ kind: "orders.imported", count: 12 });
    for (const count of [0, -1, 1.5, "12", null]) {
      expect(parseLiveEvent(JSON.stringify({ kind: "orders.imported", count }))).toBeNull();
    }
  });

  it("returns null for pongs, garbage and unknown kinds", () => {
    for (const raw of ["pong", "", "{", "null", "[]", '{"kind":"order.deleted"}', "42"]) {
      expect(parseLiveEvent(raw)).toBeNull();
    }
  });

  it("returns null when required fields are missing or mistyped", () => {
    expect(parseLiveEvent(JSON.stringify({ kind: "orders.synced", addedOrderIds: "a" }))).toBeNull();
    expect(
      parseLiveEvent(JSON.stringify({ kind: "orders.synced", addedOrderIds: [1], updatedOrderIds: [] })),
    ).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ kind: "order.note", event: { ...event, id: 5 } }))).toBeNull();
    expect(
      parseLiveEvent(JSON.stringify({ kind: "order.status", event, order: { id: "o1", statusKey: 3 } })),
    ).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ kind: "order.note", event: { ...event, orderId: null } }))).toBeNull();
  });
});
