import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { planBulkMove, type BulkCard } from "@/lib/status-rules";
import type { StatusView } from "@/server/desk/shapes";
import { BulkBar, BulkConfirm } from "./bulk-bar";

const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
  { key: "shipped", label: "Shipped", color: "violet", sort: 1, triggersPo: false, shopifyLink: "fulfilled", closed: false },
  { key: "rejected", label: "Rejected", color: "pink", sort: 2, triggersPo: false, shopifyLink: "draft_rejected", closed: true },
];
const CARDS: BulkCard[] = [
  { id: "o1", name: "#1001", customerName: "Jordan Vale", kind: "order", statusKey: "new" },
  { id: "d1", name: "#D12", customerName: "Casey Lin", kind: "draft", statusKey: "new" },
];

describe("BulkConfirm", () => {
  it("lists every selected card, says which stay and why, and counts only the ones that move", () => {
    const html = renderToStaticMarkup(
      createElement(BulkConfirm, {
        target: STATUSES[1],
        plan: planBulkMove(CARDS, STATUSES[1], STATUSES, "staff"),
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain("Move 1 of 2 selected cards to Shipped?");
    expect(html).toContain(">#1001<");
    expect(html).toContain(">#D12<");
    expect(html).toContain("Stays: A draft cannot be marked Shipped until it is approved and becomes an order.");
    expect(html).toContain(">Move 1 card</button>");
  });
});

describe("BulkBar", () => {
  it("offers every status except Rejected for the selected cards", () => {
    const html = renderToStaticMarkup(
      createElement(BulkBar, {
        cards: CARDS,
        statuses: STATUSES,
        role: "staff",
        busy: false,
        result: null,
        onMove: async () => {},
        onClear: () => {},
        onDismissResult: () => {},
      }),
    );
    expect(html).toContain("2 selected");
    expect(html).toContain(">Shipped</option>");
    expect(html).not.toContain(">Rejected</option>");
    expect(html).toContain(">Clear</button>");
  });

  it("never offers the cancelled status, which belongs to Cancel order and Shopify", () => {
    const withCancelled: StatusView[] = [
      ...STATUSES,
      { key: "cancelled", label: "Cancelled", color: "slate", sort: 3, triggersPo: false, shopifyLink: "cancelled", closed: true },
    ];
    for (const role of ["staff", "manager"] as const) {
      const html = renderToStaticMarkup(
        createElement(BulkBar, {
          cards: CARDS,
          statuses: withCancelled,
          role,
          busy: false,
          result: null,
          onMove: async () => {},
          onClear: () => {},
          onDismissResult: () => {},
        }),
      );
      expect(html).toContain(">Shipped</option>");
      expect(html).not.toContain(">Cancelled</option>");
      expect(html).not.toContain('value="cancelled"');
    }
  });

  it("shows the outcome with every card that stayed", () => {
    const html = renderToStaticMarkup(
      createElement(BulkBar, {
        cards: [],
        statuses: STATUSES,
        role: "staff",
        busy: false,
        result: { tone: "warn", text: "Moved 1 card to Shipped.", refusals: [{ name: "#D12", error: "A draft cannot be marked Shipped." }] },
        onMove: async () => {},
        onClear: () => {},
        onDismissResult: () => {},
      }),
    );
    expect(html).toContain("Moved 1 card to Shipped.");
    expect(html).toContain("#D12: A draft cannot be marked Shipped.");
  });

  it("groups the cards that stayed by reason, so a long outcome stays short and Dismiss stays in view", () => {
    const draftRule = "A draft cannot be marked Shipped until it is approved and becomes an order.";
    const refusals = [
      ...Array.from({ length: 20 }, (_, i) => ({ name: `#D${i + 1}`, error: draftRule })),
      { name: "#D40", error: "Only a manager can reopen a rejected request." },
      { name: null, error: "It is no longer in this workspace." },
      { name: null, error: "It is no longer in this workspace." },
    ];
    const html = renderToStaticMarkup(
      createElement(BulkBar, {
        cards: CARDS,
        statuses: STATUSES,
        role: "staff",
        busy: false,
        result: { tone: "warn", text: "Moved 5 cards to Shipped.", refusals },
        onMove: async () => {},
        onClear: () => {},
        onDismissResult: () => {},
      }),
    );
    // Each reason once, with how many cards it kept and every card named.
    expect(html.split(draftRule)).toHaveLength(2);
    expect(html).toContain(`20 cards did not move: ${draftRule}`);
    expect(html).toContain(`${Array.from({ length: 20 }, (_, i) => `#D${i + 1}`).join(", ")}<`);
    expect(html).toContain("#D40: Only a manager can reopen a rejected request.");
    expect(html).toContain("2 cards did not move: It is no longer in this workspace.");
    expect(html).not.toContain("A card, A card");
    // The bar never outgrows the screen: the outcome (with Dismiss) sits
    // above a controls area that scrolls, and its own list scrolls too.
    expect(html).toMatch(/^<div class="fixed [^"]*max-h-\[60dvh\]/);
    expect(html).toMatch(/<ul aria-label="Cards that did not move" tabindex="0" class="[^"]*max-h-28 [^"]*overflow-y-auto/);
    expect(html).toMatch(/<div class="min-h-0 overflow-y-auto overscroll-contain">[^]*2 selected/);
    expect(html.indexOf(">Dismiss<")).toBeLessThan(html.indexOf("2 selected"));
  });
});
