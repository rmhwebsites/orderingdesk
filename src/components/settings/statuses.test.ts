import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusView } from "@/server/desk/shapes";
import { STATUS_LINK_OPTIONS, StatusesSection } from "./statuses";

const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
  { key: "delivered", label: "Delivered", color: "slate", sort: 1, triggersPo: false, shopifyLink: "delivered", closed: true },
];

describe("StatusesSection", () => {
  it("has a Closed switch per status, on for the closed ones", () => {
    const html = renderToStaticMarkup(createElement(StatusesSection, { workspaceId: "ws_impact", initial: STATUSES }));
    const switches = html.match(/<input[^>]*id="status-[a-z_]+-closed"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(2);
    expect(switches.filter((input) => input.includes('checked=""'))).toHaveLength(1);
    expect(html).toContain("Closed (leaves the Open view)");
  });

  // Wave 1a final review: new orders and requests land in the first status,
  // so its Closed switch cannot be turned on (only off, should a closed
  // status be moved to the top).
  it("disables the first status's Closed switch and says why", () => {
    const html = renderToStaticMarkup(createElement(StatusesSection, { workspaceId: "ws_impact", initial: STATUSES }));
    expect(html).toMatch(/<input[^>]*id="status-new-closed"[^>]*disabled=""/);
    expect(html).toMatch(/<input[^>]*id="status-new-closed"[^>]*aria-describedby="status-new-closed-hint"/);
    expect(html).toContain('id="status-new-closed-hint"');
    expect(html).toContain("New orders and requests land here, so it stays open.");
    expect(html).not.toMatch(/<input[^>]*id="status-delivered-closed"[^>]*disabled=""/);
  });
});

// The statuses editor offers every Shopify link the server accepts
// (SHOPIFY_LINK_VALUES), Cancelled included (comprehensive design section 2).
describe("STATUS_LINK_OPTIONS", () => {
  it("offers no link, the Shopify states and the request outcomes", () => {
    expect(STATUS_LINK_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ["", "No Shopify link"],
      ["fulfilled", "Fulfilled in Shopify"],
      ["delivered", "Delivered in Shopify"],
      ["draft_completed", "Draft approved (order created)"],
      ["draft_rejected", "Draft rejected"],
      ["cancelled", "Cancelled in Shopify"],
    ]);
  });
});
