import { describe, it, expect } from "vitest";
import {
  BASE_WEBHOOK_TOPICS,
  completeDraft,
  DRAFT_LINK_CHUNK,
  DRAFT_SCOPES,
  DRAFT_WEBHOOK_TOPICS,
  replaceWebhookSubscriptions,
  webhookTopicsFor,
  draftsEnabled,
  missingDraftScopes,
  draftGid,
  fetchDraftForApprove,
  fetchDraftLinks,
  fetchDraftNode,
  fetchStatusTags,
} from "./admin";

// The draft order operations (draft orders spec sections 3.3 to 3.6).
// Stubbed fetch only: nothing here reaches Shopify.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_admin_drafts_token_never_leak";

type Call = { query: string; variables: Record<string, unknown> };

function stub(answer: (call: Call, index: number) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call, calls.length - 1);
    if (body instanceof Response) {
      return body;
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("fetchDraftNode", () => {
  it("returns the raw draft, or null when Shopify has none", async () => {
    const node = { id: draftGid("12"), name: "#D12" };
    const found = stub(() => ({ data: { draftOrder: node } }));
    expect(await fetchDraftNode(DOMAIN, TOKEN, draftGid("12"), found.impl)).toEqual({ kind: "ok", node });
    expect(found.calls[0].variables).toEqual({ id: "gid://shopify/DraftOrder/12" });
    expect(found.calls[0].query).toContain("draftOrder(id: $id)");
    expect(found.calls[0].query).toContain("purchasingEntity");
    const gone = stub(() => ({ data: { draftOrder: null } }));
    expect(await fetchDraftNode(DOMAIN, TOKEN, draftGid("12"), gone.impl)).toEqual({ kind: "ok", node: null });
  });

  it("reports failures as the AdminFailure kinds", async () => {
    const auth = stub(() => new Response("{}", { status: 401 }));
    expect(await fetchDraftNode(DOMAIN, TOKEN, draftGid("1"), auth.impl)).toEqual({ kind: "auth" });
    const denied = stub(() => ({ errors: [{ message: "Access denied for draftOrder field." }] }));
    expect(await fetchDraftNode(DOMAIN, TOKEN, draftGid("1"), denied.impl)).toEqual({
      kind: "fatal",
      detail: "Access denied for draftOrder field.",
    });
  });
});

describe("fetchDraftLinks", () => {
  const live = (id: string, status: string, order: unknown = null) => ({
    id: draftGid(id),
    legacyResourceId: id,
    status,
    updatedAt: "2026-10-04T00:00:00Z",
    order,
  });

  it("reads each draft as open, completed with its order, or gone", async () => {
    const { impl, calls } = stub(() => ({
      data: {
        nodes: [
          live("1", "OPEN"),
          live("2", "INVOICE_SENT"),
          live("3", "COMPLETED", { id: "gid://shopify/Order/9003", legacyResourceId: "9003", name: "#1033" }),
          null,
          live("5", "COMPLETED", { id: "gid://shopify/Order/9005", name: "#1035" }),
          {},
        ],
      },
    }));
    const result = await fetchDraftLinks(DOMAIN, TOKEN, ["1", "2", "3", "4", "5", "6"], impl);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(Object.fromEntries(result.links)).toEqual({
      "1": { kind: "open" },
      "2": { kind: "open" },
      "3": { kind: "completed", orderId: "9003", orderName: "#1033" },
      "4": { kind: "gone" },
      "5": { kind: "completed", orderId: "9005", orderName: "#1035" },
    });
    // A node that is not a draft gives no verdict at all.
    expect(result.links.has("6")).toBe(false);
    expect(calls[0].variables).toEqual({ ids: ["1", "2", "3", "4", "5", "6"].map(draftGid) });
  });

  it("asks for at most 100 ids per request", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(1000 + i));
    const { impl, calls } = stub((call) => ({
      data: { nodes: (call.variables.ids as string[]).map((gid) => live(gid.slice(gid.lastIndexOf("/") + 1), "OPEN")) },
    }));
    const result = await fetchDraftLinks(DOMAIN, TOKEN, ids, impl);
    expect(DRAFT_LINK_CHUNK).toBe(100);
    expect(calls.map((call) => (call.variables.ids as string[]).length)).toEqual([100, 100, 50]);
    expect(result.kind === "ok" && result.links.size).toBe(250);
  });

  it("asks nothing for no ids, and fails the whole lookup when any chunk fails", async () => {
    const none = stub(() => {
      throw new Error("no request expected");
    });
    expect(await fetchDraftLinks(DOMAIN, TOKEN, [], none.impl)).toEqual({ kind: "ok", links: new Map() });
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const flaky = stub((call, index) =>
      index === 0
        ? { data: { nodes: (call.variables.ids as string[]).map(() => null) } }
        : { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
    );
    expect(await fetchDraftLinks(DOMAIN, TOKEN, ids, flaky.impl)).toEqual({
      kind: "transient",
      detail: "Shopify throttled the request",
    });
    const short = stub(() => ({ data: { nodes: [null] } }));
    expect(await fetchDraftLinks(DOMAIN, TOKEN, ["1", "2"], short.impl)).toEqual({
      kind: "transient",
      detail: "unexpected response shape",
    });
  });
});

