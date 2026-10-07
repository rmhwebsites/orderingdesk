import { describe, it, expect } from "vitest";
import type { ActivityItem } from "@/server/activity";
import { actorLabel, activityToasts, orderHref, unreadBadge } from "./activity-feed";

const item = (overrides: Partial<ActivityItem>): ActivityItem => ({
  id: "e1",
  type: "note",
  text: "Called the customer",
  orderId: "o1",
  orderName: "#1001",
  actorId: "u_other",
  actorName: "Jamie Rivers",
  source: "app",
  meta: null,
  createdAt: 1,
  unread: true,
  mine: false,
  ...overrides,
});

describe("unreadBadge", () => {
  it("shows nothing at zero or without a count, and caps at 99+", () => {
    expect(unreadBadge(null)).toBeNull();
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(7)).toBe("7");
    expect(unreadBadge(99)).toBe("99");
    expect(unreadBadge(100)).toBe("99+");
  });
});

describe("actorLabel", () => {
  it("says who did it in plain words", () => {
    expect(actorLabel(item({ mine: true }))).toBe("You");
    expect(actorLabel(item({}))).toBe("Jamie Rivers");
    expect(actorLabel(item({ actorName: null }))).toBe("Former member");
    expect(actorLabel(item({ actorId: null, actorName: null, source: "shopify", type: "status" }))).toBe("Shopify");
    expect(actorLabel(item({ actorId: null, actorName: null, source: "shopify", type: "order_new" }))).toBe("Shopify");
    expect(actorLabel(item({ actorId: null, actorName: null, source: "system", type: "sync_error" }))).toBe("Ordering Desk");
  });

  it("adds the AI app to the person's name", () => {
    expect(actorLabel(item({ actorId: "u_casey", actorName: "Casey Lin", source: "ai", meta: { ai: { client: "claude" } } }))).toBe(
      "Casey Lin via Claude",
    );
    expect(actorLabel(item({ mine: true, source: "ai", meta: { ai: { client: "chatgpt" } } }))).toBe("You via ChatGPT");
  });
});

describe("orderHref", () => {
  it("opens the order in the desk on either host", () => {
    expect(orderHref("", "o 1")).toBe("/?order=o%201");
    expect(orderHref("/w/impact", "o1")).toBe("/w/impact?order=o1");
  });
});

describe("activityToasts", () => {
  it("announces nothing on the first load", () => {
    expect(activityToasts(null, [item({})])).toEqual([]);
  });

  it("announces new status changes and notes by others, newest first, at most three", () => {
    const known = new Set(["old"]);
    const items = [
      item({ id: "n5", type: "note", text: "Gate code changed", createdAt: 50 }),
      item({ id: "n4", type: "status", text: "Status set to Shipped", createdAt: 40, actorId: null, actorName: null, source: "shopify" }),
      item({ id: "n3", type: "status", text: "Status set to Packed", createdAt: 30, mine: true }),
      item({ id: "n2", type: "order_new", text: "New order #1002", createdAt: 20 }),
      item({ id: "n1", type: "note", text: "x".repeat(200), createdAt: 10 }),
      item({ id: "n0", type: "status", text: "Status set to New", createdAt: 5 }),
      item({ id: "old", type: "note", createdAt: 1 }),
    ];
    const toasts = activityToasts(known, items);
    expect(toasts).toHaveLength(3);
    expect(toasts[0]).toEqual({ title: "Note on #1001", body: "Jamie Rivers: Gate code changed", tone: "info" });
    expect(toasts[1]).toEqual({ title: "#1001: Status set to Shipped", body: "From Shopify", tone: "info" });
    // Mine and new orders (the desk announces those) are skipped; long
    // notes are clipped.
    expect(toasts[2].title).toBe("Note on #1001");
    expect(toasts[2].body?.length).toBeLessThan(140);
  });
});
