import { describe, it, expect } from "vitest";
import {
  CANCEL_ORDER_MUTATION,
  ORDER_CANCEL_STATE_QUERY,
  STAFF_NOTE_MAX,
  cancelOrderInShopify,
  fetchOrderCancelState,
} from "./admin";

// Cancel after approval (comprehensive design section 2): orderCancel as
// the 2026-10 Admin API documents it, against a stubbed fetch.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_cancel_docs_token_never_leak";
const ORDER = "gid://shopify/Order/9001";

type Call = { query: string; variables: Record<string, unknown> };

function stub(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("cancelOrderInShopify", () => {
  it("cancels with no customer email, no restock and no refund, and sends nothing else", async () => {
    const { impl, calls } = stub(() => ({
      data: { orderCancel: { job: { id: "gid://shopify/Job/1", done: false }, orderCancelUserErrors: [] } },
    }));
    expect(await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, "Ordering Desk: Duplicate order", impl)).toEqual({
      kind: "ok",
      jobId: "gid://shopify/Job/1",
      done: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe(CANCEL_ORDER_MUTATION);
    expect(calls[0].variables).toEqual({
      orderId: ORDER,
      reason: "OTHER",
      restock: false,
      notifyCustomer: false,
      staffNote: "Ordering Desk: Duplicate order",
    });
    // No refund argument at all: left out, orderCancel refunds nothing.
    expect(CANCEL_ORDER_MUTATION).not.toMatch(/refund/i);
    expect(CANCEL_ORDER_MUTATION).toContain("orderCancelUserErrors { field message code }");
    expect(CANCEL_ORDER_MUTATION).not.toMatch(/\buserErrors\b/);
  });

  it("cuts the staff note to Shopify's 255 characters", async () => {
    const { impl, calls } = stub(() => ({ data: { orderCancel: { job: null, orderCancelUserErrors: [] } } }));
    await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, "x".repeat(400), impl);
    expect(STAFF_NOTE_MAX).toBe(255);
    expect(String(calls[0].variables.staffNote)).toHaveLength(255);
  });

  // Wave 1b final review: the cut counts code points, so a character
  // outside the Basic Multilingual Plane is kept whole or dropped whole,
  // never split into a lone surrogate.
  it("cuts the staff note by code points, never leaving half a character", async () => {
    const { impl, calls } = stub(() => ({ data: { orderCancel: { job: null, orderCancelUserErrors: [] } } }));
    const wide = "\u{1F4E6}";
    await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, "x".repeat(254) + wide + "y", impl);
    expect(calls[0].variables.staffNote).toBe("x".repeat(254) + wide);
    await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, wide.repeat(300), impl);
    const note = String(calls[1].variables.staffNote);
    expect(Array.from(note)).toHaveLength(255);
    expect(note).toBe(wide.repeat(255));
  });

  it("answers Shopify's refusal in its own words", async () => {
    const { impl } = stub(() => ({
      data: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [{ field: ["orderId"], message: "Order has already been cancelled", code: "INVALID" }],
        },
      },
    }));
    expect(await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, "Ordering Desk: x", impl)).toEqual({
      kind: "refused",
      detail: "Order has already been cancelled",
    });
  });
});

describe("fetchOrderCancelState", () => {
  it("reads whether Shopify cancelled the order, its fulfillment and its total, or null", async () => {
    const { impl, calls } = stub(() => ({
      data: {
        order: {
          id: ORDER,
          name: "#1234",
          cancelledAt: "2026-10-06T15:00:00Z",
          displayFulfillmentStatus: "UNFULFILLED",
          currentTotalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
        },
      },
    }));
    expect(await fetchOrderCancelState(DOMAIN, TOKEN, ORDER, impl)).toEqual({
      kind: "ok",
      order: { name: "#1234", cancelledAt: "2026-10-06T15:00:00Z", fulfillment: "UNFULFILLED", total: "0.0", currency: "USD" },
    });
    expect(calls[0].query).toBe(ORDER_CANCEL_STATE_QUERY);
    expect(calls[0].variables).toEqual({ id: ORDER });
    const gone = stub(() => ({ data: { order: null } }));
    expect(await fetchOrderCancelState(DOMAIN, TOKEN, ORDER, gone.impl)).toEqual({ kind: "ok", order: null });
  });
});
