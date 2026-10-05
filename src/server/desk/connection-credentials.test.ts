import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { saveConnection } from "./connection";
import { openTestDb, seedOrder, seedWorkspace } from "./test-helpers";

// Connecting a store with a Dev Dashboard app's Client ID and secret
// (platform amendment section 3), and registering its webhooks (section 4).
// Stubbed fetch only.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const CLIENT_ID = "4f1e0c2b9d8a7e6f";
const CLIENT_SECRET = "shpss_connect_secret_value_31aa";
const MINTED = "shpat_connect_minted_token_42bb";
const APP_URL = "https://orderingdesk.com";
const CALLBACK = "https://orderingdesk.com/api/webhooks/shopify/ws_impact";

const FULL_SCOPES = [
  "read_orders",
  "write_orders",
  "read_customers",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
];

const TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "CUSTOMERS_DELETE",
];

type Call = { url: string; init: RequestInit; query: string; variables: Record<string, unknown> };

type ShopScript = {
  mintStatus?: number;
  mintBody?: unknown;
  scopes?: string[];
  existingWebhooks?: Array<{ id: string; topic: string; uri: string }>;
  createUserErrors?: Array<{ field: string[]; message: string }>;
};

// A stand-in store: the token endpoint, the verification query, and the
// webhook subscription list, delete and create operations.
function shop(script: ShopScript = {}) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/admin/oauth/access_token")) {
      calls.push({ url, init: init ?? {}, query: "", variables: {} });
      return new Response(
        JSON.stringify(
          script.mintBody ?? { access_token: MINTED, scope: FULL_SCOPES.join(","), expires_in: 86399 },
        ),
        { status: script.mintStatus ?? 200 },
      );
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };
    calls.push({ url, init: init ?? {}, query: body.query, variables: body.variables ?? {} });
    let data: unknown;
    if (body.query.includes("currentAppInstallation")) {
      data = {
        shop: { name: "IMPACT Rentals" },
        currentAppInstallation: { accessScopes: (script.scopes ?? FULL_SCOPES).map((handle) => ({ handle })) },
      };
    } else if (body.query.includes("webhookSubscriptions(")) {
      data = {
        webhookSubscriptions: {
          nodes: script.existingWebhooks ?? [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    } else if (body.query.includes("webhookSubscriptionDelete")) {
      data = { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: body.variables?.id, userErrors: [] } };
    } else if (body.query.includes("webhookSubscriptionCreate")) {
      data = {
        webhookSubscriptionCreate: {
          webhookSubscription: script.createUserErrors ? null : { id: "gid://shopify/WebhookSubscription/9" },
          userErrors: script.createUserErrors ?? [],
        },
      };
    } else {
      throw new Error("unexpected request: " + body.query);
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const ctx = (fetchImpl: typeof fetch) => ({
  workspaceId: WS,
  encryptionKey: KEY,
  appUrl: APP_URL,
  fetchImpl,
  now: () => NOW,
});

const credentials = { shopDomain: "impactrentals", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  return db;
}

async function connectionRow(db: Db) {
  const rows = await db
    .select()
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, WS));
  return rows[0];
}

function graphqlCalls(calls: Call[]) {
  return calls.filter((call) => call.url.endsWith("/graphql.json"));
}

describe("saveConnection with client credentials", () => {
  it("mints a token, verifies it, stores everything encrypted and registers the webhooks", async () => {
    const db = await setup();
    const store = shop();
    const result = await saveConnection(db, ctx(store.impl), {
      ...credentials,
      clientSecret: `  ${CLIENT_SECRET} `,
    });
    expect(result).toEqual({
      kind: "saved",
      connection: {
        shopDomain: "impactrentals.myshopify.com",
        status: "ok",
        lastSyncAt: 0,
        lastError: null,
        shopName: "IMPACT Rentals",
        authMode: "client_credentials",
        webhooksRegisteredAt: NOW,
      },
    });

    // The token request carried the trimmed credentials, and the
    // verification ran with the minted token.
    expect(new URL(store.calls[0].url).pathname).toBe("/admin/oauth/access_token");
    const form = new URLSearchParams(String(store.calls[0].init.body));
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect((store.calls[1].init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(MINTED);
    expect(store.calls[1].query).toContain("currentAppInstallation");

    const row = await connectionRow(db);
    expect(row).toMatchObject({
      shopDomain: "impactrentals.myshopify.com",
      authMode: "client_credentials",
      clientId: CLIENT_ID,
      encryptedToken: "",
      accessTokenExpiresAt: NOW + 86399 * 1000,
      scopes: FULL_SCOPES,
      shopName: "IMPACT Rentals",
      webhooksRegisteredAt: NOW,
      status: "ok",
      lastError: null,
      lastSyncAt: 0,
      runningUntil: 0,
    });
    expect(row.encryptedClientSecret).not.toContain(CLIENT_SECRET);
    expect(await decryptSecret(row.encryptedClientSecret!, KEY, WS)).toBe(CLIENT_SECRET);
    expect(await decryptSecret(row.encryptedAccessToken!, KEY, WS)).toBe(MINTED);
    await expect(decryptSecret(row.encryptedClientSecret!, KEY, "ws_other")).rejects.toThrow();

    const serialized = JSON.stringify(result);
    for (const secret of [CLIENT_SECRET, MINTED, row.encryptedClientSecret!, row.encryptedAccessToken!]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("creates one subscription per topic, pointing at this workspace's callback", async () => {
    const db = await setup();
    const store = shop();
    await saveConnection(db, ctx(store.impl), credentials);
    const creates = graphqlCalls(store.calls).filter((call) => call.query.includes("webhookSubscriptionCreate"));
    expect(creates.map((call) => call.variables)).toEqual(
      TOPICS.map((topic) => ({ topic, webhookSubscription: { uri: CALLBACK, format: "JSON" } })),
    );
    for (const call of creates) {
      expect((call.init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(MINTED);
    }
  });

  // Draft orders (spec section 7.2): the draft topics only with the draft
  // scopes, after every other topic.
  it("registers the draft order topics last, only when the app holds the draft scopes", async () => {
    const db = await setup();
    const store = shop({ scopes: [...FULL_SCOPES, "write_draft_orders"] });
    await saveConnection(db, ctx(store.impl), credentials);
    const creates = graphqlCalls(store.calls).filter((call) => call.query.includes("webhookSubscriptionCreate"));
    expect(creates.map((call) => call.variables.topic)).toEqual([
      ...TOPICS,
      "DRAFT_ORDERS_CREATE",
      "DRAFT_ORDERS_UPDATE",
      "DRAFT_ORDERS_DELETE",
    ]);
  });

  it("starts the draft sync over for another store and keeps it for the same one", async () => {
    const db = await setup();
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impactrentals.myshopify.com",
      encryptedToken: "v1.x",
      draftLastSyncAt: 500,
      draftCheckedAt: 600,
      draftSyncCursor: "400|c:8",
      draftSyncCursorSince: 300,
    });
    await saveConnection(db, ctx(shop().impl), credentials);
    expect(await connectionRow(db)).toMatchObject({
      draftLastSyncAt: 500,
      draftCheckedAt: 600,
      draftSyncCursor: "400|c:8",
      draftSyncCursorSince: 300,
    });
    // No orders yet, so another store may replace it, and starts over.
    await saveConnection(db, ctx(shop().impl), { ...credentials, shopDomain: "another-store" });
    expect(await connectionRow(db)).toMatchObject({
      shopDomain: "another-store.myshopify.com",
      draftLastSyncAt: 0,
      draftCheckedAt: 0,
      draftSyncCursor: null,
      draftSyncCursorSince: null,
    });
  });

  // On reconnect the old subscriptions for this callback are replaced; a
  // subscription for any other address is not this workspace's to touch.
  it("replaces this workspace's existing subscriptions on reconnect", async () => {
    const db = await setup();
    const store = shop({
      existingWebhooks: [
        { id: "gid://shopify/WebhookSubscription/1", topic: "ORDERS_CREATE", uri: CALLBACK },
        { id: "gid://shopify/WebhookSubscription/2", topic: "ORDERS_CREATE", uri: "https://elsewhere.example/hook" },
        { id: "gid://shopify/WebhookSubscription/3", topic: "CUSTOMERS_UPDATE", uri: CALLBACK },
      ],
    });
    await saveConnection(db, ctx(store.impl), credentials);
    const graphql = graphqlCalls(store.calls).slice(1);
    expect(graphql[0].query).toContain("webhookSubscriptions(");
    expect(graphql.slice(1, 3).map((call) => [call.query.includes("webhookSubscriptionDelete"), call.variables])).toEqual([
      [true, { id: "gid://shopify/WebhookSubscription/1" }],
      [true, { id: "gid://shopify/WebhookSubscription/3" }],
    ]);
    expect(graphql.slice(3).every((call) => call.query.includes("webhookSubscriptionCreate"))).toBe(true);
    expect(graphql.slice(3)).toHaveLength(TOPICS.length);
  });

  it("keeps the saved connection but reports it when Shopify refuses the webhooks", async () => {
    const db = await setup();
    const store = shop({ createUserErrors: [{ field: ["webhookSubscription", "uri"], message: "Address is invalid" }] });
    const result = await saveConnection(db, ctx(store.impl), credentials);
    expect(result).toMatchObject({
      kind: "saved",
      connection: { authMode: "client_credentials", webhooksRegisteredAt: null },
      warning:
        "Connected, but Shopify did not accept the webhooks (Address is invalid). Orders still sync every 10 minutes; connect again to retry live updates.",
    });
    expect(await connectionRow(db)).toMatchObject({ status: "ok", webhooksRegisteredAt: null, authMode: "client_credentials" });
  });

  it("names every missing permission and saves nothing", async () => {
    const db = await setup();
    const store = shop({ scopes: ["read_orders", "read_customers"] });
    const result = await saveConnection(db, ctx(store.impl), credentials);
    expect(result).toEqual({
      kind: "rejected",
      error:
        "The Shopify app is missing these permissions: write_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders. Add them to the app's access scopes, approve the new version on the store, and connect again.",
    });
    expect(await connectionRow(db)).toBeUndefined();
    expect(graphqlCalls(store.calls).some((call) => call.query.includes("webhookSubscription"))).toBe(false);
  });

  it("answers a refused Client ID and secret with Shopify's reason, and saves nothing", async () => {
    const db = await setup();
    const store = shop({
      mintStatus: 400,
      mintBody: { error: "shop_not_permitted", error_description: "Client credentials cannot be performed on this shop." },
    });
    const result = await saveConnection(db, ctx(store.impl), credentials);
    expect(result).toEqual({
      kind: "rejected",
      error:
        "Shopify rejected this Client ID and secret (shop_not_permitted: Client credentials cannot be performed on this shop.). Check them in the Dev Dashboard and make sure the app is installed on this store.",
    });
    expect(store.calls).toHaveLength(1);
    expect(await connectionRow(db)).toBeUndefined();
  });

  it("keeps the no store, unreachable and one-store answers of the token mode", async () => {
    const db = await setup();
    expect(await saveConnection(db, ctx(shop({ mintStatus: 404, mintBody: {} }).impl), credentials)).toEqual({
      kind: "invalid",
      error: "No Shopify store at this address",
    });
    const down = await saveConnection(db, ctx(shop({ mintStatus: 503, mintBody: {} }).impl), credentials);
    expect(down).toEqual({ kind: "unreachable", error: "Could not verify the connection: Shopify responded with HTTP 503" });
    expect(await connectionRow(db)).toBeUndefined();

    // A workspace with orders from one store refuses another, before any
    // request.
    await saveConnection(db, ctx(shop().impl), credentials);
    await seedOrder(db, WS, { id: "o1" });
    const before = await connectionRow(db);
    const other = shop();
    expect(await saveConnection(db, ctx(other.impl), { ...credentials, shopDomain: "impact-two" })).toEqual({
      kind: "store-change",
      error: "This workspace already has orders from another store. Create a new workspace for a different store.",
    });
    expect(other.calls).toHaveLength(0);
    expect(await connectionRow(db)).toEqual(before);
  });

  it("rejects bad credentials input before any request", async () => {
    const db = await setup();
    const store = shop();
    const bodies: unknown[] = [
      { shopDomain: "impactrentals", clientId: CLIENT_ID },
      { shopDomain: "impactrentals", clientSecret: CLIENT_SECRET },
      { shopDomain: "impactrentals", clientId: "has space", clientSecret: CLIENT_SECRET },
      { shopDomain: "impactrentals", clientId: CLIENT_ID, clientSecret: "" },
      { shopDomain: "impactrentals", clientId: CLIENT_ID, clientSecret: "x".repeat(256) },
      { shopDomain: "example.com", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      { ...credentials, token: "shpat_also_a_token" },
    ];
    for (const body of bodies) {
      const result = await saveConnection(db, ctx(store.impl), body);
      expect(result.kind, JSON.stringify(body).slice(0, 90)).toBe("invalid");
      expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
    }
    expect(store.calls).toHaveLength(0);
    expect(await saveConnection(db, ctx(store.impl), bodies[6])).toEqual({
      kind: "invalid",
      error: "Enter either an Admin API access token or a Client ID and secret, not both",
    });
  });

  // Same store, other mode: the row switches mode cleanly and keeps the sync
  // progress, like a token-only change does.
  it("switches a legacy connection to client credentials and back, keeping sync progress", async () => {
    const db = await setup();
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impactrentals.myshopify.com",
      encryptedToken: await encryptSecret("shpat_old_legacy", KEY, WS),
      lastSyncAt: 1_759_000_000_000,
    });
    await seedOrder(db, WS, { id: "o1" });
    await saveConnection(db, ctx(shop().impl), credentials);
    expect(await connectionRow(db)).toMatchObject({
      authMode: "client_credentials",
      encryptedToken: "",
      lastSyncAt: 1_759_000_000_000,
    });

    const verify = (async () =>
      new Response(
        JSON.stringify({
          data: {
            shop: { name: "IMPACT Rentals" },
            currentAppInstallation: { accessScopes: FULL_SCOPES.map((handle) => ({ handle })) },
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    await saveConnection(db, ctx(verify), { shopDomain: "impactrentals", token: "shpat_new_legacy" });
    const row = await connectionRow(db);
    expect(row).toMatchObject({
      authMode: "legacy_token",
      clientId: null,
      encryptedClientSecret: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      webhooksRegisteredAt: null,
      lastSyncAt: 1_759_000_000_000,
    });
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe("shpat_new_legacy");
  });

  it("throws a redacted error when the write fails", async () => {
    const { db, raw } = openTestDb();
    await seedWorkspace(db, WS);
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM workspaces WHERE id = ?").run(WS);
    raw.pragma("foreign_keys = ON");
    let thrown: unknown;
    try {
      await saveConnection(db, ctx(shop().impl), credentials);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).toContain("FOREIGN KEY");
    for (const secret of [CLIENT_SECRET, MINTED, "v1."]) {
      expect(error.message).not.toContain(secret);
    }
    expect(error.cause).toBeUndefined();
  });
});