describe("fetchStatusTags", () => {
  it("reads the tags of an order or a draft by its gid, null when Shopify has neither", async () => {
    const draft = stub(() => ({ data: { node: { id: draftGid("7"), tags: ["Ordering Desk: New", "vip"] } } }));
    expect(await fetchStatusTags(DOMAIN, TOKEN, draftGid("7"), draft.impl)).toEqual({
      kind: "ok",
      tags: ["Ordering Desk: New", "vip"],
    });
    expect(draft.calls[0].query).toContain("... on DraftOrder { id tags }");
    expect(draft.calls[0].query).toContain("... on Order { id tags }");
    const gone = stub(() => ({ data: { node: null } }));
    expect(await fetchStatusTags(DOMAIN, TOKEN, "gid://shopify/Order/1", gone.impl)).toEqual({ kind: "ok", tags: null });
  });
});

describe("fetchDraftForApprove", () => {
  it("reads the status, readiness, order and total fresh", async () => {
    const { impl, calls } = stub(() => ({
      data: {
        draftOrder: {
          id: draftGid("12"),
          name: "#D12",
          status: "OPEN",
          ready: true,
          completedAt: null,
          order: null,
          totalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
        },
      },
    }));
    expect(await fetchDraftForApprove(DOMAIN, TOKEN, draftGid("12"), impl)).toEqual({
      kind: "ok",
      draft: {
        name: "#D12",
        status: "OPEN",
        ready: true,
        completedAt: null,
        orderId: null,
        orderName: null,
        total: "0.0",
        currency: "USD",
      },
    });
    expect(calls[0].variables).toEqual({ id: draftGid("12") });
  });

  it("reads a completed draft's order, a missing total, and a deleted draft", async () => {
    const completed = stub(() => ({
      data: {
        draftOrder: {
          name: "#D12",
          status: "COMPLETED",
          ready: false,
          completedAt: "2026-10-04T00:00:00Z",
          order: { id: "gid://shopify/Order/77", legacyResourceId: "77", name: "#1077" },
        },
      },
    }));
    expect(await fetchDraftForApprove(DOMAIN, TOKEN, draftGid("12"), completed.impl)).toMatchObject({
      kind: "ok",
      draft: { status: "COMPLETED", ready: false, orderId: "77", orderName: "#1077", total: null },
    });
    const gone = stub(() => ({ data: { draftOrder: null } }));
    expect(await fetchDraftForApprove(DOMAIN, TOKEN, draftGid("12"), gone.impl)).toEqual({ kind: "ok", draft: null });
  });
});

