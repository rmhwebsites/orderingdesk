import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import { OrderList, type ListProps } from "./order-list";

const NOW = Date.parse("2026-10-05T15:00:00.000Z");
const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
];

function card(id: string, overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id,
    name: "#" + id,
    statusKey: "new",
    statusSetBy: null,
    statusSetAt: null,
    createdAt: NOW - 3600000,
    syncedAt: NOW,
    customerName: "Jordan Vale",
    email: "jordan@example.com",
    total: "0.00",
    currency: "USD",
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
    hasPo: false,
    ...overrides,
  };
}

const base: ListProps = {
  orders: [
    card("1001"),
    card("d12", { name: "#D12", kind: "draft", draftName: "#D12", draftStatus: "open", requestFor: "Casey Lin", branch: "Buford HQ" }),
    card("d13", { name: "#D13", kind: "draft", draftName: "#D13", draftDeleted: true }),
  ],
  statuses: STATUSES,
  role: "manager",
  flashing: new Set(),
  rowErrors: {},
  savingIds: new Set(),
  now: NOW,
  onOpen: () => {},
  onChangeStatus: () => {},
  ageRule: { amberDays: 2, redDays: 4 },
  closedKeys: new Set(),
  selection: null,
};

const render = (layout: "table" | "cards", overrides: Partial<ListProps> = {}) =>
  renderToStaticMarkup(createElement(OrderList, { ...base, ...overrides, layout }));

describe("OrderList", () => {
  it("renders the table alone at desk width, one status control per card", () => {
    const html = render("table");
    expect(html).toContain("<table");
    expect(html).not.toContain("<ul");
    expect(html.match(/<select/g)).toHaveLength(3);
  });

  it("renders the cards alone below it, letting the browser skip off-screen cards", () => {
    const html = render("cards");
    expect(html).toContain("<ul");
    expect(html).not.toContain("<table");
    expect(html).toContain("[content-visibility:auto]");
    expect(html.match(/<select/g)).toHaveLength(3);
  });

  it("keeps every table row on one 44px line", () => {
    const html = render("table");
    expect(html.match(/<tr class="h-11 /g)).toHaveLength(3);
    expect(html).not.toContain("line-clamp-2");
    expect(html).toContain("For Casey Lin · Buford HQ");
  });

  it("marks requests, and a request whose draft Shopify deleted", () => {
    const html = render("table");
    expect(html).toContain(">Draft</span>");
    expect(html).toContain('Deleted<span class="sr-only"> in Shopify</span>');
  });
});

const DAY = 86400000;

describe("OrderList ages", () => {
  it("shows each card's age in its status, amber and red past the thresholds, plain once closed", () => {
    const statuses: StatusView[] = [
      ...STATUSES,
      { key: "delivered", label: "Delivered", color: "slate", sort: 1, triggersPo: false, shopifyLink: "delivered", closed: true },
    ];
    const orders = [
      card("fresh", { statusSetAt: NOW - 3 * 3600000 }),
      card("late", { statusSetAt: NOW - 2 * DAY }),
      card("old", { statusSetAt: NOW - 5 * DAY }),
      card("done", { statusKey: "delivered", statusSetAt: NOW - 9 * DAY }),
    ];
    const props = { orders, statuses, closedKeys: new Set(["delivered"]) };
    const table = render("table", props);
    expect(table).toContain(">Age</th>");
    expect(table).toContain('<span aria-hidden="true">3h</span>');
    expect(table).toMatch(/data-tone="amber"[^>]*><span aria-hidden="true">2d</);
    expect(table).toMatch(/data-tone="red"[^>]*><span aria-hidden="true">5d</);
    expect(table).toContain("In Delivered for 9 days");
    expect(table).not.toMatch(/data-tone="red"[^>]*><span aria-hidden="true">9d</);
    expect(render("cards", props)).toContain('<span aria-hidden="true">New, 3h</span>');
  });
});

// Owner decision after the plan: Approve and next skips the purchase order
// review, so the order says PO not created until it has one.
describe("OrderList purchase order hint", () => {
  it("marks an order whose status needs a purchase order and has none, on the row and the card", () => {
    const statuses: StatusView[] = [
      ...STATUSES,
      { key: "approved", label: "Approved", color: "green", sort: 1, triggersPo: true, shopifyLink: "draft_completed", closed: false },
    ];
    const orders = [card("o1", { statusKey: "approved" }), card("o2", { statusKey: "approved", hasPo: true }), card("o3")];
    for (const layout of ["table", "cards"] as const) {
      expect(render(layout, { orders, statuses }).match(/>PO not created</g)).toHaveLength(1);
    }
  });
});

describe("OrderList selection", () => {
  it("puts a selection box on every row and card, and select-all in the table head", () => {
    const selection = { selected: new Set(["1001"]), onToggle: () => {}, onToggleAll: () => {} };
    const table = render("table", { selection });
    expect(table).toContain('aria-label="Select every card shown"');
    expect(table.match(/aria-label="Select #/g)).toHaveLength(3);
    expect(table).toMatch(/<input type="checkbox" aria-label="Select #1001"[^>]*checked=""/);
    expect(render("cards", { selection }).match(/aria-label="Select #/g)).toHaveLength(3);
  });
});
