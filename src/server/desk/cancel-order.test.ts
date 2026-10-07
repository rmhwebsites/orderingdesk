import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { NOTE_MAX } from "@/lib/limits";
import { CANCEL_COPY, cancelOrder, followCancellation } from "./cancel-order";
import { REVIEW_READY_TRIES, type ReviewDeps } from "./review";
import { openTestDb, seedCancelledStatus, seedDraft, seedWorkspace, snapshotOf } from "./test-helpers";

// Cancel after approval (comprehensive design section 2) against the real
// migrations and a stubbed Shopify. orderCancel never reaches a real store.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_cancel_token_never_leak";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-06T15:00:00.000Z");
const MANAGER = "u_manager";
const ORDER_ID = "9001";
const ORDER_GID = `gid://shopify/Order/${ORDER_ID}`;

type Call = { op: string; variables: Record<string, unknown> };
type ShopOrder = { exists: boolean; cancelledAt: string | null; total: string; fulfillment: string; tags: string[] };

// One order. An accepted CancelOrder starts Shopify's job; the confirmAt-th
// state read after it sees the order cancelled (1: the first read does).
// handle answers an operation another way.
function fakeShop(
  initial: Partial<ShopOrder> = {},
  opts: { confirmAt?: number; handle?: Partial<Record<string, (call: Call) => Response | Promise<Response>>> } = {},
) {
  const state = { exists: true, cancelledAt: null as string | null, total: "0.0", fulfillment: "UNFULFILLED", tags: [] as string[], pending: false, reads: 0, ...initial };
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "unknown";
    const call = { op, variables: body.variables };
    calls.push(call);
    const custom = opts.handle?.[op];
    if (custom) {
      return custom(call);
    }
    switch (op) {
      case "OrderCancelState":
        if (state.pending) {
          state.reads += 1;
          if (state.reads >= (opts.confirmAt ?? 1)) {
            state.cancelledAt = "2026-10-06T15:00:01Z";
            state.pending = false;
          }
        }
        return Response.json({
          data: {
            order: state.exists
              ? {
                  id: ORDER_GID,
                  name: "#1234",
                  cancelledAt: state.cancelledAt,
                  displayFulfillmentStatus: state.fulfillment,
                  currentTotalPriceSet: { shopMoney: { amount: state.total, currencyCode: "USD" } },
                }
              : null,
          },
        });
      case "CancelOrder":
        state.pending = true;
        return Response.json({ data: { orderCancel: { job: { id: "gid://shopify/Job/1", done: false }, orderCancelUserErrors: [] } } });
      case "OrderById":
        return Response.json({
          data: {
            order: {
              id: ORDER_GID,
              legacyResourceId: ORDER_ID,
              name: "#1234",
              createdAt: "2026-10-05T10:00:00Z",
              cancelledAt: state.cancelledAt,
              tags: state.tags,
              displayFulfillmentStatus: state.fulfillment,
              lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        });
      case "StatusTags":
        return Response.json({ data: { node: { id: call.variables.id, tags: state.tags } } });
      case "StatusTagAdd":
        state.tags = [...state.tags, ...(call.variables.tags as string[])];
        return Response.json({ data: { tagsAdd: { userErrors: [] } } });
      case "StatusTagRemove":
        state.tags = state.tags.filter((tag) => !(call.variables.tags as string[]).includes(tag));
        return Response.json({ data: { tagsRemove: { userErrors: [] } } });
      default:
        throw new Error("unexpected Shopify request: " + op);
    }
  }) as typeof fetch;
  return { impl, calls, state, ops: () => calls.map((call) => call.op) };
}

async function setup(opts: { cancelledStatus?: boolean; statusKey?: string } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  if (opts.cancelledStatus !== false) {
    await seedCancelledStatus(db, WS);
  }
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes: ["read_orders", "write_orders", "read_customers"],
  });
  await db.insert(schema.orders).values({
    id: "o1",
    workspaceId: WS,
    shopifyOrderId: ORDER_ID,
    name: "#1234",
    shopify: snapshotOf({ shopifyOrderId: ORDER_ID, name: "#1234", total: "0.00" }),
    statusKey: opts.statusKey ?? "approved",
    createdAt: 1000,
    syncedAt: 2000,
  });
  return db;
}

