import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CancelOrderPanel, type CancelPanelProps } from "./cancel-order";

// Cancel after approval in the drawer (comprehensive design section 2). The
// server enforces every rule; this checks the panel says the same thing.
const base: CancelPanelProps = {
  name: "#1234",
  canCancel: true,
  cancelled: false,
  pending: false,
  block: null,
  onCancel: async () => null,
};
const render = (overrides: Partial<CancelPanelProps> = {}) =>
  renderToStaticMarkup(createElement(CancelOrderPanel, { ...base, ...overrides }));

describe("CancelOrderPanel", () => {
  it("offers managers Cancel order and says what Shopify will and will not do", () => {
    const html = render();
    expect(html).toContain(">Cancel order<");
    expect(html).toContain("Shopify does not email the customer, restock items or refund anything. This cannot be undone.");
    expect(html).not.toContain('disabled=""');
  });

  it("shows staff nothing while the order is open", () => {
    expect(render({ canCancel: false })).toBe("");
  });

  it("says a cancelled order is cancelled, and when Shopify has not confirmed it yet", () => {
    expect(render({ cancelled: true })).toContain("This order is cancelled in Shopify.");
    expect(render({ cancelled: true })).not.toContain(">Cancel order<");
    expect(render({ cancelled: true, pending: true, canCancel: false })).toContain(
      "Shopify accepted the cancellation but has not confirmed it yet.",
    );
  });

  it("disables Cancel order with its reason", () => {
    const html = render({ block: "No status follows Shopify's cancelled state. A manager can set one in Settings > Statuses." });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Cancel order</);
    expect(html).toContain("No status follows Shopify&#x27;s cancelled state.");
  });
});
