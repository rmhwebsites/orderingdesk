import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { openTestDb, seedWorkspace, withBatch } from "@/server/desk/test-helpers";
import { RENEW_WITHIN_MS, getAccessToken } from "./token";

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const DAY_S = 86399;
const LEGACY_TOKEN = "shpat_legacy_token_value_0a1b";
const CLIENT_SECRET = "shpss_client_secret_value_2c3d";
const CACHED = "shpat_cached_access_token_4e5f";
const MINTED = "shpat_minted_access_token_6a7b";

type Call = { url: string; init: RequestInit };

function mintFetch(tokens: string[], status = 200) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const token = tokens[Math.min(calls.length - 1, tokens.length - 1)];
    return new Response(
      JSON.stringify(status === 200 ? { access_token: token, scope: "read_orders", expires_in: DAY_S } : { error: "invalid_client" }),
      { status },
    );
  }) as typeof fetch;
  return { impl, calls };
}

async function setup() {
  const { db, raw } = openTestDb();
  await seedWorkspace(db, WS);
  return { db, raw };
}

async function seedLegacy(db: Db, overrides: Partial<typeof schema.storeConnections.$inferInsert> = {}) {
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: await encryptSecret(LEGACY_TOKEN, KEY, WS),
    ...overrides,
  });
}

async function seedClientCredentials(
  db: Db,
  opts: { cached?: string | null; expiresAt?: number | null } = {},
  overrides: Partial<typeof schema.storeConnections.$inferInsert> = {},
) {
  const cached = opts.cached === undefined ? CACHED : opts.cached;
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: "",
    authMode: "client_credentials",
    clientId: "client-id-1",
    encryptedClientSecret: await encryptSecret(CLIENT_SECRET, KEY, WS),
    encryptedAccessToken: cached === null ? null : await encryptSecret(cached, KEY, WS),
    accessTokenExpiresAt: opts.expiresAt === undefined ? NOW + 3600000 : opts.expiresAt,
    ...overrides,
  });
}

async function row(db: Db) {
  const rows = await db
    .select()
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, WS));
  return rows[0];
}

const at = (now: number) => () => now;

