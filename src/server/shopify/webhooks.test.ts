import { describe, it, expect, vi, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { openTestDb, seedUser, seedWorkspace } from "@/server/desk/test-helpers";
import { claimAccessOnSignIn } from "@/server/invites";
import { approveRosterEntry } from "@/server/roster";
import type { LiveEvent } from "@/lib/live-events";
import { normalizeOrders } from "./normalize";
import { MAX_WEBHOOK_BODY_BYTES, receiveShopifyWebhook, verifyShopifyHmac } from "./webhooks";

// POST /api/webhooks/shopify/[workspaceId] (platform amendment section 4):
// verified with the workspace's client secret, matched to its shop,
// deduplicated, then applied after the 200. Stubbed fetch only.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const SECRET = "shpss_webhook_secret_value_6d6d";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const encoder = new TextEncoder();

afterEach(() => {
  vi.restoreAllMocks();
});

async function sign(body: Uint8Array<ArrayBuffer> | string, secret = SECRET): Promise<string> {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return btoa(String.fromCharCode(...mac));
}

function fakeEnv() {
  const sent: LiveEvent[] = [];
  // Kicks: users whose sockets the room was asked to close.
  const kicks: Array<{ room: string; userId: string }> = [];
  const env = {
    ENCRYPTION_KEY: KEY,
    APP_URL: "https://orderingdesk.com",
    ROOM: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        async fetch(url: string, init: RequestInit) {
          if (url.endsWith("/kick")) {
            kicks.push({ room: id.name, userId: (JSON.parse(String(init.body)) as { userId: string }).userId });
            return Response.json({ closed: 1 });
          }
          sent.push(JSON.parse(String(init.body)) as LiveEvent);
          return Response.json({ sent: 1 });
        },
      }),
    },
  } as unknown as CloudflareEnv;
  return { env, sent, kicks };
}

async function setup(overrides: Partial<typeof schema.storeConnections.$inferInsert> = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: "",
    authMode: "client_credentials",
    clientId: "client-id-1",
    encryptedClientSecret: await encryptSecret(SECRET, KEY, WS),
    encryptedAccessToken: await encryptSecret("shpat_webhook_access_token", KEY, WS),
    accessTokenExpiresAt: NOW + 3600000,
    ...overrides,
  });
  return db;
}

type Delivery = {
  topic: string;
  payload: unknown;
  webhookId?: string;
  shop?: string;
  hmac?: string | null;
  body?: Uint8Array<ArrayBuffer>;
};

async function deliver(db: Db, env: CloudflareEnv, delivery: Delivery, fetchImpl: typeof fetch = failingFetch) {
  const body = delivery.body ?? encoder.encode(JSON.stringify(delivery.payload));
  const headers = new Headers({
    "X-Shopify-Topic": delivery.topic,
    "X-Shopify-Shop-Domain": delivery.shop ?? SHOP,
    "X-Shopify-Webhook-Id": delivery.webhookId ?? "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
  });
  const hmac = delivery.hmac === undefined ? await sign(body) : delivery.hmac;
  if (hmac !== null) {
    headers.set("X-Shopify-Hmac-Sha256", hmac);
  }
  return receiveShopifyWebhook(db, env, { workspaceId: WS, rawBody: body, headers }, { fetchImpl, now: () => NOW });
}

const failingFetch = (async () => {
  throw new Error("no Shopify request expected");
}) as typeof fetch;

type Query = { query: string; variables: Record<string, unknown> };

const orderNode = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/8101",
  legacyResourceId: "8101",
  name: "#8101",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T11:59:00Z",
  email: "buyer@example.com",
  displayFulfillmentStatus: "UNFULFILLED",
  tags: [],
  fulfillments: [],
  lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  ...overrides,
});

