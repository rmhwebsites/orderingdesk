import { describe, it, expect } from "vitest";
import fixture from "./__fixtures__/orders-graphql.json";
import { normalizeOrders, type NormalizedOrder } from "./normalize";

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
      { title: "Scaffold Frame 5 ft", qty: 4, price: "89.00", sku: "SF-60", variant: "Galvanized" },
      { title: 'Caster Wheel 8" with "brake"', qty: 1, price: null, sku: "", variant: "" },
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
      { title: "Pallet Jack", qty: 2, price: "349.00", sku: "PJ-11", variant: "Standard" },
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
      { title: "Hard Hat", qty: 3, price: null, sku: "HH-1", variant: "White" },
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
});
