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
