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
});
