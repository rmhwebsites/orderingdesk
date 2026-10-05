import { describe, it, expect } from "vitest";
import { financialTone, fulfillmentTone, itemsSubtotal, readSnapshot, shippingLines } from "./order-snapshot";

describe("readSnapshot", () => {
  it("reads a stored snapshot", () => {
    const snapshot = readSnapshot({
      customerName: "Riley Oakes",
      email: "riley.oakes@example.com",
      total: "120.00",
      currency: "CAD",
      financialStatus: "paid",
      fulfillmentStatus: "unfulfilled",
      items: [{ title: "Hard Hat", qty: 2, price: "10.00", sku: "HH-1", variant: "White" }],
      shipping: { name: "Riley Oakes", a1: "12 Dock Rd", a2: "", city: "Halifax", prov: "NS", zip: "B3H 1A1", country: "CA" },
      tags: "rush, sample-data, ",
      note: "Leave at the side door",
    });
    expect(snapshot.items).toEqual([
      { title: "Hard Hat", qty: 2, price: "10.00", sku: "HH-1", variant: "White", props: [], custom: false },
    ]);
    expect(snapshot.tags).toEqual(["rush", "sample-data"]);
    // A snapshot stored before snapshots carried a kind reads as an order.
    expect(snapshot.kind).toBe("order");
    expect(snapshot.shipping?.city).toBe("Halifax");
  });

  // Draft orders spec sections 4 and 11.3.
  it("reads a draft's own fields and every item's personalization", () => {
    const snapshot = readSnapshot({
      kind: "draft",
      name: "#D12",
      status: "invoice_sent",
      createdAt: 1700000000000,
      orderName: null,
      customerName: "Jordan Vale",
      total: "0.00",
      subtotal: "48.00",
      discounts: "48.00",
      currency: "USD",
      discount: { title: "B2B catalog", value: "100", valueType: "PERCENTAGE" },
      discountCodes: ["IMPACT100", 7],
      items: [
        {
          title: "Business cards",
          qty: 250,
          price: "0.00",
          sku: "BC",
          variant: "",
          custom: true,
          props: [{ key: "Full Name", value: "Casey Lin" }, { key: 4, value: "x" }, { key: "_pdf", value: null }],
        },
      ],
      shipping: { name: "Jordan Vale", company: "IMPACT Rentals, Buford HQ", phone: "+1 470 555 0142", a1: "1 Depot Way", a2: "", city: "Buford", prov: "GA", zip: "30518", country: "US" },
      note: "Please rush",
      poNumber: "PO-77",
    });
    expect(snapshot).toMatchObject({
      kind: "draft",
      name: "#D12",
      draftStatus: "invoice_sent",
      subtotal: "48.00",
      discounts: "48.00",
      discount: { title: "B2B catalog", value: "100", valueType: "PERCENTAGE" },
      discountCodes: ["IMPACT100"],
      poNumber: "PO-77",
      note: "Please rush",
    });
    expect(snapshot.items[0]).toMatchObject({
      custom: true,
      props: [
        { key: "Full Name", value: "Casey Lin" },
        { key: "_pdf", value: "" },
      ],
    });
    expect(snapshot.shipping).toMatchObject({ company: "IMPACT Rentals, Buford HQ", phone: "+1 470 555 0142" });
    expect(shippingLines(snapshot.shipping!)).toEqual([
      "Jordan Vale",
      "IMPACT Rentals, Buford HQ",
      "1 Depot Way",
      "Buford GA 30518",
      "US",
    ]);
  });

  it("degrades a malformed snapshot to empty fields instead of failing", () => {
    const snapshot = readSnapshot({ items: [null, { title: 5, qty: "2" }], shipping: "nope", tags: 7 });
    expect(snapshot.items).toEqual([{ title: "", qty: 1, price: null, sku: "", variant: "", props: [], custom: false }]);
    expect(snapshot.shipping).toBeNull();
    expect(snapshot.tags).toEqual([]);
    expect(readSnapshot(null).customerName).toBe("");
  });
});

describe("itemsSubtotal", () => {
  it("sums price times quantity", () => {
    expect(
      itemsSubtotal([
        { title: "a", qty: 2, price: "10.00", sku: "", variant: "" },
        { title: "b", qty: 1, price: "5.50", sku: "", variant: "" },
      ]),
    ).toBe("25.50");
  });

  it("is null when any price is missing or there are no items", () => {
    expect(itemsSubtotal([{ title: "a", qty: 1, price: null, sku: "", variant: "" }])).toBeNull();
    expect(itemsSubtotal([])).toBeNull();
  });
});

describe("shippingLines", () => {
  it("drops empty parts", () => {
    expect(
      shippingLines({ name: "Riley Oakes", a1: "12 Dock Rd", a2: "", city: "Halifax", prov: "NS", zip: "B3H 1A1", country: "CA" }),
    ).toEqual(["Riley Oakes", "12 Dock Rd", "Halifax NS B3H 1A1", "CA"]);
  });
});

describe("Shopify state tones", () => {
  it("maps payment states", () => {
    expect(financialTone("paid")).toBe("green");
    expect(financialTone("pending")).toBe("amber");
    expect(financialTone("partially refunded")).toBe("slate");
    expect(financialTone("something new")).toBe("slate");
  });

  it("maps fulfillment states", () => {
    expect(fulfillmentTone("fulfilled")).toBe("green");
    expect(fulfillmentTone("unfulfilled")).toBe("amber");
    expect(fulfillmentTone("partially fulfilled")).toBe("amber");
    expect(fulfillmentTone("restocked")).toBe("slate");
  });
});