// A store that answers the single-order query with `node`, the customer
// query with `customer`, and tag reads and writes.
function store(opts: { node?: unknown; customer?: unknown; tags?: string[] } = {}) {
  const calls: Query[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Query;
    calls.push(body);
    let data: unknown;
    if (body.query.includes("query OrderById")) {
      data = { order: opts.node ?? null };
    } else if (body.query.includes("query RosterCustomer(")) {
      data = { customer: opts.customer ?? null };
    } else if (body.query.includes("order(id: $id) { id tags }")) {
      data = { order: { id: "x", tags: opts.tags ?? [] } };
    } else if (body.query.includes("tagsAdd(")) {
      data = { tagsAdd: { userErrors: [] } };
    } else if (body.query.includes("tagsRemove(")) {
      data = { tagsRemove: { userErrors: [] } };
    } else {
      throw new Error("unexpected request: " + body.query);
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

async function deliveries(db: Db) {
  return db.select().from(schema.webhookDeliveries);
}

async function orderRows(db: Db) {
  return db.select().from(schema.orders).where(eq(schema.orders.workspaceId, WS));
}

describe("verifyShopifyHmac", () => {
  it("accepts the base64 HMAC-SHA256 of the exact raw bytes under the secret", async () => {
    const body = encoder.encode('{"id":1}');
    expect(await verifyShopifyHmac(body, SECRET, await sign(body))).toBe(true);
  });

  it("rejects a tampered body, another secret, and a missing or malformed header", async () => {
    const body = encoder.encode('{"id":1}');
    const good = await sign(body);
    expect(await verifyShopifyHmac(encoder.encode('{"id":2}'), SECRET, good)).toBe(false);
    expect(await verifyShopifyHmac(encoder.encode('{"id":1} '), SECRET, good)).toBe(false);
    expect(await verifyShopifyHmac(body, "shpss_other_secret", good)).toBe(false);
    expect(await verifyShopifyHmac(body, SECRET, null)).toBe(false);
    expect(await verifyShopifyHmac(body, SECRET, "")).toBe(false);
    expect(await verifyShopifyHmac(body, SECRET, "not base64 at all!")).toBe(false);
    expect(await verifyShopifyHmac(body, SECRET, good.slice(0, 20))).toBe(false);
    expect(await verifyShopifyHmac(body, SECRET, btoa("x".repeat(32)))).toBe(false);
  });
});

describe("receiveShopifyWebhook: verification", () => {
  const payload = { id: 8101, admin_graphql_api_id: "gid://shopify/Order/8101" };

  it("answers 200 at once for a verified delivery and leaves the work for after the response", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    const receipt = await deliver(db, env, { topic: "orders/updated", payload });
    expect(receipt.status).toBe(200);
    expect(typeof receipt.work).toBe("function");
    expect(await deliveries(db)).toEqual([
      { id: `${WS}:b54557e4-bdd9-4b37-8a5f-bf7d70bcd043`, workspaceId: WS, topic: "orders/updated", receivedAt: NOW },
    ]);
  });

  it("rejects a tampered body, a wrong secret and a missing signature with 401 and no work", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    const body = encoder.encode(JSON.stringify(payload));
    const cases: Delivery[] = [
      { topic: "orders/updated", payload, body: encoder.encode(JSON.stringify({ ...payload, id: 9 })), hmac: await sign(body) },
      { topic: "orders/updated", payload, hmac: await sign(body, "shpss_wrong_secret") },
      { topic: "orders/updated", payload, hmac: null },
      { topic: "orders/updated", payload, hmac: "garbage" },
    ];
    for (const delivery of cases) {
      const receipt = await deliver(db, env, delivery);
      expect(receipt).toEqual({ status: 401 });
    }
    expect(await deliveries(db)).toEqual([]);
  });

  it("rejects a delivery whose shop is not the workspace's store", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    expect(await deliver(db, env, { topic: "orders/updated", payload, shop: "someone-else.myshopify.com" })).toEqual({
      status: 401,
    });
    expect(await deliver(db, env, { topic: "orders/updated", payload, shop: "" })).toEqual({ status: 401 });
    // The header's case does not matter.
    expect((await deliver(db, env, { topic: "orders/updated", payload, shop: "Impact-Rentals.myshopify.com" })).status).toBe(200);
  });

  // A legacy token's app secret is unknown, so its deliveries cannot be
  // verified: the cron sync carries those stores.
  it("rejects deliveries for a legacy-token, disconnected or unknown workspace", async () => {
    const { env } = fakeEnv();
    const legacy = await setup({ authMode: "legacy_token", encryptedClientSecret: null, clientId: null });
    expect(await deliver(legacy, env, { topic: "orders/updated", payload })).toEqual({ status: 401 });
    const disabled = await setup({ status: "disabled" });
    expect(await deliver(disabled, env, { topic: "orders/updated", payload })).toEqual({ status: 401 });
    const { db: empty } = openTestDb();
    expect(await deliver(empty, env, { topic: "orders/updated", payload })).toEqual({ status: 401 });
  });

  it("applies each webhook id once", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    const first = await deliver(db, env, { topic: "orders/updated", payload, webhookId: "wh-1" });
    const again = await deliver(db, env, { topic: "orders/updated", payload, webhookId: "wh-1" });
    const other = await deliver(db, env, { topic: "orders/updated", payload, webhookId: "wh-2" });
    expect(first.work).toBeDefined();
    expect(again).toEqual({ status: 200 });
    expect(other.work).toBeDefined();
    expect(await deliveries(db)).toHaveLength(2);
  });

  it("answers 200 and does nothing for a topic it does not handle", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    expect(await deliver(db, env, { topic: "products/update", payload: { id: 1 } })).toEqual({ status: 200 });
    expect(await deliveries(db)).toEqual([]);
  });

  it("refuses an oversized body and a missing webhook id", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    const huge = new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1);
    expect(await deliver(db, env, { topic: "orders/updated", payload, body: huge })).toEqual({ status: 413 });
    expect(await deliver(db, env, { topic: "orders/updated", payload, webhookId: "" })).toEqual({ status: 400 });
  });
});

