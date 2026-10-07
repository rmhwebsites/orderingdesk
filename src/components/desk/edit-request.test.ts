import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestEditor } from "@/lib/request-edit";
import { EditRequest, EditRequestForm, EditReview, editFocus, type EditStep } from "./edit-request";

// The request editor (comprehensive design section 2) as the drawer renders
// it. The server enforces every rule again.

const EDITOR: RequestEditor = {
  updatedAt: "2026-10-06T14:00:00Z",
  lines: [
    { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 2 },
    { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
  ],
  locationId: "101",
  locationName: "Buford HQ",
  locations: [
    { shopifyLocationId: "101", name: "Buford HQ", address: "100 Example Way, Buford GA 30518, US" },
    { shopifyLocationId: "102", name: "Mableton", address: "5 Example Rd, Mableton GA 30126, US" },
  ],
};

const renderForm = (editor: RequestEditor = EDITOR, notice: string | null = null) =>
  renderToStaticMarkup(
    createElement(EditRequestForm, { name: "#D12", editor, notice, onReview: () => undefined, onClose: () => undefined }),
  );

describe("EditRequestForm", () => {
  it("lists each item with its quantity and a way to remove it, and the company's locations", () => {
    const html = renderForm();
    expect(html).toContain("Edit request #D12");
    expect(html).toContain("Hard Hat (White)");
    expect(html).toContain('value="2"');
    expect(html).toContain("Personalization kept exactly (2 fields)");
    expect(html.match(/>Remove</g)).toHaveLength(2);
    // React writes checked before value, so each radio is read whole.
    expect(html.match(/<input[^>]*value="101"[^>]*>/)?.[0]).toContain('checked=""');
    expect(html.match(/<input[^>]*value="102"[^>]*>/)?.[0]).not.toContain('checked=""');
    expect(html).toContain("5 Example Rd, Mableton GA 30126, US");
    // Nothing changed yet: nothing to review.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Review changes</);
  });

  it("keeps the last item, says why, names the one location, and shows a refresh notice", () => {
    const one = renderForm(
      { ...EDITOR, lines: [EDITOR.lines[0]], locations: [] },
      "This request changed in Shopify since you opened the editor.",
    );
    expect(one).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Remove<\/button>/);
    expect(one).toContain("A request keeps at least one item.");
    expect(one).toContain("This request changed in Shopify since you opened the editor.");
    expect(one).toContain("Ships to");
  });

  // Opening the editor and a reload after a stale save both remove the
  // control that held focus. The heading takes it (so Escape and Tab stay in
  // the drawer), and a reload notice is read out with it.
  it("can take focus on its heading, which is described by the reload notice", () => {
    const plain = renderForm();
    const heading = plain.match(/<h4[^>]*>Edit request #D12<\/h4>/)?.[0] ?? "";
    expect(heading).toContain('tabindex="-1"');
    expect(heading).not.toContain("aria-describedby");
    const notice = "This request changed in Shopify since you opened the editor.";
    const html = renderForm(EDITOR, notice);
    const describedBy = html.match(/<h4[^>]*aria-describedby="([^"]+)"[^>]*>Edit request #D12</)?.[1] ?? "";
    expect(describedBy).toBeTruthy();
    const region = html.match(/<div id="([^"]+)"[^>]*>(?:(?!<\/div>).)*<div[^>]*>([^<]*)</);
    expect(region?.[1]).toBe(describedBy);
    expect(region?.[2]).toBe(notice);
  });
});

describe("EditRequest", () => {
  // The editor opens on a skeleton while the draft is read from Shopify. An
  // aria-label on a plain div is not announced, so the words are real
  // (visually hidden) text in a status region that can hold focus.
  it("says it is loading in a status region that can take focus", () => {
    const html = renderToStaticMarkup(
      createElement(EditRequest, {
        orderId: "order-1",
        name: "#D12",
        onSave: async () => ({ warning: null }),
        onClose: () => undefined,
      }),
    );
    const tag = html.match(/^<div[^>]*>/)?.[0] ?? "";
    expect(tag).toContain('role="status"');
    expect(tag).toContain('tabindex="-1"');
    expect(tag).not.toContain("aria-label");
    expect(html).toContain('<span class="sr-only">Loading the request from Shopify</span>');
  });
});

// Where focus goes as the editor moves between its views. Every view change
// removes the control that held focus, so something in the editor must take
// it, or focus drops to the page and the drawer stops answering Escape.
describe("editFocus", () => {
  const first = { lines: 1 };
  const fresh = { lines: 2 };
  const at = (view: EditStep["view"], editor: object | null = null): EditStep => ({ view, editor });

  it("puts focus on the loading region when the editor opens or tries again", () => {
    expect(editFocus(null, at("loading"))).toBe("loading");
    expect(editFocus(at("error"), at("loading"))).toBe("loading");
  });

  it("puts focus on the message when the request does not load", () => {
    expect(editFocus(at("loading"), at("error"))).toBe("error");
  });

  it("puts focus on the heading when the editor is ready", () => {
    expect(editFocus(at("loading"), at("form", first))).toBe("heading");
  });

  // Back to editing: the form kept what was typed, so focus returns to the
  // button that opened the review.
  it("gives focus back to Review changes after Back to editing", () => {
    expect(editFocus(at("review", first), at("form", first))).toBe("review-button");
  });

  // A stale save (409): the editor reloads with the latest version. The
  // heading takes focus and reads out why.
  it("puts focus on the heading when a stale save reloads the editor", () => {
    expect(editFocus(at("review", first), at("form", fresh))).toBe("heading");
  });

  it("leaves focus to the review, which puts it on its question", () => {
    expect(editFocus(at("form", first), at("review", first))).toBeNull();
  });

  it("leaves focus alone when the view did not change", () => {
    expect(editFocus(at("loading"), at("loading"))).toBeNull();
    expect(editFocus(at("form", first), at("form", first))).toBeNull();
    expect(editFocus(at("review", first), at("review", first))).toBeNull();
  });
});

describe("EditReview", () => {
  it("asks once more, with every change and the before and after", () => {
    const html = renderToStaticMarkup(
      createElement(EditReview, {
        name: "#D12",
        summary: {
          changes: ["Removed Safety Vest (L)"],
          before: { lines: ["2 x Hard Hat (White)", "1 x Safety Vest (L)"], shipTo: "Buford HQ" },
          after: { lines: ["2 x Hard Hat (White)"], shipTo: "Buford HQ" },
        },
        error: null,
        busy: false,
        onSave: () => undefined,
        onBack: () => undefined,
      }),
    );
    expect(html).toContain("Save these changes to request #D12 in Shopify?");
    expect(html).toContain("<li>Removed Safety Vest (L)</li>");
    expect(html).toContain(">Before<");
    expect(html).toContain(">After<");
    expect(html).toContain(">Save changes<");
  });
});
