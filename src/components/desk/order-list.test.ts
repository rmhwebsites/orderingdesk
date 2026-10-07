import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import { BranchCell, OrderList, branchText, requestLine, type ListProps } from "./order-list";

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
    locationId: null,
    locationName: "",
    cancelled: false,
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
  showPrices: true,
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
    expect(html).toContain(" · For Casey Lin</span>");
  });

  it("marks requests, and a request whose draft Shopify deleted", () => {
    const html = render("table");
    expect(html).toContain(">Draft</span>");
    expect(html).toContain('Deleted<span class="sr-only"> in Shopify</span>');
  });

  // Final verification (Wave 1b): "Cancelled in Shopify" in full is wider
  // than the 10rem Order column and ran over the Date column, more so beside
  // a price. The mark reads Cancelled, like Deleted, and says the rest to
  // screen readers and on hover; the Order cell never paints past its edge.
  it("marks an order Shopify cancelled outside the cancelled status in a chip that fits the Order column", () => {
    const statuses: StatusView[] = [
      ...STATUSES,
      { key: "cancelled", label: "Cancelled", color: "slate", sort: 1, triggersPo: false, shopifyLink: "cancelled", closed: true },
    ];
    const orders = [
      card("1006", { cancelled: true, total: "2348.50", currency: "CAD" }),
      card("1007", { cancelled: true, statusKey: "cancelled" }),
    ];
    for (const layout of ["table", "cards"] as const) {
      const html = render(layout, { orders, statuses });
      expect(html.match(/Cancelled<span class="sr-only"> in Shopify<\/span>/g), layout).toHaveLength(1);
      expect(html, layout).toContain('title="Cancelled in Shopify"');
      expect(html, layout).not.toContain(">Cancelled in Shopify<");
    }
    const table = render("table", { orders, statuses });
    const orderCells = [...table.matchAll(/<td class="([^"]*)"><span class="flex min-w-0 items-center gap-2"><button/g)];
    expect(orderCells).toHaveLength(2);
    for (const cell of orderCells) {
      expect(cell[1].split(" ")).toContain("overflow-hidden");
    }
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

describe("OrderList prices", () => {
  it("never shows a Total column on the desktop, marks a card that has a price, and keeps the cards' totals under the price rule", () => {
    const orders = [card("free"), card("priced", { total: "48.00" })];
    const shown = render("table", { orders, showPrices: true });
    expect(shown).not.toContain(">Total</th>");
    expect(shown).toContain(">Branch</th>");
    expect(shown).not.toContain("$0.00");
    expect(shown).toContain("$48.00");
    expect(render("cards", { orders, showPrices: true })).toContain("$0.00");
    const hidden = render("table", { orders, showPrices: false });
    expect(hidden).not.toContain(">Total</th>");
    expect(hidden).not.toContain("$0.00");
    expect(hidden).toContain("$48.00");
    expect(hidden).toContain('title="This card has a price"');
    expect(render("cards", { orders, showPrices: false })).not.toContain("$0.00");
  });
});

// The desktop list's Branch column (comprehensive design section 2): the
// card's synced location, else its request field, in place of the total.
describe("Branch column", () => {
  it("names the card's branch, trimmed, or says there is none", () => {
    expect(branchText({ branch: " Mableton " })).toBe("Mableton");
    expect(renderToStaticMarkup(createElement(BranchCell, { order: { branch: "Mableton" } }))).toContain(">Mableton<");
    expect(renderToStaticMarkup(createElement(BranchCell, { order: { branch: "" } }))).toContain(">No branch<");
  });

  it("leaves the branch out of the request line when the row has a Branch column", () => {
    expect(requestLine({ requestFor: "Casey Lin", branch: "Mableton" }, { withBranch: false })).toBe("For Casey Lin");
    expect(requestLine({ requestFor: "Casey Lin", branch: "Mableton" }, { withBranch: true })).toBe("For Casey Lin · Mableton");
    expect(requestLine({ requestFor: "", branch: "" }, { withBranch: true })).toBeNull();
  });

  it("shows Branch, never Total, on the desktop, and keeps the phone cards as they were", () => {
    const table = render("table");
    expect(table).toContain(">Branch</th>");
    expect(table).not.toContain(">Total</th>");
    expect(table).toContain(" · For Casey Lin</span>");
    expect(table).toContain('title="Buford HQ">Buford HQ</span>');
    expect(render("cards")).toContain("For Casey Lin · Buford HQ");
  });
});

// The table's column budget (Wave 1b review). A fixed table gives the rem
// tracks their width first, then Customer its share, and Items (the one
// column without a width) what is left. The desk is 880 px and up, inside
// 24 px of padding a side, at most 1400 px wide, with a 1 px border. The
// Branch column shows only from xl (1280 px), where it fits; below that the
// branch stays in the customer line, as on the cards.
describe("OrderTable column widths", () => {
  const XL = 1280;
  type Column = { label: string; className: string };

  // Each column's width classes come from its <col> when the table has a
  // colgroup, else from its header cell; it shows when neither hides it.
  function columns(html: string): Column[] {
    const head = html.match(/<thead>([^]*?)<\/thead>/)?.[1] ?? "";
    const headers = [...head.matchAll(/<th[^>]*?class="([^"]*)"[^>]*>([^]*?)<\/th>/g)];
    const cols = [...html.matchAll(/<col(?: class="([^"]*)")?\/?>/g)].map((col) => col[1] ?? "");
    return headers.map((header, i) => ({
      label: header[2].replace(/<[^>]*>/g, ""),
      className: `${cols[i] ?? ""} ${header[1]}`,
    }));
  }

  function shows(column: Column, viewport: number): boolean {
    const hidden = /(^|\s)hidden(\s|$)/.test(column.className);
    return !hidden || (viewport >= XL && /(^|\s)xl:table-(cell|column)(\s|$)/.test(column.className));
  }

  // Width in px, or a share of the table; null for the auto column.
  function width(column: Column): { px: number } | { share: number } | null {
    const rem = column.className.match(/(?:^|\s)w-\[([\d.]+)rem\]/);
    if (rem) {
      return { px: Number(rem[1]) * 16 };
    }
    const spacing = column.className.match(/(?:^|\s)w-(\d+)(?:\s|$)/);
    if (spacing) {
      return { px: Number(spacing[1]) * 4 };
    }
    const percent = column.className.match(/(?:^|\s)w-\[([\d.]+)%\]/);
    return percent ? { share: Number(percent[1]) / 100 } : null;
  }

  function layout(html: string, viewport: number): Map<string, number> {
    const table = Math.min(viewport, 1400) - 48 - 2;
    const shown = columns(html).filter((column) => shows(column, viewport));
    let fixed = 0;
    let shares = 0;
    for (const column of shown) {
      const w = width(column);
      if (w && "px" in w) {
        fixed += w.px;
      } else if (w) {
        shares += w.share * table;
      }
    }
    const shareRoom = Math.max(0, Math.min(shares, table - fixed));
    const autoRoom = Math.max(0, table - fixed - shareRoom);
    return new Map(
      shown.map((column) => {
        const w = width(column);
        const px = w === null ? autoRoom : "px" in w ? w.px : shares > 0 ? (shareRoom * w.share * table) / shares : 0;
        return [column.label, Math.round(px)];
      }),
    );
  }

  it("keeps the item preview readable at every desk width, with Branch only where it fits", () => {
    const html = render("table");
    // The narrowest desk (880 px) keeps what it had before the Branch
    // column; half a 1920 screen (960 px) and an iPad on its side (1024 px)
    // keep a real preview; from 1280 px Branch has its own column, and from
    // 1400 px the desk stops growing.
    const floors: [number, number][] = [
      [880, 40],
      [960, 100],
      [1024, 150],
      [1120, 200],
      [1280, 200],
      [1440, 280],
    ];
    for (const [viewport, floor] of floors) {
      const widths = layout(html, viewport);
      expect(widths.has("Items"), `Items at ${viewport} px`).toBe(true);
      expect(widths.get("Items")!, `Items at ${viewport} px`).toBeGreaterThanOrEqual(floor);
      expect(widths.get("Customer")!, `Customer at ${viewport} px`).toBeGreaterThanOrEqual(190);
      expect(widths.has("Branch"), `Branch at ${viewport} px`).toBe(viewport >= XL);
    }
  });

  it("names the branch in the customer line wherever the Branch column is hidden", () => {
    const html = render("table");
    expect(html).toMatch(/<span class="[^"]*xl:hidden[^"]*">[^<]*Buford HQ<\/span>/);
    expect(html).toContain('title="Buford HQ">Buford HQ</span>');
  });
});