describe("receiveShopifyWebhook: orders", () => {
  it("re-fetches the order, stores it through the sync's write path and broadcasts it", async () => {
    const db = await setup();
    const { env, sent } = fakeEnv();
    const shop = store({ node: orderNode() });
    const receipt = await deliver(
      db,
      env,
      { topic: "orders/create", payload: { id: 8101, admin_graphql_api_id: "gid://shopify/Order/8101", email: "buyer@example.com" } },
      shop.impl,
    );
    await receipt.work?.();
    expect(shop.calls).toHaveLength(1);
    expect(shop.calls[0].query).toContain("query OrderById");
    expect(shop.calls[0].query).toContain("fulfillments(first: 3) { displayStatus }");
    expect(shop.calls[0].variables).toEqual({ id: "gid://shopify/Order/8101" });
    const rows = await orderRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ shopifyOrderId: "8101", name: "#8101", statusKey: "new", syncedAt: NOW });
    expect(rows[0].shopify).toEqual(normalizeOrders([orderNode()])[0]);
    expect(sent).toEqual([{ kind: "orders.synced", addedOrderIds: [rows[0].id], updatedOrderIds: [] }]);
  });

  // Phase 6: an order a webhook inserted goes through notifyNewOrders,
  // whose claim (notified_at) is what keeps a racing cron run from
  // announcing it again; a webhook about a known order claims nothing.
  it("hands the order it inserted to the new-order notifications, and only that one", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    const shop = store({ node: orderNode({ createdAt: "2026-10-02T11:30:00Z" }) });
    const created = await deliver(db, env, { topic: "orders/create", payload: { id: 8101 }, webhookId: "wh-create" }, shop.impl);
    await created.work?.();
    const [row] = await orderRows(db);
    expect(row.notifiedAt).toBe(NOW);

    await db.update(schema.orders).set({ notifiedAt: null }).where(eq(schema.orders.id, row.id));
    const updatedShop = store({ node: orderNode({ createdAt: "2026-10-02T11:30:00Z", note: "changed" }) });
    const updated = await deliver(db, env, { topic: "orders/updated", payload: { id: 8101 }, webhookId: "wh-update" }, updatedShop.impl);
    await updated.work?.();
    const [after] = await orderRows(db);
    expect(after.notifiedAt).toBeNull();
  });

  it("moves the status forward on a fulfillment webhook and writes the tag back", async () => {
    const db = await setup();
    const { env, sent } = fakeEnv();
    const [stored] = normalizeOrders([orderNode()]);
    await db.insert(schema.orders).values({
      id: "o1",
      workspaceId: WS,
      shopifyOrderId: "8101",
      name: "#8101",
      shopify: stored,
      statusKey: "approved",
      createdAt: 1,
      syncedAt: NOW - 60000,
    });
    const shop = store({
      node: orderNode({ displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "IN_TRANSIT" }] }),
      tags: ["Ordering Desk: Approved"],
    });
    const receipt = await deliver(db, env, { topic: "fulfillments/create", payload: { id: 55, order_id: 8101 } }, shop.impl);
    await receipt.work?.();
    expect(shop.calls[0].variables).toEqual({ id: "gid://shopify/Order/8101" });
    const [row] = await orderRows(db);
    expect(row).toMatchObject({ statusKey: "shipped", statusSetBy: null });
    expect(sent.map((event) => event.kind)).toEqual(["orders.synced", "order.status", "order.activity"]);
    // The move came from Shopify: tag only, no fulfillment request.
    expect(shop.calls.slice(1).map((call) => call.variables)).toEqual([
      { id: "gid://shopify/Order/8101" },
      { id: "gid://shopify/Order/8101", tags: ["Ordering Desk: Approved"] },
      { id: "gid://shopify/Order/8101", tags: ["Ordering Desk: Shipped"] },
    ]);
  });

  // The app moved the order to Shipped and wrote its tag and fulfillment;
  // the webhooks that follow must change nothing.
  it("treats the echo of the app's own write as no change", async () => {
    const db = await setup();
    const { env, sent } = fakeEnv();
    const [stored] = normalizeOrders([orderNode({ tags: ["Ordering Desk: Approved"] })]);
    await db.insert(schema.orders).values({
      id: "o1",
      workspaceId: WS,
      shopifyOrderId: "8101",
      name: "#8101",
      shopify: stored,
      statusKey: "shipped",
      statusSetBy: "user_1",
      statusSetAt: NOW - 5000,
      createdAt: 1,
      syncedAt: NOW - 60000,
    });
    const echoed = orderNode({
      tags: ["Ordering Desk: Shipped"],
      displayFulfillmentStatus: "FULFILLED",
      fulfillments: [{ displayStatus: "FULFILLED" }],
    });
    for (const [topic, webhookId] of [
      ["orders/updated", "wh-a"],
      ["orders/fulfilled", "wh-b"],
      ["fulfillments/create", "wh-c"],
    ]) {
      const shop = store({ node: echoed });
      const receipt = await deliver(
        db,
        env,
        { topic, webhookId, payload: topic.startsWith("orders") ? { id: 8101 } : { order_id: 8101 } },
        shop.impl,
      );
      await receipt.work?.();
      // One re-fetch each, and no write to Shopify.
      expect(shop.calls.map((call) => call.query.includes("query OrderById"))).toEqual([true]);
    }
    const [row] = await orderRows(db);
    expect(row).toMatchObject({ statusKey: "shipped", statusSetBy: "user_1" });
    const events = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.workspaceId, WS), eq(schema.events.orderId, "o1")));
    expect(events).toEqual([]);
    // The first delivery refreshed the snapshot; the rest found it current.
    expect(sent).toEqual([{ kind: "orders.synced", addedOrderIds: [], updatedOrderIds: ["o1"] }]);
  });

  it("does nothing when Shopify no longer has the order or the payload names none", async () => {
    const db = await setup();
    const { env, sent } = fakeEnv();
    const shop = store({ node: null });
    await (await deliver(db, env, { topic: "orders/cancelled", payload: { id: 8101 } }, shop.impl)).work?.();
    expect(await orderRows(db)).toEqual([]);
    const garbage = await deliver(db, env, { topic: "orders/updated", payload: { nope: true }, webhookId: "wh-x" });
    expect(garbage).toEqual({ status: 200 });
    expect(sent).toEqual([]);
  });

  it("writes nothing when the store was disconnected before the order arrived", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    const shop = store({ node: orderNode() });
    const receipt = await deliver(db, env, { topic: "orders/create", payload: { id: 8101 } }, shop.impl);
    await db
      .update(schema.storeConnections)
      .set({ status: "disabled" })
      .where(eq(schema.storeConnections.workspaceId, WS));
    await receipt.work?.();
    expect(await orderRows(db)).toEqual([]);
  });

  it("never logs the payload when the work fails", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    const logged: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    const exploding = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const receipt = await deliver(
      db,
      env,
      { topic: "orders/create", payload: { id: 8101, email: "secret.buyer@example.com", note: "gate code 4412" } },
      exploding,
    );
    await expect(receipt.work?.()).resolves.toBeUndefined();
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain("secret.buyer@example.com");
      expect(line).not.toContain("4412");
    }
  });
});

