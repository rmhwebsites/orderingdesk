import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewPanel, type ReviewPanelProps } from "./review-panel";

// What a request card offers (draft orders spec section 11.3 with section
// 18 item 8). The server enforces every rule; this checks the panel says
// the same thing.
const base: ReviewPanelProps = {
  name: "#D12",
  email: "jordan@example.com",
  canReview: true,
  rejected: false,
  approveBlock: null,
  rejectBlock: null,
  completeInShopify: null,
  onApprove: async () => null,
  onReject: async () => null,
};
const render = (overrides: Partial<ReviewPanelProps> = {}) =>
  renderToStaticMarkup(createElement(ReviewPanel, { ...base, ...overrides }));

describe("ReviewPanel", () => {
  it("gives managers Approve and Reject", () => {
    const html = render();
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
    expect(html).not.toContain('disabled=""');
  });

  it("tells staff a manager decides, with no buttons", () => {
    const html = render({ canReview: false });
    expect(html).toContain("Waiting for a manager to approve or reject.");
    expect(html).not.toContain("<button");
  });

  it("sends a draft with a price to Shopify instead of offering Approve", () => {
    const html = render({ completeInShopify: { url: "https://admin.shopify.com/store/impact/draft_orders/12" } });
    expect(html).toContain("Complete this draft in Shopify. The card follows when you do.");
    expect(html).toContain('href="https://admin.shopify.com/store/impact/draft_orders/12"');
    expect(html).not.toContain(">Approve<");
    expect(html).toContain(">Reject<");
  });

  it("disables Approve with its reason, once, when the draft is gone or nothing follows Draft approved", () => {
    const html = render({ approveBlock: "Shopify no longer has this draft." });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Approve</);
    expect(html.match(/Shopify no longer has this draft\./g)).toHaveLength(1);
    const both = render({ approveBlock: "Draft orders are not enabled.", rejectBlock: "Draft orders are not enabled." });
    expect(both.match(/Draft orders are not enabled\./g)).toHaveLength(1);
  });

  it("offers only Approve on a rejected request", () => {
    const html = render({ rejected: true });
    expect(html).toContain("This request was rejected");
    expect(html).toContain(">Approve<");
    expect(html).not.toContain(">Reject<");
  });

  it("offers Approve and next while another request waits, through the same confirmation", () => {
    const html = render({ next: { id: "d13", name: "#D13" }, onApproveAndNext: async () => null });
    expect(html).toContain(">Approve and next<");
    expect(html).toContain("Then request #D13 opens.");
    expect(render({ next: null })).not.toContain("Approve and next");
    expect(
      render({ next: { id: "d13", name: "#D13" }, onApproveAndNext: async () => null, completeInShopify: { url: null } }),
    ).not.toContain("Approve and next");
  });
});
