import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { openTestDb, seedWorkspace } from "../desk/test-helpers";
import { runSync } from "./run";

// runSync on a client-credentials connection (platform amendment section 3):
// the token comes from getAccessToken, renewed before the fetch when it is
// near expiry. Stubbed fetch only.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const SECRET = "shpss_run_secret_value_8f8f";
const MINTED = "shpat_run_minted_token_9a9a";

const orderNode = {
  id: "gid://shopify/Order/9001",
  legacyResourceId: "9001",
  name: "#9001",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T11:00:00Z",
  displayFulfillmentStatus: "UNFULFILLED",
  tags: [],
  lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
};

type Call = { url: string; init: RequestInit };

// Answers the token endpoint with mintStatus, and the GraphQL endpoint with
// one page holding orderNode.
function shopFetch(mintStatus = 200) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(
        JSON.stringify(
          mintStatus === 200
            ? { access_token: MINTED, scope: "read_orders", expires_in: 86399 }
            : { error: "invalid_client", error_description: "Client authentication failed" },
        ),
        { status: mintStatus },
      );
    }
    return new Response(
      JSON.stringify({ data: { orders: { nodes: [orderNode], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, calls };
}

async function setup(overrides: Partial<typeof schema.storeConnections.$inferInsert> = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: "",
    authMode: "client_credentials",
    clientId: "client-id-1",
    encryptedClientSecret: await encryptSecret(SECRET, KEY, WS),
    encryptedAccessToken: null,
    accessTokenExpiresAt: null,
    ...overrides,
  });
  return db;
}

async function connection(db: Db) {
  const rows = await db
    .select()
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, WS));
  return rows[0];
}

describe("runSync with client credentials", () => {
  it("mints a token, caches it, and fetches orders with it", async () => {
    const db = await setup();
    const shop = shopFetch();
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBeUndefined();
    expect(result.added).toBe(1);
    expect(shop.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/admin/oauth/access_token",
      "/admin/api/2026-10/graphql.json",
    ]);
    expect((shop.calls[1].init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(MINTED);
    const row = await connection(db);
    expect(await decryptSecret(row.encryptedAccessToken!, KEY, WS)).toBe(MINTED);
    expect(row).toMatchObject({ status: "ok", lastError: null, runningUntil: 0, lastSyncAt: NOW });
  });

  it("uses a cached token that is still good without minting", async () => {
    const db = await setup({
      encryptedAccessToken: await encryptSecret("shpat_cached_run_token", KEY, WS),
      accessTokenExpiresAt: NOW + 3600000,
    });
    const shop = shopFetch();
    await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(shop.calls).toHaveLength(1);
    expect((shop.calls[0].init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(
      "shpat_cached_run_token",
    );
  });

  it("marks the connection in error when Shopify refuses the credentials", async () => {
    const db = await setup();
    const shop = shopFetch(401);
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    const message =
      "Shopify rejected the app's Client ID and secret (invalid_client: Client authentication failed). Reconnect the store in Settings.";
    expect(result).toMatchObject({ added: 0, updated: 0, error: message });
    expect(shop.calls).toHaveLength(1);
    expect(await connection(db)).toMatchObject({ status: "error", lastError: message, runningUntil: 0 });
  });

  it("marks the connection in error when the stored secret is unreadable", async () => {
    const db = await setup({ encryptedClientSecret: "v1.not.readable" });
    const shop = shopFetch();
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    const message = "Store credentials unreadable, reconnect the store in Settings";
    expect(result.error).toBe(message);
    expect(shop.calls).toHaveLength(0);
    expect(await connection(db)).toMatchObject({ status: "error", lastError: message, runningUntil: 0 });
  });

  it("keeps the status and retries next tick when the token request fails transiently", async () => {
    const db = await setup({ lastSyncAt: NOW - 600000 });
    const shop = shopFetch(503);
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBe("Shopify responded with HTTP 503");
    expect(await connection(db)).toMatchObject({
      status: "ok",
      lastError: "Shopify responded with HTTP 503",
      runningUntil: 0,
      lastSyncAt: NOW - 600000,
    });
  });
});
