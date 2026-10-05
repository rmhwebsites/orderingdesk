import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { refreshConnection } from "./connection-refresh";
import { openTestDb, seedWorkspace } from "./test-helpers";

// Refresh connection (draft orders spec section 7.3): a platform admin
// re-reads the store's granted scopes after approving a new app version,
// with a freshly minted token, and re-registers the webhooks for them.
// Stubbed fetch only.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const SHOP = "impactrentals.myshopify.com";
const SECRET = "shpss_refresh_secret_value_9c9c";
const CACHED = "shpat_refresh_cached_token";
const MINTED = "shpat_refresh_minted_token";
const LEGACY = "shpat_refresh_legacy_token";
const APP_URL = "https://orderingdesk.com";

const REQUIRED = [
  "read_orders",
  "write_orders",
  "read_customers",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
];

type Call = { url: string; token: string | null; query: string; variables: Record<string, unknown> };

function shop(
  script: { scopes?: string[]; verifyStatus?: number; createError?: string; mintStatus?: number; myshopifyDomain?: string } = {},
) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const token = (init?.headers as Record<string, string> | undefined)?.["X-Shopify-Access-Token"] ?? null;
    if (url.endsWith("/admin/oauth/access_token")) {
      calls.push({ url, token, query: "mint", variables: {} });
      return new Response(
        JSON.stringify(
          script.mintStatus ? { error: "invalid_client" } : { access_token: MINTED, scope: "read_orders", expires_in: 86399 },
        ),
        { status: script.mintStatus ?? 200 },
      );
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };
    calls.push({ url, token, query: body.query, variables: body.variables ?? {} });
    if (body.query.includes("currentAppInstallation")) {
      if (script.verifyStatus) {
        return new Response("{}", { status: script.verifyStatus });
      }
      return Response.json({
        data: {
          shop: { name: "IMPACT Rentals", ...(script.myshopifyDomain ? { myshopifyDomain: script.myshopifyDomain } : {}) },
          currentAppInstallation: { accessScopes: (script.scopes ?? REQUIRED).map((handle) => ({ handle })) },
        },
      });
    }
    if (body.query.includes("webhookSubscriptions(")) {
      return Response.json({ data: { webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (body.query.includes("webhookSubscriptionCreate")) {
      return Response.json({
        data: {
          webhookSubscriptionCreate: {
            webhookSubscription: script.createError ? null : { id: "gid://shopify/WebhookSubscription/1" },
            userErrors: script.createError ? [{ field: ["topic"], message: script.createError }] : [],
          },
        },
      });
    }
    throw new Error("unexpected request: " + body.query);
  }) as typeof fetch;
  return {
    impl,
    calls,
    created: () => calls.filter((call) => call.query.includes("webhookSubscriptionCreate")).map((call) => call.variables.topic),
  };
}

async function setup(row: Partial<typeof schema.storeConnections.$inferInsert> | null = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  if (row !== null) {
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: SHOP,
      encryptedToken: "",
      authMode: "client_credentials",
      clientId: "client-id",
      encryptedClientSecret: await encryptSecret(SECRET, KEY, WS),
      encryptedAccessToken: await encryptSecret(CACHED, KEY, WS),
      accessTokenExpiresAt: NOW + 20 * 3600000,
      scopes: REQUIRED,
      ...row,
    });
  }
  return db;
}

const ctx = (fetchImpl: typeof fetch, appUrl: string | null = APP_URL) => ({
  workspaceId: WS,
  encryptionKey: KEY,
  appUrl: appUrl ?? undefined,
  fetchImpl,
  now: () => NOW,
});

async function stored(db: Db) {
  return (await db.select().from(schema.storeConnections).where(eq(schema.storeConnections.workspaceId, WS)))[0];
}

