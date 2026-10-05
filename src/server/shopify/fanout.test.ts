import { describe, it, expect, vi } from "vitest";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { openTestDb, seedOrder, seedWorkspace } from "@/server/desk/test-helpers";
import type { LiveEvent } from "@/lib/live-events";
import type { StatusChange } from "./status-sync";

// The activity push is notify.ts's (tested there); here only that a move
// from Shopify reaches it.
vi.mock("../notify", () => ({ notifyActivity: vi.fn(async () => ({ pushed: 0 })) }));
const { notifyActivity } = await import("../notify");
const { pushAndShare, shareShopifyMoves } = await import("./fanout");

// After a status change: open desks hear about it, the status goes to
// Shopify, and the outcome reaches open drawers. Stubbed store and room.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function fakeEnv() {
  const sent: LiveEvent[] = [];
  const env = {
    ENCRYPTION_KEY: KEY,
    ROOM: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        async fetch(_url: string, init: RequestInit) {
          sent.push(JSON.parse(String(init.body)) as LiveEvent);
          return Response.json({ sent: 1 });
        },
      }),
    },
  } as unknown as CloudflareEnv;
  return { env, sent };
}

type Query = { query: string; variables: Record<string, unknown> };

function store(tags: string[]) {
  const calls: Query[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Query;
    calls.push(body);
    let data: unknown;
    if (body.query.includes("tagsAdd(")) {
      data = { tagsAdd: { userErrors: [] } };
    } else if (body.query.includes("tagsRemove(")) {
      data = { tagsRemove: { userErrors: [] } };
    } else if (body.query.includes("fulfillmentOrders(")) {
      data = { order: { id: "x", fulfillmentOrders: { nodes: [] } } };
    } else {
      data = { node: { id: "x", tags } };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: await encryptSecret("shpat_fanout_token", KEY, WS),
  });
  return db;
}

describe("shareShopifyMoves", () => {
  it("broadcasts each move, then writes its tag to Shopify (never fulfilling) and shares the outcome", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const { env, sent } = fakeEnv();
    const shop = store(["Ordering Desk: Processing"]);
    const change: StatusChange = {
      event: {
        id: "e1",
        orderId: "o1",
        type: "status",
        text: "Status set to Shipped: Shopify reports the order fulfilled",
        actorId: null,
        meta: { from: "processing", to: "shipped", reason: "fulfilled" },
        createdAt: NOW,
        source: "shopify",
      },
      order: { id: "o1", statusKey: "shipped", statusSetBy: null, statusSetAt: NOW },
    };
    await shareShopifyMoves(db, env, WS, [change], { fetchImpl: shop.impl, now: () => NOW });
    expect(sent.map((event) => event.kind)).toEqual(["order.status", "order.activity"]);
    expect(sent[0]).toEqual({ kind: "order.status", event: change.event, order: change.order });
    expect(sent[1]).toMatchObject({ event: { type: "shopify_write", text: "Shopify updated: tagged Ordering Desk: Shipped" } });
    // Shopify already fulfilled the order: no fulfillment request.
    expect(shop.calls.some((call) => call.query.includes("fulfillment"))).toBe(false);
    // Members who opted into all activity hear about the move.
    expect(vi.mocked(notifyActivity).mock.calls.map((call) => [call[2], call[3]])).toEqual([[WS, change.event]]);
  });
});

describe("pushAndShare", () => {
  it("pushes an app change with fulfilling and shares each outcome", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const { env, sent } = fakeEnv();
    const shop = store([]);
    await pushAndShare(db, env, WS, "o1", { fetchImpl: shop.impl, now: () => NOW });
    expect(shop.calls.some((call) => call.query.includes("fulfillmentOrders("))).toBe(true);
    expect(sent.map((event) => event.kind)).toEqual(["order.activity"]);
  });

  it("shares nothing when Shopify already shows the status", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
    const { env, sent } = fakeEnv();
    await pushAndShare(db, env, WS, "o1", { fetchImpl: store(["Ordering Desk: Approved"]).impl, now: () => NOW });
    expect(sent).toEqual([]);
  });
});
