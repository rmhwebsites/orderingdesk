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
  canEdit: true,
  editBlock: null,
  contentKey: "k1",
  editor: () => null,
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

  it("quotes a rejection's reason, who rejected it and when", () => {
    const html = render({
      rejected: true,
      rejection: { reason: "Duplicate of #D11", by: "Ryan Hale", at: Date.parse("2026-10-05T12:00:00.000Z") },
    });
    expect(html).toContain(">Duplicate of #D11</blockquote>");
    expect(html).toContain("Rejected by Ryan Hale, Oct 5, 2026");
  });

  it("titles a request whose draft Shopify deleted as Deleted in Shopify", () => {
    const html = render({ deleted: true, approveBlock: "Shopify no longer has this draft." });
    expect(html).toContain(">Deleted in Shopify</h3>");
    expect(html).not.toContain("Waiting for review");
    expect(html).toContain("Reject still records a decision.");
  });

  // Comprehensive design section 2: managers edit a request before approval.
  it("offers managers Edit request, with its reason when it cannot be used", () => {
    expect(render()).toContain(">Edit request<");
    const blocked = render({ editBlock: "Shopify no longer has this draft.", approveBlock: "Shopify no longer has this draft." });
    const editButton = blocked.match(/<button[^>]*>(?:(?!<\/button>).)*Edit request<\/button>/)?.[0] ?? "";
    expect(editButton).toContain('disabled=""');
    expect(blocked.match(/Shopify no longer has this draft\./g)).toHaveLength(1);
    expect(render({ canEdit: false })).not.toContain("Edit request");
    expect(render({ canReview: false })).not.toContain("Edit request");
  });
});