describe("receiveShopifyWebhook: customers", () => {
  async function rosterEmails(db: Db) {
    const rows = await db.select().from(schema.shopifyRoster).where(eq(schema.shopifyRoster.workspaceId, WS));
    return rows.map((row) => [row.email, row.role]);
  }

  async function approveAll(db: Db) {
    for (const row of await db.select().from(schema.shopifyRoster).where(eq(schema.shopifyRoster.workspaceId, WS))) {
      await approveRosterEntry(db, { workspaceId: WS, rosterId: row.id, approverId: "u_manager" }, {});
    }
  }

  // A tag only asks for access (storefront forms can set tags): the request
  // waits for a manager, and an approved one follows later tag changes.
  it("re-fetches the customer and records the request, granting nothing until it is approved", async () => {
    const db = await setup();
    const { env } = fakeEnv();
    await seedUser(db, "u_jo", "jo@impact.example");
    const shop = store({
      customer: { id: "gid://shopify/Customer/501", email: "Jo@Impact.example", tags: ["Ordering Desk Manager"] },
    });
    const receipt = await deliver(
      db,
      env,
      { topic: "customers/update", payload: { id: 501, admin_graphql_api_id: "gid://shopify/Customer/501" } },
      shop.impl,
    );
    await receipt.work?.();
    expect(shop.calls[0].variables).toEqual({ id: "gid://shopify/Customer/501" });
    expect(await rosterEmails(db)).toEqual([["jo@impact.example", "manager"]]);
    expect(await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, "u_jo"))).toEqual([]);

    // Approving adds nobody: Jo joins at the next sign-in or "/" load.
    await approveAll(db);
    expect(await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, "u_jo"))).toEqual([]);
    await claimAccessOnSignIn(db, "u_jo", "jo@impact.example");
    const members = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, "u_jo"));
    expect(members).toMatchObject([{ workspaceId: WS, role: "manager", source: "shopify" }]);

    // Lowered to staff in Shopify: applied at once.
    const lowered = store({
      customer: { id: "gid://shopify/Customer/501", email: "jo@impact.example", tags: ["Ordering Desk Staff"] },
    });
    await (
      await deliver(db, env, { topic: "customers/update", payload: { id: 501 }, webhookId: "c-lower" }, lowered.impl)
    ).work?.();
    expect(await db.select({ role: schema.workspaceMembers.role }).from(schema.workspaceMembers)).toEqual([{ role: "staff" }]);
  });

  it("removes the access of a deleted customer without asking Shopify, closing their open sockets", async () => {
    const db = await setup();
    const { env, kicks } = fakeEnv();
    await seedUser(db, "u_jo", "jo@impact.example");
    const shop = store({ customer: { id: "gid://shopify/Customer/501", email: "jo@impact.example", tags: ["Ordering Desk Staff"] } });
    await (await deliver(db, env, { topic: "customers/create", payload: { id: 501 }, webhookId: "c1" }, shop.impl)).work?.();
    expect(await rosterEmails(db)).toHaveLength(1);
    await approveAll(db);
    await claimAccessOnSignIn(db, "u_jo", "jo@impact.example");
    expect(kicks).toEqual([]);
    await (await deliver(db, env, { topic: "customers/delete", payload: { id: 501 }, webhookId: "c2" })).work?.();
    expect(kicks).toEqual([{ room: WS, userId: "u_jo" }]);
    expect(await rosterEmails(db)).toEqual([]);
    expect(await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, "u_jo"))).toEqual([]);
  });
});