describe("completeDraft", () => {
  it("sends exactly { id }, nothing about payment", async () => {
    const node = { id: draftGid("12"), status: "COMPLETED", order: { id: "gid://shopify/Order/5", name: "#1005" } };
    const { impl, calls } = stub(() => ({ data: { draftOrderComplete: { draftOrder: node, userErrors: [] } } }));
    expect(await completeDraft(DOMAIN, TOKEN, draftGid("12"), impl)).toEqual({ kind: "ok", node });
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ id: "gid://shopify/DraftOrder/12" });
    expect(calls[0].query).toContain("draftOrderComplete(id: $id)");
    expect(calls[0].query).not.toMatch(/paymentGatewayId|sourceName|paymentPending/);
  });

  it("returns Shopify's userErrors as refused, in its words", async () => {
    const { impl } = stub(() => ({
      data: {
        draftOrderComplete: {
          draftOrder: null,
          userErrors: [{ field: ["id"], message: "Draft order has not finished calculating" }],
        },
      },
    }));
    expect(await completeDraft(DOMAIN, TOKEN, draftGid("12"), impl)).toEqual({
      kind: "refused",
      detail: "Draft order has not finished calculating",
    });
  });

  it("reports a timeout as transient so the caller re-queries instead of retrying", async () => {
    const impl = (async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as typeof fetch;
    expect(await completeDraft(DOMAIN, TOKEN, draftGid("12"), impl)).toEqual({
      kind: "transient",
      detail: "Shopify request timed out",
    });
  });
});

// Draft orders are an optional feature (spec section 14): they sync only
// when the app was granted the draft scopes, and a write scope implies its
// read scope.
describe("draft scopes", () => {
  it("needs read and write draft orders, with write implying read", () => {
    expect(DRAFT_SCOPES).toEqual(["read_draft_orders", "write_draft_orders"]);
    expect(missingDraftScopes([])).toEqual(["read_draft_orders", "write_draft_orders"]);
    expect(missingDraftScopes(["read_draft_orders"])).toEqual(["write_draft_orders"]);
    expect(missingDraftScopes(["write_draft_orders"])).toEqual([]);
    expect(missingDraftScopes(["read_orders", "read_draft_orders", "write_draft_orders"])).toEqual([]);
    expect(draftsEnabled(["write_draft_orders", "read_orders"])).toBe(true);
    expect(draftsEnabled(["read_draft_orders", "write_orders"])).toBe(false);
    expect(draftsEnabled(null)).toBe(false);
    expect(draftsEnabled(undefined)).toBe(false);
  });
});

// Registration (spec section 7.2): Shopify refuses a draft subscription
// without the scope and replaceWebhookSubscriptions stops at the first
// refusal, so draft topics are only ever requested with the scope, and last.
describe("webhook topics", () => {
  it("adds the draft topics at the end only when drafts are enabled", () => {
    expect(BASE_WEBHOOK_TOPICS).toHaveLength(10);
    expect(DRAFT_WEBHOOK_TOPICS).toEqual(["DRAFT_ORDERS_CREATE", "DRAFT_ORDERS_UPDATE", "DRAFT_ORDERS_DELETE"]);
    expect(webhookTopicsFor(["read_orders", "write_orders"])).toEqual([...BASE_WEBHOOK_TOPICS]);
    expect(webhookTopicsFor(null)).toEqual([...BASE_WEBHOOK_TOPICS]);
    expect(webhookTopicsFor(["write_orders", "write_draft_orders"])).toEqual([
      ...BASE_WEBHOOK_TOPICS,
      ...DRAFT_WEBHOOK_TOPICS,
    ]);
  });

  it("creates exactly the topics it is given", async () => {
    const { impl, calls } = stub((call) => {
      if (call.query.includes("webhookSubscriptions(")) {
        return { data: { webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      return { data: { webhookSubscriptionCreate: { webhookSubscription: { id: "gid://shopify/WebhookSubscription/1" }, userErrors: [] } } };
    });
    const result = await replaceWebhookSubscriptions(DOMAIN, TOKEN, "https://orderingdesk.com/api/webhooks/shopify/ws", ["ORDERS_CREATE", "DRAFT_ORDERS_DELETE"], impl);
    expect(result).toEqual({ kind: "ok" });
    expect(calls.filter((call) => call.query.includes("webhookSubscriptionCreate")).map((call) => call.variables.topic)).toEqual([
      "ORDERS_CREATE",
      "DRAFT_ORDERS_DELETE",
    ]);
  });
});