describe("refreshConnection", () => {
  it("mints a fresh token, saves the granted scopes and registers the draft topics once they are granted", async () => {
    const db = await setup();
    const store = shop({ scopes: [...REQUIRED, "write_draft_orders", "read_companies"] });
    const result = await refreshConnection(db, ctx(store.impl));
    expect(result.kind).toBe("refreshed");
    if (result.kind !== "refreshed") return;
    expect(result.warning).toBeUndefined();
    expect(result.connection).toMatchObject({
      shopDomain: SHOP,
      scopes: [...REQUIRED, "write_draft_orders", "read_companies"],
      draftsEnabled: true,
      missingDraftScopes: [],
      missingScopes: [],
      webhooksRegisteredAt: NOW,
    });
    // The cached token was good for hours; the refresh minted anyway, and
    // used the new token for everything after.
    expect(store.calls[0].query).toBe("mint");
    expect(store.calls.slice(1).every((call) => call.token === MINTED)).toBe(true);
    expect(store.created().slice(-3)).toEqual(["DRAFT_ORDERS_CREATE", "DRAFT_ORDERS_UPDATE", "DRAFT_ORDERS_DELETE"]);
    expect(store.created()).toHaveLength(13);
    const row = await stored(db);
    expect(row.scopes).toEqual([...REQUIRED, "write_draft_orders", "read_companies"]);
    expect(await decryptSecret(row.encryptedAccessToken!, KEY, WS)).toBe(MINTED);
    expect(JSON.stringify(result)).not.toContain(MINTED);
  });

  it("records the store's own myshopify domain, so webhooks naming it are accepted", async () => {
    // IMPACT was connected as impactrentals.myshopify.com, an alias of
    // 40kra0-b6.myshopify.com, which is what Shopify puts in
    // X-Shopify-Shop-Domain. Refresh connection (Ryan's one step) records it.
    const db = await setup();
    const store = shop({ scopes: [...REQUIRED, "write_draft_orders"], myshopifyDomain: "40kra0-b6.myshopify.com" });
    expect((await refreshConnection(db, ctx(store.impl))).kind).toBe("refreshed");
    expect(await stored(db)).toMatchObject({ shopDomain: SHOP, canonicalShopDomain: "40kra0-b6.myshopify.com" });

    // A disconnected store is never written.
    const off = await setup({ status: "disabled" });
    await refreshConnection(off, ctx(store.impl));
    expect((await stored(off)).canonicalShopDomain).toBeNull();
  });

  it("registers only the base topics while the draft scopes are missing, and says what is missing", async () => {
    const db = await setup();
    const store = shop({ scopes: ["read_orders", "write_orders", "read_customers"] });
    const result = await refreshConnection(db, ctx(store.impl));
    expect(result).toMatchObject({
      kind: "refreshed",
      connection: {
        draftsEnabled: false,
        missingDraftScopes: ["read_draft_orders", "write_draft_orders"],
        missingScopes: ["read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"],
      },
      warning:
        "The Shopify app is missing these permissions: read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders. The store stays connected.",
    });
    expect(store.created()).toHaveLength(10);
    expect((await stored(db)).status).toBe("ok");
  });

  it("keeps the saved scopes and warns when Shopify refuses the webhooks or there is nowhere to send them", async () => {
    const db = await setup();
    const refused = shop({ scopes: [...REQUIRED, "write_draft_orders"], createError: "Topic not allowed" });
    expect(await refreshConnection(db, ctx(refused.impl))).toMatchObject({
      kind: "refreshed",
      connection: { draftsEnabled: true, webhooksRegisteredAt: null },
      warning: "Webhooks were not registered: Topic not allowed",
    });
    expect((await stored(db)).scopes).toContain("write_draft_orders");
    const nowhere = shop({ scopes: REQUIRED });
    expect(await refreshConnection(db, ctx(nowhere.impl, null))).toMatchObject({
      kind: "refreshed",
      warning: "Webhooks were not registered: the app has no APP_URL to receive them",
    });
    expect(nowhere.created()).toEqual([]);
  });

  it("uses a legacy token as stored and registers no webhooks", async () => {
    const db = await setup({
      authMode: "legacy_token",
      encryptedToken: await encryptSecret(LEGACY, KEY, WS),
      clientId: null,
      encryptedClientSecret: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
    });
    const store = shop({ scopes: [...REQUIRED, "write_draft_orders"] });
    const result = await refreshConnection(db, ctx(store.impl));
    expect(result).toMatchObject({ kind: "refreshed", connection: { draftsEnabled: true } });
    expect(store.calls.map((call) => call.query.includes("currentAppInstallation"))).toEqual([true]);
    expect(store.calls[0].token).toBe(LEGACY);
  });

  it("answers no connection for a workspace without a store or with a disconnected one", async () => {
    for (const db of [await setup(null), await setup({ status: "disabled" })]) {
      const store = shop();
      expect(await refreshConnection(db, ctx(store.impl))).toEqual({ kind: "no-connection", error: "Connect the store first." });
      expect(store.calls).toEqual([]);
    }
  });

  it("reports rejected credentials and an unreachable Shopify without saving anything", async () => {
    const refusedMint = await setup();
    expect(await refreshConnection(refusedMint, ctx(shop({ mintStatus: 401 }).impl))).toEqual({
      kind: "rejected",
      error: "Shopify rejected the store credentials. Reconnect the store in Settings.",
    });
    const refusedToken = await setup();
    expect(await refreshConnection(refusedToken, ctx(shop({ verifyStatus: 401 }).impl))).toEqual({
      kind: "rejected",
      error: "Shopify rejected the store credentials. Reconnect the store in Settings.",
    });
    const down = await setup();
    expect(await refreshConnection(down, ctx(shop({ verifyStatus: 503 }).impl))).toEqual({
      kind: "unreachable",
      error: "Could not refresh the connection: Shopify responded with HTTP 503",
    });
    expect((await stored(down)).scopes).toEqual(REQUIRED);
  });
});
