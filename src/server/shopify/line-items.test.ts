import { describe, it, expect } from "vitest";
import { fetchAllLineItems, LINE_ITEM_PAGE, MAX_LINE_ITEM_PAGES } from "./admin";

// Every line item of one order, for a purchase order prefill when the
// stored snapshot holds only the first 48 (itemsTruncated). Paged with
// Shopify's cursor; network always stubbed.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_test";
const GID = "gid://shopify/Order/5001";

function page(count: number, start: number, hasNextPage: boolean, endCursor: string | null) {
  return {
    data: {
      order: {
        lineItems: {
          nodes: Array.from({ length: count }, (_, i) => ({
            title: `Item ${start + i}`,
            quantity: 1,
            sku: `SKU-${start + i}`,
            variantTitle: "",
            originalUnitPriceSet: { shopMoney: { amount: "2.50" } },
          })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

function stub(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ variables: Record<string, unknown>; query: string }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    const next = responses.shift();
    if (!next) {
      throw new Error("unexpected request");
    }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("fetchAllLineItems", () => {
  it("pages through every line item with Shopify's cursor", async () => {
    const { impl, calls } = stub([
      { body: page(LINE_ITEM_PAGE, 1, true, "c2") },
      { body: page(20, LINE_ITEM_PAGE + 1, false, null) },
    ]);
    const result = await fetchAllLineItems(DOMAIN, TOKEN, GID, impl);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.complete).toBe(true);
      expect(result.items).toHaveLength(LINE_ITEM_PAGE + 20);
      expect(result.items?.[0]).toEqual({ title: "Item 1", qty: 1, price: "2.50", sku: "SKU-1", variant: "", props: [] });
    }
    expect(calls.map((call) => call.variables)).toEqual([
      { id: GID, cursor: null },
      { id: GID, cursor: "c2" },
    ]);
    expect(calls[0].query).toContain(`lineItems(first: ${LINE_ITEM_PAGE}, after: $cursor)`);
  });

  it("says when Shopify has no such order", async () => {
    const { impl } = stub([{ body: { data: { order: null } } }]);
    expect(await fetchAllLineItems(DOMAIN, TOKEN, GID, impl)).toEqual({ kind: "ok", items: null, complete: true });
  });

  it("stops at the page cap and says the list is not complete", async () => {
    const responses = Array.from({ length: MAX_LINE_ITEM_PAGES }, (_, i) => ({
      body: page(LINE_ITEM_PAGE, i * LINE_ITEM_PAGE + 1, true, `c${i + 2}`),
    }));
    const { impl, calls } = stub(responses);
    const result = await fetchAllLineItems(DOMAIN, TOKEN, GID, impl);
    expect(result).toMatchObject({ kind: "ok", complete: false });
    expect(calls).toHaveLength(MAX_LINE_ITEM_PAGES);
  });

  it("passes Shopify failures through, and treats a page without a cursor as incomplete", async () => {
    expect(await fetchAllLineItems(DOMAIN, TOKEN, GID, stub([{ status: 401, body: {} }]).impl)).toEqual({ kind: "auth" });
    expect((await fetchAllLineItems(DOMAIN, TOKEN, GID, stub([{ status: 503, body: {} }]).impl)).kind).toBe("transient");
    const noCursor = await fetchAllLineItems(DOMAIN, TOKEN, GID, stub([{ body: page(3, 1, true, null) }]).impl);
    expect(noCursor).toMatchObject({ kind: "ok", complete: false });
  });
});
