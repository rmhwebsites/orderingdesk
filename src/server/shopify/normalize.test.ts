import { describe, it, expect } from "vitest";
import fixture from "./__fixtures__/orders-graphql.json";
import draftFixture from "./__fixtures__/draft-orders-graphql.json";
import {
  ATTRIBUTE_KEY_MAX,
  ATTRIBUTE_VALUE_MAX,
  ATTRIBUTES_MAX,
  companyLocationIdOf,
  ITEM_PROPS_MAX,
  normalizeDrafts,
  normalizeOrders,
  snapshotKind,
  type NormalizedDraft,
  type NormalizedOrder,
} from "./normalize";

const fixtureNodes = (fixture as { data: { orders: { nodes: unknown[]; pageInfo: unknown } } })
  .data.orders.nodes;
const fixturePageInfo = (fixture as { data: { orders: { pageInfo: unknown } } }).data.orders
  .pageInfo;

function byName(result: NormalizedOrder[], name: string): NormalizedOrder {
  const found = result.find((o) => o.name === name);
  expect(found, `expected an order named ${name}`).toBeDefined();
  return found as NormalizedOrder;
}

describe("normalizeOrders", () => {
  it("normalizes a full order from the GraphQL envelope", () => {
    const result = normalizeOrders(fixture);
    const o = byName(result, "#1001");
    expect(o.shopifyOrderId).toBe("6001");
    expect(o.createdAt).toBe(Date.parse("2026-09-12T14:03:22Z"));
    expect(o.customerName).toBe("Riley Oakes");
    expect(o.email).toBe("riley.oakes@example.com");
    expect(o.total).toBe("412.50");
    expect(o.currency).toBe("CAD");
    expect(o.financialStatus).toBe("partially refunded");
    expect(o.fulfillmentStatus).toBe("partially fulfilled");
    expect(o.tags).toBe("wholesale, rush");
    expect(o.shipping).toEqual({
      name: "Riley Oakes",
      a1: "48 Dockside Ave",
      a2: "Unit 12",
      city: "Thunder Bay",
      prov: "ON",
      zip: "P7B 6T9",
      country: "CA",
    });
    expect(o.items).toEqual([
      { title: "Scaffold Frame 5 ft", qty: 4, price: "89.00", sku: "SF-60", variant: "Galvanized", props: [] },
      { title: 'Caster Wheel 8" with "brake"', qty: 1, price: null, sku: "", variant: "", props: [] },
    ]);
    expect(o.itemsTruncated).toBe(false);
  });

  it("prefers legacyResourceId over the gid, and parses the gid otherwise", () => {
    const result = normalizeOrders(fixture);
    expect(byName(result, "#1001").shopifyOrderId).toBe("6001");
    expect(byName(result, "#1002").shopifyOrderId).toBe("6002");
  });

  it("handles a missing customer", () => {
    const o = byName(normalizeOrders(fixture), "#1002");
    expect(o.customerName).toBe("");
    expect(o.email).toBe("dispatch@harborline.ca");
  });

  it("falls back to the customer email when the order has none, lowercased", () => {
    const result = normalizeOrders([
      {
        id: "gid://shopify/Order/7001",
        name: "#1007",
        customer: { firstName: "Theo", lastName: "Branch", email: "Theo.Branch@Example.com" },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("theo.branch@example.com");
    expect(result[0].customerName).toBe("Theo Branch");
  });

  it("handles a missing shipping address as null", () => {
    expect(byName(normalizeOrders(fixture), "#1003").shipping).toBeNull();
  });

  it("builds the shipping name from first and last name when name is absent", () => {
    const o = byName(normalizeOrders(fixture), "#1002");
    expect(o.shipping).toEqual({
      name: "Marisol Quint",
      a1: "220 Pier Rd",
      a2: "",
      city: "Halifax",
      prov: "NS",
      zip: "B3H 4R2",
      country: "CA",
    });
  });

  it("reads the country from countryCodeV2, falling back to countryCode", () => {
    const [v2, legacy, both] = normalizeOrders([
      { id: "gid://shopify/Order/1", shippingAddress: { countryCodeV2: "US" } },
      { id: "gid://shopify/Order/2", shippingAddress: { countryCode: "CA" } },
      { id: "gid://shopify/Order/3", shippingAddress: { countryCodeV2: "GB", countryCode: "CA" } },
    ]);
    expect(v2.shipping?.country).toBe("US");
    expect(legacy.shipping?.country).toBe("CA");
    expect(both.shipping?.country).toBe("GB");
  });

  it("joins array tags and keeps string tags as-is", () => {
    const result = normalizeOrders(fixture);
    expect(byName(result, "#1001").tags).toBe("wholesale, rush");
    expect(byName(result, "#1002").tags).toBe("net-30");
    expect(byName(result, "#1003").tags).toBe("");
  });

  it("turns an invalid createdAt into 0", () => {
    expect(byName(normalizeOrders(fixture), "#1003").createdAt).toBe(0);
  });

  it("falls back to totalPriceSet when currentTotalPriceSet is absent", () => {
    const o = byName(normalizeOrders(fixture), "#1003");
    expect(o.total).toBe("75.25");
    expect(o.currency).toBe("USD");
  });

  it("defaults fulfillment to unfulfilled and empty note to an empty string", () => {
    const o = byName(normalizeOrders(fixture), "#1003");
    expect(o.fulfillmentStatus).toBe("unfulfilled");
    expect(o.financialStatus).toBe("pending");
    expect(o.note).toBe("");
    expect(o.email).toBe("");
  });

  it("passes hostile text through unchanged (quotes, newlines, unicode)", () => {
    const o = byName(normalizeOrders(fixture), "#1001");
    expect(o.note).toBe(
      'Gate code "42-B", leave with concierge.\nAttn: Lodz cafe, second floor, ask for Łucja.',
    );
    expect(o.items[1].title).toBe('Caster Wheel 8" with "brake"');
  });

  it("parses edges-wrapped orders identically to nodes", () => {
    const edgesPayload = {
      data: {
        orders: {
          edges: fixtureNodes.map((node) => ({ node })),
          pageInfo: fixturePageInfo,
        },
      },
    };
    expect(normalizeOrders(edgesPayload)).toEqual(normalizeOrders(fixture));
  });

  it("accepts a bare nodes array, which is what the client passes", () => {
    expect(normalizeOrders(fixtureNodes)).toEqual(normalizeOrders(fixture));
  });

  it("parses edges-wrapped line items", () => {
    const result = normalizeOrders([
      {
        id: "gid://shopify/Order/7002",
        name: "#1008",
        lineItems: {
          edges: [
            {
              node: {
                title: "Pallet Jack",
                quantity: 2,
                sku: "PJ-11",
                variantTitle: "Standard",
                originalUnitPriceSet: { shopMoney: { amount: "349.00" } },
              },
            },
          ],
        },
      },
    ]);
    expect(result[0].items).toEqual([
      { title: "Pallet Jack", qty: 2, price: "349.00", sku: "PJ-11", variant: "Standard", props: [] },
    ]);
  });

  // The sync asks for one page of line items per order. When Shopify says
  // more exist, items holds only that page and the order says so.
  it("marks an order whose line items continue past the fetched page", () => {
    const result = normalizeOrders([
      {
        id: "gid://shopify/Order/7004",
        name: "#1010",
        lineItems: {
          nodes: [{ title: "Hard Hat", quantity: 3, sku: "HH-1", variantTitle: "White" }],
          pageInfo: { hasNextPage: true },
        },
      },
    ]);
    expect(result[0].itemsTruncated).toBe(true);
    expect(result[0].items).toEqual([
      { title: "Hard Hat", qty: 3, price: null, sku: "HH-1", variant: "White", props: [] },
    ]);
  });

  it("reads the marker from edges-wrapped line items too", () => {
    const result = normalizeOrders([
      {
        id: "gid://shopify/Order/7005",
        name: "#1011",
        lineItems: {
          edges: [{ node: { title: "Hard Hat", quantity: 3 } }],
          pageInfo: { hasNextPage: true },
        },
      },
    ]);
    expect(result[0].itemsTruncated).toBe(true);
    expect(result[0].items).toHaveLength(1);
  });

  // A purchase order is prefilled from items, so a list Shopify never
  // confirmed as whole must not pass for one.
  it("counts line items as complete only when Shopify says there is no next page", () => {
    const withLineItems = (lineItems: unknown) =>
      normalizeOrders([{ id: "gid://shopify/Order/7006", name: "#1012", lineItems }])[0];
    expect(withLineItems({ nodes: [], pageInfo: { hasNextPage: false } }).itemsTruncated).toBe(
      false,
    );
    const unconfirmed = [
      { nodes: [] },
      { nodes: [], pageInfo: null },
      { nodes: [], pageInfo: {} },
      { nodes: [], pageInfo: { hasNextPage: "false" } },
      null,
      undefined,
    ];
    for (const lineItems of unconfirmed) {
      expect(withLineItems(lineItems).itemsTruncated, String(JSON.stringify(lineItems))).toBe(
        true,
      );
    }
  });

  // The delivered state (platform amendment section 4) is confirmed only
  // when Shopify reports the order fulfilled and every fulfillment that was
  // not canceled as delivered or picked up, from a list known to be whole.
  describe("delivered", () => {
    const withFulfillments = (displayFulfillmentStatus: unknown, fulfillments: unknown) =>
      normalizeOrders([
        { id: "gid://shopify/Order/7101", name: "#1101", displayFulfillmentStatus, fulfillments },
      ])[0];

    it("is true for a fulfilled order whose fulfillments are all delivered or picked up", () => {
      expect(withFulfillments("FULFILLED", [{ displayStatus: "DELIVERED" }]).delivered).toBe(true);
      expect(
        withFulfillments("FULFILLED", [{ displayStatus: "DELIVERED" }, { displayStatus: "PICKED_UP" }])
          .delivered,
      ).toBe(true);
      // A canceled fulfillment does not hold the order back.
      expect(
        withFulfillments("FULFILLED", [{ displayStatus: "CANCELED" }, { displayStatus: "DELIVERED" }])
          .delivered,
      ).toBe(true);
    });

    it("is false unless every live fulfillment is confirmed delivered", () => {
      const cases: Array<[unknown, unknown]> = [
        ["FULFILLED", [{ displayStatus: "IN_TRANSIT" }]],
        ["FULFILLED", [{ displayStatus: "DELIVERED" }, { displayStatus: "OUT_FOR_DELIVERY" }]],
        ["FULFILLED", [{ displayStatus: "CANCELED" }]],
        ["FULFILLED", []],
        ["FULFILLED", undefined],
        ["FULFILLED", null],
        ["FULFILLED", "DELIVERED"],
        ["FULFILLED", [null]],
        // Not fulfilled as a whole: a partial delivery is not the order's.
        ["PARTIALLY_FULFILLED", [{ displayStatus: "DELIVERED" }]],
        ["UNFULFILLED", [{ displayStatus: "DELIVERED" }]],
        [undefined, [{ displayStatus: "DELIVERED" }]],
        // A full list (three slots) may have more fulfillments beyond it.
        [
          "FULFILLED",
          [{ displayStatus: "DELIVERED" }, { displayStatus: "DELIVERED" }, { displayStatus: "DELIVERED" }],
        ],
      ];
      for (const [status, fulfillments] of cases) {
        expect(
          withFulfillments(status, fulfillments).delivered,
          JSON.stringify([status, fulfillments]),
        ).toBe(false);
      }
    });

    it("stays false for the fixture orders, which carry no fulfillment list", () => {
      for (const order of normalizeOrders(fixture)) {
        expect(order.delivered).toBe(false);
      }
    });
  });

  // Draft orders spec section 4: orders carry their kind, where they came
  // from, their cart attributes and each line item's properties (copied from
  // the draft on completion).
  it("adds the kind, the source, cart attributes and line item properties", () => {
    const [order] = normalizeOrders([
      {
        id: "gid://shopify/Order/7801",
        legacyResourceId: "7801",
        name: "#1031",
        sourceName: "shopify_draft_order",
        customAttributes: [
          { key: "Ship to Branch", value: "Buford HQ" },
          { key: "", value: "dropped" },
          { key: "Note", value: null },
        ],
        lineItems: {
          nodes: [
            {
              title: "IMPACT Business Cards",
              quantity: 1,
              customAttributes: [
                { key: "Full Name", value: "Casey Lin" },
                { key: "_pdf", value: "https://cdn.shopify.com/proof.pdf" },
                { key: 7, value: "not a key" },
              ],
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    ]);
    expect(order.kind).toBe("order");
    expect(order.sourceName).toBe("shopify_draft_order");
    expect(order.attributes).toEqual([
      { key: "Ship to Branch", value: "Buford HQ" },
      { key: "Note", value: "" },
    ]);
    expect(order.items[0].props).toEqual([
      { key: "Full Name", value: "Casey Lin" },
      { key: "_pdf", value: "https://cdn.shopify.com/proof.pdf" },
    ]);
    expect(Object.keys(order)).toEqual([
      "kind",
      "shopifyOrderId",
      "name",
      "createdAt",
      "customerName",
      "email",
      "total",
      "currency",
      "financialStatus",
      "fulfillmentStatus",
      "delivered",
      "items",
      "itemsTruncated",
      "shipping",
      "tags",
      "note",
      "sourceName",
      "attributes",
      "cancelledAt",
      "locationId",
    ]);
    const [bare] = normalizeOrders([{ id: "gid://shopify/Order/7802" }]);
    expect(bare.sourceName).toBe("");
    expect(bare.attributes).toEqual([]);
  });

  it("returns [] for malformed payloads", () => {
    expect(normalizeOrders(null)).toEqual([]);
    expect(normalizeOrders(undefined)).toEqual([]);
    expect(normalizeOrders({})).toEqual([]);
    expect(normalizeOrders("not a payload")).toEqual([]);
    expect(normalizeOrders(42)).toEqual([]);
    expect(normalizeOrders({ data: {} })).toEqual([]);
    expect(normalizeOrders({ data: { orders: {} } })).toEqual([]);
  });

  it("skips an order without any usable id", () => {
    const result = normalizeOrders(fixture);
    expect(result).toHaveLength(3);
    expect(result.map((o) => o.name)).not.toContain("#1004");
  });

  it("skips non-object entries in a nodes array", () => {
    const result = normalizeOrders([
      null,
      "junk",
      7,
      { id: "gid://shopify/Order/7003", name: "#1009" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].shopifyOrderId).toBe("7003");
  });

  // Comprehensive design section 2: an order Shopify cancelled, and the B2B
  // company location the order ships to (the purchasing entity).
  it("reads the cancellation time and the purchasing entity's company location", () => {
    const [order] = normalizeOrders([
      {
        id: "gid://shopify/Order/7901",
        legacyResourceId: "7901",
        name: "#1041",
        cancelledAt: "2026-10-05T16:00:00Z",
        purchasingEntity: { __typename: "PurchasingCompany", location: { id: "gid://shopify/CompanyLocation/101" } },
      },
    ]);
    expect(order.cancelledAt).toBe(Date.parse("2026-10-05T16:00:00Z"));
    expect(order.locationId).toBe("101");
    const [plain] = normalizeOrders([
      { id: "gid://shopify/Order/7902", purchasingEntity: { __typename: "Customer" }, cancelledAt: null },
    ]);
    expect(plain.cancelledAt).toBeNull();
    expect(plain.locationId).toBeNull();
    const [odd] = normalizeOrders([
      { id: "gid://shopify/Order/7903", purchasingEntity: { location: { id: "gid://shopify/Location/5" } }, cancelledAt: "soon" },
    ]);
    expect(odd.locationId).toBeNull();
    expect(odd.cancelledAt).toBeNull();
  });
});

const draftNodes = (draftFixture as { data: { draftOrders: { nodes: unknown[] } } }).data.draftOrders.nodes;

function draftNamed(result: NormalizedDraft[], name: string): NormalizedDraft {
  const found = result.find((d) => d.name === name);
  expect(found, `expected a draft named ${name}`).toBeDefined();
  return found as NormalizedDraft;
}

describe("normalizeDrafts", () => {
  it("normalizes a B2B request with its company, cart attributes and personalization", () => {
    const d = draftNamed(normalizeDrafts(draftFixture), "#D12");
    expect(d).toEqual({
      kind: "draft",
      shopifyDraftId: "1038600000012",
      name: "#D12",
      status: "open",
      createdAt: Date.parse("2026-10-03T15:20:00Z"),
      completedAt: null,
      orderId: null,
      orderName: null,
      customerName: "Jordan Vale",
      email: "jordan.vale@example.com",
      company: "Impact Rentals",
      location: "Buford, GA",
      attributes: [
        { key: "Ship to Branch", value: "Buford HQ" },
        { key: "For Employee Name", value: "Casey Lin" },
        { key: "Reason for Request", value: "New hire" },
        { key: "Internal Notes", value: "" },
      ],
      discountCodes: ["STAFF100"],
      discount: { title: "Staff", value: "25", valueType: "FIXED_AMOUNT" },
      subtotal: "25.0",
      discounts: "25.0",
      total: "0.0",
      currency: "USD",
      items: [
        {
          title: "IMPACT Business Cards",
          qty: 1,
          price: "25.0",
          sku: "IR-PR-BIZCARD-200",
          variant: "200",
          props: [
            { key: "Full Name", value: "Casey Lin" },
            { key: "Job Title", value: "Branch Manager" },
            { key: "Office Address", value: "100 Example Way\r\nBuford, GA 30518" },
            { key: "Preview", value: "https://cdn.shopify.com/s/files/1/0000/0001/files/preview-casey.png" },
            { key: "_pdf", value: "https://cdn.shopify.com/s/files/1/0000/0001/files/proof-casey.pdf" },
            { key: "_pplr_preview", value: "Preview" },
          ],
          custom: false,
        },
        { title: "Custom banner", qty: 2, price: null, sku: "", variant: "", props: [], custom: true },
      ],
      itemsTruncated: false,
      shipping: {
        name: "Jordan Vale",
        a1: "100 Example Way",
        a2: "",
        city: "Buford",
        prov: "GA",
        zip: "30518",
        country: "US",
        company: "IMPACT Rentals, Buford HQ",
        phone: "+15555550100",
      },
      tags: "Ordering Desk: New, staff",
      note: "Needed before the Monday crew meeting",
      poNumber: "PO-77",
      locationId: "2",
    });
  });

  it("reads a completed draft's order and falls back for the name and email", () => {
    const d = draftNamed(normalizeDrafts(draftFixture), "#D13");
    expect(d.status).toBe("completed");
    expect(d.completedAt).toBe(Date.parse("2026-10-02T09:00:00Z"));
    expect(d.orderId).toBe("7801300000031");
    expect(d.orderName).toBe("#1031");
    expect(d.customerName).toBe("Riley Oakes");
    expect(d.email).toBe("riley@example.com");
    expect(d.location).toBe("Water Tower HQ");
    expect(d.shipping).toBeNull();
    expect(d.discount).toBeNull();
  });

  it("degrades missing and malformed fields to defaults", () => {
    const d = draftNamed(normalizeDrafts(draftNodes), "#D14");
    expect(d.shopifyDraftId).toBe("1038600000014");
    expect(d.status).toBe("invoice_sent");
    expect(d.createdAt).toBe(0);
    expect(d.company).toBe("");
    expect(d.location).toBe("");
    expect(d.customerName).toBe("Sam Ruiz");
    expect(d.email).toBe("");
    expect(d.total).toBe("0");
    expect(d.currency).toBe("USD");
    expect(d.items).toEqual([]);
    expect(d.itemsTruncated).toBe(true);
    expect(d.shipping).toEqual({ name: "Sam Ruiz", a1: "", a2: "", city: "", prov: "", zip: "", country: "CA", company: "", phone: "" });
    expect(d.attributes).toEqual([]);
    expect(d.discountCodes).toEqual([]);
    expect(d.tags).toBe("");
    expect(d.note).toBe("");
    expect(d.poNumber).toBe("");
  });

  it("maps Shopify's statuses, reading anything unknown as open", () => {
    const statusOf = (status: unknown) => normalizeDrafts([{ id: "gid://shopify/DraftOrder/1", status }])[0].status;
    expect(statusOf("OPEN")).toBe("open");
    expect(statusOf("INVOICE_SENT")).toBe("invoice_sent");
    expect(statusOf("COMPLETED")).toBe("completed");
    expect(statusOf("SOMETHING_NEW")).toBe("open");
    expect(statusOf(undefined)).toBe("open");
    expect(statusOf("constructor")).toBe("open");
  });

  it("reads the order id from the gid when the legacy id is missing", () => {
    const [d] = normalizeDrafts([
      { id: "gid://shopify/DraftOrder/5", status: "COMPLETED", order: { id: "gid://shopify/Order/88", name: "#1088" } },
    ]);
    expect(d.orderId).toBe("88");
    expect(d.orderName).toBe("#1088");
  });

  it("passes hostile text through untouched", () => {
    const hostile = '<img src=x onerror="alert(1)"> \u0000 "quoted" \n Łucja';
    const [d] = normalizeDrafts([
      {
        id: "gid://shopify/DraftOrder/6",
        note2: hostile,
        customAttributes: [{ key: hostile, value: hostile }],
        lineItems: { nodes: [{ title: hostile, customAttributes: [{ key: "Full Name", value: hostile }] }] },
      },
    ]);
    expect(d.note).toBe(hostile);
    expect(d.attributes).toEqual([{ key: hostile, value: hostile }]);
    expect(d.items[0].title).toBe(hostile);
    expect(d.items[0].props).toEqual([{ key: "Full Name", value: hostile }]);
  });

  it("caps attribute and property sizes and counts", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
    const [d] = normalizeDrafts([
      {
        id: "gid://shopify/DraftOrder/7",
        customAttributes: [{ key: "k".repeat(500), value: "v".repeat(5000) }, ...many(80)],
        lineItems: { nodes: [{ title: "Cards", customAttributes: many(60) }] },
      },
    ]);
    expect(d.attributes).toHaveLength(ATTRIBUTES_MAX);
    expect(d.attributes[0].key).toHaveLength(ATTRIBUTE_KEY_MAX);
    expect(d.attributes[0].value).toHaveLength(ATTRIBUTE_VALUE_MAX);
    expect(d.items[0].props).toHaveLength(ITEM_PROPS_MAX);
    expect([ATTRIBUTES_MAX, ITEM_PROPS_MAX, ATTRIBUTE_KEY_MAX, ATTRIBUTE_VALUE_MAX]).toEqual([50, 30, 200, 2000]);
  });

  it("builds every snapshot with keys in one fixed order", () => {
    const first = JSON.stringify(normalizeDrafts(draftFixture));
    const second = JSON.stringify(normalizeDrafts(JSON.parse(JSON.stringify(draftFixture))));
    expect(second).toBe(first);
    const [sparse] = normalizeDrafts([{ id: "gid://shopify/DraftOrder/8" }]);
    expect(Object.keys(sparse)).toEqual(Object.keys(draftNamed(normalizeDrafts(draftFixture), "#D12")));
  });

  it("accepts edges, skips drafts without an id and malformed payloads", () => {
    const edges = { data: { draftOrders: { edges: draftNodes.map((node) => ({ node })) } } };
    expect(normalizeDrafts(edges)).toEqual(normalizeDrafts(draftFixture));
    expect(normalizeDrafts([null, "x", { name: "#D99" }])).toEqual([]);
    expect(normalizeDrafts(null)).toEqual([]);
    expect(normalizeDrafts({ data: { orders: { nodes: draftNodes } } })).toEqual([]);
  });

  it("reads no location for a customer's own draft", () => {
    const [draft] = normalizeDrafts([{ id: "gid://shopify/DraftOrder/9", purchasingEntity: { __typename: "Customer" } }]);
    expect(draft.locationId).toBeNull();
  });
});

describe("snapshotKind", () => {
  it("reads a draft snapshot as a draft and everything else as an order", () => {
    expect(snapshotKind(normalizeDrafts(draftFixture)[0])).toBe("draft");
    expect(snapshotKind(normalizeOrders(fixture)[0])).toBe("order");
    // Stored before the kind existed.
    expect(snapshotKind({ shopifyOrderId: "1", name: "#1001" })).toBe("order");
    expect(snapshotKind(null)).toBe("order");
    expect(snapshotKind("draft")).toBe("order");
  });
});

describe("companyLocationIdOf", () => {
  it("reads the legacy id of a company location gid and nothing else", () => {
    expect(companyLocationIdOf("gid://shopify/CompanyLocation/101")).toBe("101");
    expect(companyLocationIdOf("gid://shopify/Location/101")).toBeNull();
    expect(companyLocationIdOf("gid://shopify/CompanyLocation/0")).toBeNull();
    expect(companyLocationIdOf("gid://shopify/CompanyLocation/1x")).toBeNull();
    expect(companyLocationIdOf(101)).toBeNull();
  });
});
