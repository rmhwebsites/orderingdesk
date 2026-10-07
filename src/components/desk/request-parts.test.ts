import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readSnapshot } from "@/lib/order-snapshot";
import { snapshotOf } from "@/server/desk/test-helpers";
import { ItemsSection, PropertyList, RequestSection, ShipToSection } from "./request-parts";

// Personalization and request fields as the drawer renders them (draft
// orders spec sections 11.3 and 11.4 with section 18).
describe("PropertyList", () => {
  it("shows the preview image and the PDF, hides app keys, and keeps everything else as text", () => {
    const html = renderToStaticMarkup(
      createElement(PropertyList, {
        itemTitle: "Business cards",
        props: [
          { key: "Full Name", value: "Casey Lin" },
          { key: "Office Address", value: "1 Depot Way\r\nBuford, GA" },
          { key: "Preview", value: "https://cdn.shopify.com/s/files/1/preview.png" },
          { key: "_pdf", value: "https://cdn.shopify.com/s/files/1/proof.pdf" },
          { key: "_pplr_preview", value: "Preview" },
          { key: "Website", value: "javascript:alert(1)" },
        ],
      }),
    );
    expect(html).toContain('src="https://cdn.shopify.com/s/files/1/preview.png"');
    expect(html).toContain('alt="Preview for Business cards"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('href="https://cdn.shopify.com/s/files/1/proof.pdf"');
    expect(html).toContain("Print PDF");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("Pplr preview");
    expect(html).toContain("Show all properties (1 more)");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("javascript:alert(1)");
    expect(html).toContain("whitespace-pre-line");
  });
});

describe("RequestSection", () => {
  it("lists the requester, company, location, request fields, PO number and note, leaving out empty ones", () => {
    const html = renderToStaticMarkup(
      createElement(RequestSection, {
        customerName: "Jordan Vale",
        email: "jordan@example.com",
        fields: {
          company: "Impact Rentals",
          location: "Buford, GA",
          requestFor: "Casey Lin",
          branch: "Buford HQ",
          attributes: [{ key: "<b>Ship to Branch</b>", value: "Buford HQ" }],
        },
        note: "",
        poNumber: "PO-77",
      }),
    );
    expect(html).toContain("Jordan Vale");
    expect(html).toContain("Impact Rentals");
    expect(html).toContain("&lt;b&gt;Ship to Branch&lt;/b&gt;");
    expect(html).toContain("PO-77");
    expect(html).not.toContain(">Note<");
  });
});

describe("ItemsSection prices", () => {
  it("leaves the prices out of a $0 card when the workspace hides them, and keeps them for a priced one", () => {
    const free = readSnapshot(snapshotOf({ total: "0.00", items: [{ title: "Hard Hat", qty: 2, price: "0.00", sku: "HH-1" }] }));
    expect(renderToStaticMarkup(createElement(ItemsSection, { snapshot: free, itemsTruncated: false, shopifyUrl: null, showPrices: false }))).not.toContain(
      "Order total",
    );
    const priced = readSnapshot(snapshotOf({ total: "48.00" }));
    expect(renderToStaticMarkup(createElement(ItemsSection, { snapshot: priced, itemsTruncated: false, shopifyUrl: null, showPrices: false }))).toContain(
      "Order total",
    );
  });

  it("never breaks a SKU in the middle", () => {
    const snapshot = readSnapshot(snapshotOf({ items: [{ title: "Insulated Work Jacket", qty: 1, price: "0.00", sku: "EX-JKT-CH-XL", variant: "XL" }] }));
    const html = renderToStaticMarkup(createElement(ItemsSection, { snapshot, itemsTruncated: false, shopifyUrl: null }));
    expect(html).toContain('class="whitespace-nowrap font-mono">SKU EX-JKT-CH-XL<');
  });
});

describe("ShipToSection", () => {
  const shipping = {
    name: "Casey Lin",
    company: "Example Rentals",
    phone: "",
    a1: "100 Example Way",
    a2: "",
    city: "Buford",
    prov: "GA",
    zip: "30518",
    country: "US",
  };

  it("names the company location first, in bold, then the street lines", () => {
    const html = renderToStaticMarkup(createElement(ShipToSection, { shipping, location: { name: "Buford HQ", address: null } }));
    expect(html).toContain('<span class="block font-semibold">Buford HQ</span>');
    expect(html).toContain("100 Example Way");
    expect(html).not.toContain("Casey Lin");
  });

  it("shows the address alone without a location, and says when there is none", () => {
    expect(renderToStaticMarkup(createElement(ShipToSection, { shipping, location: null }))).toContain(">Casey Lin<");
    expect(renderToStaticMarkup(createElement(ShipToSection, { shipping: null, location: null }))).toContain("No shipping address.");
  });
});