const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const deps = (impl: typeof fetch): ReviewDeps => ({ env, fetchImpl: impl, now: () => NOW, sleep: async () => undefined });
const ctx = (role: "manager" | "staff" | "platform" = "manager", orderId = "o1") => ({ workspaceId: WS, orderId, userId: MANAGER, role });

async function card(db: Db) {
  return (await db.select().from(schema.orders).where(eq(schema.orders.id, "o1")))[0];
}

function timeline(db: Db) {
  return db.select().from(schema.events).where(eq(schema.events.orderId, "o1"));
}

const timeout = (): Response => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

describe("cancelOrder", () => {
  it("needs a reason, a manager, an order and a cancelled status, asking Shopify nothing otherwise", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await cancelOrder(db, ctx(), { reason: "  " }, deps(shop.impl))).toEqual({ kind: "invalid", error: CANCEL_COPY.reason });
    expect(await cancelOrder(db, ctx(), { reason: "x".repeat(NOTE_MAX + 1) }, deps(shop.impl))).toEqual({ kind: "invalid", error: CANCEL_COPY.reason });
    expect(await cancelOrder(db, ctx("staff"), { reason: "Duplicate" }, deps(shop.impl))).toEqual({ kind: "forbidden", error: CANCEL_COPY.forbidden });
    expect(await cancelOrder(db, ctx("manager", "nope"), { reason: "Duplicate" }, deps(shop.impl))).toEqual({ kind: "not-found" });
    await seedDraft(db, WS, { id: "d1" });
    expect(await cancelOrder(db, ctx("manager", "d1"), { reason: "Duplicate" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: CANCEL_COPY.draft,
    });
    const bare = await setup({ cancelledStatus: false });
    expect(await cancelOrder(bare, ctx(), { reason: "Duplicate" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: CANCEL_COPY.noStatus,
    });
    const done = await setup({ statusKey: "cancelled" });
    expect(await cancelOrder(done, ctx(), { reason: "Duplicate" }, deps(shop.impl))).toEqual({ kind: "already-cancelled" });
    expect(shop.calls).toEqual([]);
  });

  it("cancels once with no email, restock or refund, and records the move, the reason and the cancellation", async () => {
    const db = await setup();
    const shop = fakeShop();
    const result = await cancelOrder(db, ctx(), { reason: " Duplicate order " }, deps(shop.impl));
    expect(result).toMatchObject({
      kind: "cancelled",
      confirmed: true,
      order: { id: "o1", statusKey: "cancelled", statusSetBy: MANAGER, statusSetAt: NOW },
    });
    expect(shop.ops()).toEqual(["OrderCancelState", "CancelOrder", "OrderCancelState"]);
    expect(shop.calls[1].variables).toEqual({
      orderId: ORDER_GID,
      reason: "OTHER",
      restock: false,
      notifyCustomer: false,
      staffNote: "Ordering Desk: Duplicate order",
    });
    expect(await card(db)).toMatchObject({ statusKey: "cancelled", statusSetBy: MANAGER, statusSetAt: NOW });
    const entries = await timeline(db);
    expect(entries.map((event) => [event.type, event.text, event.actorId, event.source]).sort()).toEqual([
      ["note", "Duplicate order", MANAGER, "app"],
      ["order_cancelled", "Shopify cancelled the order: no email to the customer, no restock, no refund.", MANAGER, "app"],
      ["status", "Cancelled the order in Shopify. Status set to Cancelled", MANAGER, "app"],
    ]);
    expect(entries.find((event) => event.type === "status")?.meta).toEqual({ from: "approved", to: "cancelled", action: "cancel" });
    expect(entries.find((event) => event.type === "note")?.meta).toEqual({ cancelReason: true });
    expect(entries.find((event) => event.type === "order_cancelled")?.meta).toEqual({ confirmed: true, jobId: "gid://shopify/Job/1" });
  });

  it("still moves the card when Shopify has not finished its job, and says so", async () => {
    const db = await setup();
    const shop = fakeShop({}, { confirmAt: 99 });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toMatchObject({ kind: "cancelled", confirmed: false });
    expect(shop.ops().filter((op) => op === "CancelOrder")).toHaveLength(1);
    expect(shop.ops().filter((op) => op === "OrderCancelState")).toHaveLength(1 + REVIEW_READY_TRIES);
    expect((await timeline(db)).find((event) => event.type === "order_cancelled")?.text).toBe(
      "Shopify accepted the cancellation and is finishing it: no email to the customer, no restock, no refund.",
    );
  });

  it("refuses an order that does not total $0.00, sending nothing", async () => {
    const db = await setup();
    const shop = fakeShop({ total: "12.00" });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "This order totals $12.00. Ordering Desk only cancels orders that total $0.00, because it never refunds. Cancel it in Shopify instead.",
    });
    expect(shop.ops()).toEqual(["OrderCancelState"]);
    expect((await card(db)).statusKey).toBe("approved");
  });

  it("follows an order already cancelled in Shopify without sending anything", async () => {
    const db = await setup();
    const shop = fakeShop({ cancelledAt: "2026-10-06T14:00:00Z" });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toMatchObject({
      kind: "cancelled-in-shopify",
      message: "Order #1234 was already cancelled in Shopify. The card is now Cancelled.",
    });
    expect(shop.ops()).toEqual(["OrderCancelState"]);
    expect(await card(db)).toMatchObject({ statusKey: "cancelled", statusSetBy: null });
    expect((await timeline(db)).map((event) => event.text)).toEqual(["Cancelled in Shopify. Status set to Cancelled"]);
  });

  it("changes nothing when Shopify refuses, and says why in plain words", async () => {
    const refusal = (message: string) => () =>
      Response.json({ data: { orderCancel: { job: null, orderCancelUserErrors: [{ field: ["orderId"], message, code: "INVALID" }] } } });
    const db = await setup();
    const shop = fakeShop({}, { handle: { CancelOrder: refusal("Cannot cancel this order.") } });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify did not cancel the order (Shopify said: Cannot cancel this order). Nothing changed.",
    });
    const fulfilled = fakeShop({ fulfillment: "FULFILLED" }, { handle: { CancelOrder: refusal("Fulfillments must be cancelled first.") } });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(fulfilled.impl))).toEqual({
      kind: "refused",
      status: 409,
      error:
        "Shopify did not cancel this order because items on it are already fulfilled (Shopify said: Fulfillments must be cancelled first). Nothing changed.",
    });
    expect((await card(db)).statusKey).toBe("approved");
    expect(await timeline(db)).toEqual([]);
  });

  it("reads after a timeout and never sends the cancel twice", async () => {
    const db = await setup();
    const landed = fakeShop(
      {},
      {
        handle: {
          CancelOrder: () => {
            landed.state.cancelledAt = "2026-10-06T15:00:01Z";
            return timeout();
          },
        },
      },
    );
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(landed.impl))).toMatchObject({ kind: "cancelled", confirmed: true });
    expect(landed.ops()).toEqual(["OrderCancelState", "CancelOrder", "OrderCancelState"]);

    const other = await setup();
    const lost = fakeShop({}, { handle: { CancelOrder: timeout } });
    expect(await cancelOrder(other, ctx(), { reason: "Duplicate order" }, deps(lost.impl))).toEqual({
      kind: "refused",
      status: 502,
      error: CANCEL_COPY.notConfirmed,
    });
    expect(lost.ops()).toEqual(["OrderCancelState", "CancelOrder", "OrderCancelState"]);
    expect((await card(other)).statusKey).toBe("approved");
  });

  it("refuses an order Shopify no longer has", async () => {
    const db = await setup();
    const shop = fakeShop({ exists: false });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: CANCEL_COPY.gone,
    });
  });
});

describe("followCancellation", () => {
  it("writes Shopify's cancelled order onto the card and tags it Cancelled", async () => {
    const db = await setup();
    const shop = fakeShop();
    const result = await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl));
    if (result.kind !== "cancelled") {
      throw new Error("expected a cancel");
    }
    await followCancellation(db, env, WS, "o1", result, { fetchImpl: shop.impl, now: () => NOW + 1000 });
    const snapshot = (await card(db)).shopify as Record<string, unknown>;
    expect(snapshot.cancelledAt).toBe(Date.parse("2026-10-06T15:00:01Z"));
    expect(shop.state.tags).toEqual(["Ordering Desk: Cancelled"]);
    expect((await card(db)).statusKey).toBe("cancelled");
  });
});
