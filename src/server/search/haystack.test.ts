import { describe, it, expect } from "vitest";
import { buildHaystack, HAYSTACK_MAX, normalizeSearchText, requesterOf, searchRowOf } from "./haystack";
import { draftSnapshotOf, snapshotOf } from "@/server/desk/test-helpers";

describe("normalizeSearchText", () => {
  it("lowercases and folds every run of whitespace to one space", () => {
    expect(normalizeSearchText("  Hard\tHat \n\n WHITE ")).toBe("hard hat white");
  });
});

describe("buildHaystack", () => {
  it("holds numbers, requester, request fields, location, items, sizes, personalization and PO numbers", () => {
    const text = buildHaystack({
      name: "#1042",
      draftName: "#D19",
      shopify: snapshotOf({
        name: "#1042",
        customerName: "Riley Oakes",
        email: "riley.oakes@example.com",
        items: [
          {
            title: "Business Cards",
            qty: 1,
            sku: "BC-500",
            variant: "Matte",
            props: [
              { key: "Name", value: "Avery Stone" },
              { key: "Title", value: "Yard Lead" },
              { key: "_pdf", value: "https://cdn.shopify.com/s/files/proof.pdf" },
              { key: "Preview", value: "https://cdn.shopify.com/s/files/preview.png" },
            ],
          },
        ],
      }),
      draftSnapshot: draftSnapshotOf({
        location: "North Yard",
        attributes: [
          { key: "For Employee Name", value: "Avery Stone" },
          { key: "Ship to Branch", value: "North Yard" },
        ],
        poNumber: "CUST-77",
      }),
      locationName: "North Yard",
      poNumbers: ["IMP-2026-0007"],
    });
    for (const part of [
      "#1042",
      "#d19",
      "riley oakes",
      "riley.oakes@example.com",
      "north yard",
      "avery stone",
      "business cards",
      "bc-500",
      "matte",
      "yard lead",
      "cust-77",
      "imp-2026-0007",
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("cdn.shopify.com");
    expect(text).not.toContain("proof.pdf");
  });

  it("names each value once, lowercased, with single spaces", () => {
    const text = buildHaystack({
      name: "#1",
      draftName: null,
      shopify: snapshotOf({ customerName: "Riley  Oakes", email: "RILEY@example.com", items: [] }),
      draftSnapshot: snapshotOf({ customerName: "riley oakes", email: "riley@example.com", items: [] }),
      locationName: null,
      poNumbers: [],
    });
    expect(text.split(" | ").filter((part) => part === "riley oakes")).toHaveLength(1);
    expect(text).toBe(text.toLowerCase());
    expect(text).not.toMatch(/\s{2}/);
  });

  it("uses the draft's items while the order has none, and caps the length", () => {
    const fromDraft = buildHaystack({
      name: "#1050",
      draftName: "#D30",
      shopify: snapshotOf({ items: [] }),
      draftSnapshot: draftSnapshotOf(),
      locationName: null,
      poNumbers: [],
    });
    expect(fromDraft).toContain("business cards");
    const long = buildHaystack({
      name: "#9",
      draftName: null,
      shopify: snapshotOf({
        items: Array.from({ length: 35 }, (_, i) => ({ title: `Item ${i} ${"x".repeat(300)}`, qty: 1, sku: `SKU-${i}`, variant: "", props: [] })),
      }),
      draftSnapshot: null,
      locationName: null,
      poNumbers: [],
    });
    expect(long.length).toBeLessThanOrEqual(HAYSTACK_MAX);
  });
});

describe("requesterOf", () => {
  it("reads the customer from the current snapshot, then from the draft it came from", () => {
    expect(requesterOf(snapshotOf({ customerId: "77", customerName: " Riley Oakes ", email: "Riley@Example.com" }), null)).toEqual({
      customerId: "77",
      name: "Riley Oakes",
      email: "riley@example.com",
      contactId: "",
    });
    expect(requesterOf(snapshotOf({ customerName: "", email: "" }), draftSnapshotOf({ customerId: "78", contactId: "501" }))).toEqual({
      customerId: "78",
      name: "Jordan Vale",
      email: "jordan@example.com",
      contactId: "501",
    });
    expect(requesterOf(null, null)).toEqual({ customerId: "", name: "", email: "", contactId: "" });
  });
});

describe("searchRowOf", () => {
  it("copies the filter columns and derives the kind from the order id", () => {
    const card = {
      id: "o1",
      workspaceId: "ws",
      shopifyOrderId: null,
      name: "#D12",
      shopify: draftSnapshotOf(),
      statusKey: "new",
      statusSetAt: 5,
      createdAt: 1000,
      draftName: "#D12",
      draftSnapshot: null,
      locationId: "loc1",
    };
    expect(searchRowOf(card, { closed: true, locationName: "North Yard", poNumbers: [], requesterId: "p1" })).toMatchObject({
      orderId: "o1",
      workspaceId: "ws",
      kind: "draft",
      statusKey: "new",
      closed: 1,
      locationId: "loc1",
      requesterId: "p1",
      createdAt: 1000,
      statusSetAt: 5,
    });
    expect(
      searchRowOf({ ...card, shopifyOrderId: "9001" }, { closed: false, locationName: null, poNumbers: [], requesterId: null }),
    ).toMatchObject({ kind: "order", closed: 0, requesterId: null });
  });
});