describe("getAccessToken", () => {
  it("decrypts a legacy Admin API token without contacting Shopify", async () => {
    const { db } = await setup();
    await seedLegacy(db);
    const shop = mintFetch([MINTED]);
    expect(await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW) })).toEqual({
      kind: "ok",
      token: LEGACY_TOKEN,
      shopDomain: "impact-rentals.myshopify.com",
    });
    expect(shop.calls).toHaveLength(0);
  });

  it("reports an unreadable legacy token", async () => {
    for (const encryptedToken of ["", "v1.garbage.garbage", await encryptSecret(LEGACY_TOKEN, KEY, "ws_other")]) {
      const { db } = await setup();
      await seedLegacy(db, { encryptedToken });
      expect(await getAccessToken(db, env, WS, { now: at(NOW) })).toEqual({ kind: "unreadable" });
    }
  });

  it("serves a cached client-credentials token that is good for more than 10 minutes", async () => {
    const { db } = await setup();
    await seedClientCredentials(db, { expiresAt: NOW + RENEW_WITHIN_MS + 1 });
    const shop = mintFetch([MINTED]);
    expect(await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW) })).toMatchObject({
      kind: "ok",
      token: CACHED,
    });
    expect(shop.calls).toHaveLength(0);
    expect(RENEW_WITHIN_MS).toBe(10 * 60 * 1000);
  });

  it("renews a token that expires within 10 minutes and caches it encrypted with its expiry", async () => {
    for (const expiresAt of [NOW + RENEW_WITHIN_MS, NOW + 60000, NOW - 1]) {
      const { db } = await setup();
      await seedClientCredentials(db, { expiresAt });
      const shop = mintFetch([MINTED]);
      const result = await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW) });
      expect(result, String(expiresAt - NOW)).toEqual({
        kind: "ok",
        token: MINTED,
        shopDomain: "impact-rentals.myshopify.com",
      });
      // The stored secret is what was sent.
      expect(shop.calls).toHaveLength(1);
      const form = new URLSearchParams(String(shop.calls[0].init.body));
      expect(form.get("client_secret")).toBe(CLIENT_SECRET);
      expect(form.get("client_id")).toBe("client-id-1");
      const stored = await row(db);
      expect(stored.accessTokenExpiresAt).toBe(NOW + DAY_S * 1000);
      expect(stored.encryptedAccessToken).not.toContain(MINTED);
      expect(await decryptSecret(stored.encryptedAccessToken!, KEY, WS)).toBe(MINTED);
      await expect(decryptSecret(stored.encryptedAccessToken!, KEY, "ws_other")).rejects.toThrow();
    }
  });

  // Refresh connection (draft orders spec section 7.3): a token minted
  // before newly approved scopes does not carry them, so a forced renewal
  // ignores the cache and mints, through the same compare-and-set.
  it("mints and caches a new token on a forced renewal even while the cached one is good", async () => {
    const { db } = await setup();
    await seedClientCredentials(db, { expiresAt: NOW + 20 * 3600000 });
    const shop = mintFetch([MINTED]);
    expect(await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW), forceRenew: true })).toEqual({
      kind: "ok",
      token: MINTED,
      shopDomain: "impact-rentals.myshopify.com",
    });
    expect(shop.calls).toHaveLength(1);
    const stored = await row(db);
    expect(await decryptSecret(stored.encryptedAccessToken!, KEY, WS)).toBe(MINTED);
    expect(stored.accessTokenExpiresAt).toBe(NOW + DAY_S * 1000);
    // A legacy token has nothing to renew.
    const legacy = await setup();
    await seedLegacy(legacy.db);
    const none = mintFetch([MINTED]);
    expect(await getAccessToken(legacy.db, env, WS, { fetchImpl: none.impl, now: at(NOW), forceRenew: true })).toMatchObject({
      kind: "ok",
      token: LEGACY_TOKEN,
    });
    expect(none.calls).toHaveLength(0);
  });

  it("mints a first token when none is cached, and when the cached one is unreadable", async () => {
    for (const setupRow of [
      (db: Db) => seedClientCredentials(db, { cached: null, expiresAt: null }),
      (db: Db) =>
        seedClientCredentials(db, {}, { encryptedAccessToken: "v1.not.readable", accessTokenExpiresAt: NOW + 3600000 }),
    ]) {
      const { db } = await setup();
      await setupRow(db);
      const shop = mintFetch([MINTED]);
      expect(await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW) })).toMatchObject({
        kind: "ok",
        token: MINTED,
      });
      expect(await decryptSecret((await row(db)).encryptedAccessToken!, KEY, WS)).toBe(MINTED);
    }
  });

  // Two runs (a webhook and the cron, two isolates) find the token near
  // expiry at once. Both mint; exactly one renewal is cached, whole (token
  // and expiry from the same mint), and both runs leave with that token.
  it("survives two renewals at once: one consistent cached token, both callers served", async () => {
    const { db } = await setup();
    await seedClientCredentials(db, { expiresAt: NOW + 1000 });
    const isolateA = withBatch(db, []);
    const isolateB = withBatch(db, []);
    let release!: () => void;
    const bothAsked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const calls: string[] = [];
    const racing = (async () => {
      const token = asked === 0 ? "shpat_minted_by_a" : "shpat_minted_by_b";
      asked++;
      calls.push(token);
      if (asked === 2) {
        release();
      }
      await bothAsked;
      return new Response(JSON.stringify({ access_token: token, scope: "", expires_in: DAY_S }), { status: 200 });
    }) as typeof fetch;

    const [a, b] = await Promise.all([
      getAccessToken(isolateA, env, WS, { fetchImpl: racing, now: at(NOW) }),
      getAccessToken(isolateB, env, WS, { fetchImpl: racing, now: at(NOW) }),
    ]);
    expect(calls).toHaveLength(2);
    const stored = await row(db);
    const storedToken = await decryptSecret(stored.encryptedAccessToken!, KEY, WS);
    expect(["shpat_minted_by_a", "shpat_minted_by_b"]).toContain(storedToken);
    expect(stored.accessTokenExpiresAt).toBe(NOW + DAY_S * 1000);
    expect(a).toEqual({ kind: "ok", token: storedToken, shopDomain: "impact-rentals.myshopify.com" });
    expect(b).toEqual({ kind: "ok", token: storedToken, shopDomain: "impact-rentals.myshopify.com" });

    // The next caller uses the cache.
    const later = mintFetch([MINTED]);
    expect(await getAccessToken(db, env, WS, { fetchImpl: later.impl, now: at(NOW + 1000) })).toMatchObject({
      token: storedToken,
    });
    expect(later.calls).toHaveLength(0);
  });

  it("caches nothing when the store is disconnected while the token is being minted", async () => {
    const { db, raw } = await setup();
    await seedClientCredentials(db, { expiresAt: NOW });
    const disconnecting = (async () => {
      raw
        .prepare(
          "UPDATE store_connections SET status = 'disabled', encrypted_client_secret = NULL, encrypted_access_token = NULL, access_token_expires_at = NULL",
        )
        .run();
      return new Response(JSON.stringify({ access_token: MINTED, scope: "", expires_in: DAY_S }), { status: 200 });
    }) as typeof fetch;
    expect(await getAccessToken(db, env, WS, { fetchImpl: disconnecting, now: at(NOW) })).toEqual({
      kind: "unavailable",
      reason: "disabled",
    });
    expect(await row(db)).toMatchObject({ encryptedAccessToken: null, accessTokenExpiresAt: null });
  });

  it("keeps the cache untouched when Shopify refuses or cannot be reached", async () => {
    const { db } = await setup();
    await seedClientCredentials(db, { expiresAt: NOW + 1000 });
    const before = await row(db);
    const refused = await getAccessToken(db, env, WS, { fetchImpl: mintFetch([MINTED], 401).impl, now: at(NOW) });
    expect(refused).toEqual({ kind: "rejected", detail: "invalid_client" });
    const down = await getAccessToken(db, env, WS, { fetchImpl: mintFetch([MINTED], 503).impl, now: at(NOW) });
    expect(down).toEqual({ kind: "transient", detail: "Shopify responded with HTTP 503" });
    expect(await row(db)).toEqual(before);
    for (const result of [refused, down]) {
      expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(result)).not.toContain(before.encryptedClientSecret!);
    }
  });

  it("reports missing or unreadable client credentials without contacting Shopify", async () => {
    for (const overrides of [
      { clientId: null },
      { encryptedClientSecret: null },
      { encryptedClientSecret: "v1.not.readable" },
    ]) {
      const { db } = await setup();
      await seedClientCredentials(db, { expiresAt: NOW }, overrides);
      const shop = mintFetch([MINTED]);
      expect(await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW) })).toEqual({
        kind: "unreadable",
      });
      expect(shop.calls).toHaveLength(0);
    }
  });

  it("serves nothing for a disconnected store or a workspace without one", async () => {
    const { db } = await setup();
    const shop = mintFetch([MINTED]);
    expect(await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW) })).toEqual({
      kind: "unavailable",
      reason: "no-connection",
    });
    await seedClientCredentials(db, {}, { status: "disabled" });
    expect(await getAccessToken(db, env, WS, { fetchImpl: shop.impl, now: at(NOW) })).toEqual({
      kind: "unavailable",
      reason: "disabled",
    });
    expect(shop.calls).toHaveLength(0);
  });
});
