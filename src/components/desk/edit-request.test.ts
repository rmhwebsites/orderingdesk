import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestEditor } from "@/lib/request-edit";
import { EditRequestForm, EditReview } from "./edit-request";

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
