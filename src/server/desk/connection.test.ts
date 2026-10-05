import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import {
  TOKEN_MAX,
  deleteConnection,
  normalizeShopDomain,
  normalizeToken,
  saveConnection,
} from "./connection";
import { canCreateAccount } from "@/server/access";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace } from "./test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_connection_test_token_7c1d";
const NEW_TOKEN = "shpat_rotated_token_value_9e2f";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  return db;
}

type Call = { url: string; init: RequestInit };

// Answers every request with the given status and JSON body, recording calls.
function shopFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const verifiedBody = (handles: string[]) => ({
  data: {
    shop: { name: "IMPACT Rentals" },
    currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) },
  },
});

// Everything the two-way sync needs (platform amendment section 3).
const FULL_SCOPES = [
  "read_orders",
  "write_orders",
  "read_customers",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
];
const okShop = () => shopFetch(200, verifiedBody(FULL_SCOPES));
const missingMessage = (missing: string[]) =>
  `The Shopify app is missing these permissions: ${missing.join(", ")}. Add them to the app's access scopes, approve the new version on the store, and connect again.`;

const STORE_CHANGE_ERROR =
  "This workspace already has orders from another store. Create a new workspace for a different store.";

async function connectionRow(db: Db, workspaceId = WS) {
  const rows = await db
    .select()
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, workspaceId));
  return rows[0];
}

async function seedConnection(db: Db, overrides: Partial<typeof schema.storeConnections.$inferInsert> = {}) {
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impactrentals.myshopify.com",
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    status: "error",
    lastError: "Shopify rejected the token. Update the connection in Settings.",
    lastSyncAt: 1_759_000_000_000,
    lastManualSyncAt: 1_759_000_100_000,
    runningUntil: 9_999_999_999_999,
    syncCursor: "1759000000000|cursor-abc",
    syncCursorSince: 1_758_000_000_000,
    ...overrides,
  });
}

const ctx = (fetchImpl: typeof fetch) => ({ workspaceId: WS, encryptionKey: KEY, fetchImpl });

describe("normalizeShopDomain", () => {
  it("normalizes handles, mixed case, schemes, paths and queries to the myshopify host", () => {
    const table: Array<[string, string]> = [
      ["impactrentals", "impactrentals.myshopify.com"],
      ["ImpactRentals.myshopify.com ", "impactrentals.myshopify.com"],
      ["https://impactrentals.myshopify.com/admin/orders", "impactrentals.myshopify.com"],
      ["http://impactrentals.myshopify.com/", "impactrentals.myshopify.com"],
      ["HTTPS://IMPACT-RENTALS.MYSHOPIFY.COM?ref=admin", "impact-rentals.myshopify.com"],
      ["impactrentals.myshopify.com#orders", "impactrentals.myshopify.com"],
      ["  impact-rentals-2  ", "impact-rentals-2.myshopify.com"],
      // A store handle is one DNS label: at most 63 characters.
      ["a".repeat(63), "a".repeat(63) + ".myshopify.com"],
    ];
    for (const [input, expected] of table) {
      expect(normalizeShopDomain(input), input).toBe(expected);
    }
  });

  it("rejects anything that is not a myshopify.com store address", () => {
    const rejected: unknown[] = [
      "example.com",
      "evil.myshopify.com.attacker.io",
      "https://evil.example/impactrentals.myshopify.com",
      "impactrentals.myshopify.com.evil.example/",
      "admin.shopify.com/store/impactrentals",
      "user@impactrentals.myshopify.com",
      "impactrentals.myshopify.com:443",
      "ftp://impactrentals.myshopify.com",
      "https://https://impactrentals.myshopify.com",
      "-impact",
      "impact rentals",
      "impact_rentals",
      "a".repeat(64),
      "a".repeat(64) + ".myshopify.com",
      "",
      "   ",
      "x".repeat(3000),
      42,
      null,
      undefined,
    ];
    for (const input of rejected) {
      expect(normalizeShopDomain(input), JSON.stringify(input)?.slice(0, 60)).toBeNull();
    }
  });
});

describe("normalizeToken", () => {
  it("trims and accepts up to 255 non-whitespace characters", () => {
    expect(TOKEN_MAX).toBe(255);
    expect(normalizeToken(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(normalizeToken("t".repeat(TOKEN_MAX))).toBe("t".repeat(TOKEN_MAX));
  });

  // The token travels in an HTTP header, which only carries visible ASCII.
  it("rejects empty, too long, whitespace, control, non-ASCII and non-string tokens", () => {
    for (const input of [
      "",
      "   ",
      "t".repeat(TOKEN_MAX + 1),
      "shpat_abc def",
      "shpat_\tabc",
      "a\nb",
      "shpat_\u0000abc",
      "shpat_tök",
      "shpat_ abc",
      7,
      null,
    ]) {
      expect(normalizeToken(input), JSON.stringify(input)?.slice(0, 40)).toBeNull();
    }
  });
});

describe("saveConnection", () => {
  it("verifies, then stores a new connection encrypted with aad = workspaceId", async () => {
    const db = await setup();
    const shop = okShop();
    const result = await saveConnection(db, ctx(shop.impl), {
      shopDomain: "https://ImpactRentals.myshopify.com/admin",
      token: `  ${TOKEN} `,
    });

    // The same connection shape as GET /sync, plus the verified shop name.
    expect(result).toEqual({
      kind: "saved",
      connection: {
        shopDomain: "impactrentals.myshopify.com",
        status: "ok",
        lastSyncAt: 0,
        lastError: null,
        shopName: "IMPACT Rentals",
        authMode: "legacy_token",
        // A legacy token's app secret is unknown, so its webhooks could not
        // be verified: none are registered and the cron sync carries it.
        webhooksRegisteredAt: null,
      },
    });
    // The verification call went to the normalized host with the trimmed token.
    expect(shop.calls).toHaveLength(1);
    expect(shop.calls[0].url.startsWith("https://impactrentals.myshopify.com/admin/api/")).toBe(true);
    expect((shop.calls[0].init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(TOKEN);

    const row = await connectionRow(db);
    expect(row).toMatchObject({
      shopDomain: "impactrentals.myshopify.com",
      status: "ok",
      lastError: null,
      lastSyncAt: 0,
      runningUntil: 0,
      syncCursor: null,
      syncCursorSince: null,
    });
    expect(row.encryptedToken).not.toContain(TOKEN);
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe(TOKEN);
    await expect(decryptSecret(row.encryptedToken, KEY, OTHER)).rejects.toThrow();
    await expect(decryptSecret(row.encryptedToken, KEY)).rejects.toThrow();
  });

  it("resets the sync state and the lease when the shop domain changes before any order exists", async () => {
    const db = await setup();
    await seedConnection(db);
    // Another workspace's orders do not count.
    await seedOrder(db, OTHER, { id: "x1" });
    const result = await saveConnection(db, ctx(okShop().impl), {
      shopDomain: "impact-two",
      token: NEW_TOKEN,
    });
    expect(result).toMatchObject({
      kind: "saved",
      connection: { shopDomain: "impact-two.myshopify.com", status: "ok", lastSyncAt: 0 },
    });

    const row = await connectionRow(db);
    expect(row).toMatchObject({
      shopDomain: "impact-two.myshopify.com",
      status: "ok",
      lastError: null,
      lastSyncAt: 0,
      syncCursor: null,
      syncCursorSince: null,
      runningUntil: 0,
    });
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe(NEW_TOKEN);
  });

  // An order history import belongs to the store it started on: its cursor
  // means nothing on another store.
  it("clears an order history import when the shop domain changes, and keeps it for new credentials", async () => {
    const running = {
      backfillStatus: "running" as const,
      backfillSince: null,
      backfillCursor: "h:40",
      backfillImported: 0,
      backfillStartedAt: 1_759_000_000_000,
    };
    const moved = await setup();
    await seedConnection(moved, running);
    await saveConnection(moved, ctx(okShop().impl), { shopDomain: "impact-two", token: NEW_TOKEN });
    expect(await connectionRow(moved)).toMatchObject({
      backfillStatus: null,
      backfillCursor: null,
      backfillImported: 0,
      backfillStartedAt: null,
      backfillFinishedAt: null,
      backfillError: null,
    });

    const same = await setup();
    await seedConnection(same, running);
    await saveConnection(same, ctx(okShop().impl), { shopDomain: "impactrentals.myshopify.com", token: NEW_TOKEN });
    expect(await connectionRow(same)).toMatchObject(running);
  });

  it("keeps lastSyncAt and the cursor when only the token changes, orders or not", async () => {
    const db = await setup();
    await seedConnection(db);
    await seedOrder(db, WS, { id: "o1" });
    const result = await saveConnection(db, ctx(okShop().impl), {
      shopDomain: "impactrentals.myshopify.com",
      token: NEW_TOKEN,
    });
    expect(result).toMatchObject({
      kind: "saved",
      connection: { shopDomain: "impactrentals.myshopify.com", lastSyncAt: 1_759_000_000_000 },
    });

    const row = await connectionRow(db);
    expect(row).toMatchObject({
      status: "ok",
      lastError: null,
      lastSyncAt: 1_759_000_000_000,
      lastManualSyncAt: 1_759_000_100_000,
      syncCursor: "1759000000000|cursor-abc",
      syncCursorSince: 1_758_000_000_000,
      // A run still holding the lease used the old credentials; its terminal
      // write must not overwrite the state saved here.
      runningUntil: 0,
    });
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe(NEW_TOKEN);
  });

  it("saves nothing when Shopify rejects the token", async () => {
    const db = await setup();
    await seedConnection(db);
    const before = await connectionRow(db);
    for (const status of [401, 403]) {
      const result = await saveConnection(db, ctx(shopFetch(status, {}).impl), {
        shopDomain: "impact-two",
        token: NEW_TOKEN,
      });
      expect(result).toEqual({ kind: "rejected", error: "Shopify rejected this token" });
    }
    expect(await connectionRow(db)).toEqual(before);

    // And no row appears for a workspace that had none.
    const fresh = await saveConnection(
      db,
      { workspaceId: OTHER, encryptionKey: KEY, fetchImpl: shopFetch(401, {}).impl },
      { shopDomain: "other-shop", token: NEW_TOKEN },
    );
    expect(fresh).toEqual({ kind: "rejected", error: "Shopify rejected this token" });
    expect(await connectionRow(db, OTHER)).toBeUndefined();
  });

  it("names every missing permission, and saves nothing", async () => {
    const db = await setup();
    await seedConnection(db);
    const before = await connectionRow(db);
    const cases: Array<[string[], string[]]> = [
      [["read_products"], FULL_SCOPES],
      [[], FULL_SCOPES],
      [
        ["write_orders_typo", "read_customers"],
        [
          "read_orders",
          "write_orders",
          "read_merchant_managed_fulfillment_orders",
          "write_merchant_managed_fulfillment_orders",
        ],
      ],
      [["read_orders", "read_customers", "write_merchant_managed_fulfillment_orders"], ["write_orders"]],
      [
        ["write_orders", "read_merchant_managed_fulfillment_orders"],
        ["read_customers", "write_merchant_managed_fulfillment_orders"],
      ],
    ];
    for (const [handles, missing] of cases) {
      const result = await saveConnection(db, ctx(shopFetch(200, verifiedBody(handles)).impl), {
        shopDomain: "impactrentals",
        token: NEW_TOKEN,
      });
      expect(result, JSON.stringify(handles)).toEqual({ kind: "rejected", error: missingMessage(missing) });
    }
    expect(await connectionRow(db)).toEqual(before);
  });

  // A write scope implies its read scope, and Shopify may list only the
  // write handle. read_all_orders is optional on top.
  it("accepts a write scope in place of its read scope", async () => {
    const db = await setup();
    const result = await saveConnection(
      db,
      ctx(
        shopFetch(200, verifiedBody(["write_orders", "write_customers", "write_merchant_managed_fulfillment_orders"]))
          .impl,
      ),
      { shopDomain: "impactrentals", token: TOKEN },
    );
    expect(result.kind).toBe("saved");
  });

  it("accepts the required scopes with read_all_orders alongside", async () => {
    const db = await setup();
    const result = await saveConnection(
      db,
      ctx(shopFetch(200, verifiedBody([...FULL_SCOPES, "read_all_orders"])).impl),
      { shopDomain: "impactrentals", token: TOKEN },
    );
    expect(result.kind).toBe("saved");
  });

  it("does not count read_all_orders as order access", async () => {
    const db = await setup();
    const handles = [
      "read_all_orders",
      "read_customers",
      "read_merchant_managed_fulfillment_orders",
      "write_merchant_managed_fulfillment_orders",
    ];
    const result = await saveConnection(db, ctx(shopFetch(200, verifiedBody(handles)).impl), {
      shopDomain: "impactrentals",
      token: TOKEN,
    });
    expect(result).toEqual({ kind: "rejected", error: missingMessage(["read_orders", "write_orders"]) });
  });

  it("records the verified shop name and scopes as a legacy token connection", async () => {
    const db = await setup();
    await saveConnection(db, ctx(okShop().impl), {
      shopDomain: "impactrentals",
      token: TOKEN,
    });
    expect(await connectionRow(db)).toMatchObject({
      authMode: "legacy_token",
      shopName: "IMPACT Rentals",
      scopes: FULL_SCOPES,
      webhooksRegisteredAt: null,
      clientId: null,
      encryptedClientSecret: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
    });
  });

  it("answers a Shopify 404 as no store at this address, and saves nothing", async () => {
    const db = await setup();
    const result = await saveConnection(db, ctx(shopFetch(404, { errors: "Not Found" }).impl), {
      shopDomain: "no-such-store",
      token: TOKEN,
    });
    expect(result).toEqual({ kind: "invalid", error: "No Shopify store at this address" });
    expect(await connectionRow(db)).toBeUndefined();
  });

  // A workspace is one business with one store.
  it("refuses to move a workspace with orders to another store, before contacting Shopify", async () => {
    const db = await setup();
    await seedConnection(db);
    await seedOrder(db, WS, { id: "o1" });
    const before = await connectionRow(db);
    const shop = okShop();

    const result = await saveConnection(db, ctx(shop.impl), {
      shopDomain: "impact-two",
      token: NEW_TOKEN,
    });
    expect(result).toEqual({ kind: "store-change", error: STORE_CHANGE_ERROR });
    expect(shop.calls).toHaveLength(0);
    expect(await connectionRow(db)).toEqual(before);
  });

  // The early refusal above is a read; the decision that counts is inside
  // the upsert, so an order that lands while the token is being verified
  // still blocks the change.
  it("refuses inside the upsert when the first order lands during verification", async () => {
    const { db, raw } = openTestDb();
    await seedWorkspace(db, WS);
    await seedConnection(db);
    const before = await connectionRow(db);
    const orderArrives = (async () => {
      raw
        .prepare(
          "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("late", WS, "991", "#991", "{}", "new", 1, 1);
      return new Response(JSON.stringify(verifiedBody(FULL_SCOPES)), { status: 200 });
    }) as typeof fetch;

    const result = await saveConnection(db, ctx(orderArrives), {
      shopDomain: "impact-two",
      token: NEW_TOKEN,
    });
    expect(result).toEqual({ kind: "store-change", error: STORE_CHANGE_ERROR });
    expect(await connectionRow(db)).toEqual(before);
  });

  it("saves nothing when Shopify cannot be reached or answers with an error", async () => {
    const db = await setup();
    await seedConnection(db);
    const before = await connectionRow(db);
    const throwing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const failures: typeof fetch[] = [
      shopFetch(429, {}).impl,
      shopFetch(503, {}).impl,
      shopFetch(200, { errors: [{ message: "Internal error" }] }).impl,
      throwing,
    ];
    for (const fetchImpl of failures) {
      const result = await saveConnection(db, ctx(fetchImpl), {
        shopDomain: "impactrentals",
        token: NEW_TOKEN,
      });
      expect(result.kind).toBe("unreachable");
      if (result.kind === "unreachable") {
        expect(result.error.length).toBeGreaterThan(0);
      }
    }
    expect(await connectionRow(db)).toEqual(before);
  });

  it("rejects a bad domain or token before any request is made", async () => {
    const db = await setup();
    const shop = okShop();
    const bodies: unknown[] = [
      null,
      { token: TOKEN },
      { shopDomain: "impactrentals" },
      { shopDomain: "example.com", token: TOKEN },
      { shopDomain: "evil.myshopify.com.attacker.io", token: TOKEN },
      { shopDomain: "impactrentals", token: "" },
      { shopDomain: "impactrentals", token: "has space" },
      { shopDomain: "impactrentals", token: "t".repeat(TOKEN_MAX + 1) },
    ];
    for (const body of bodies) {
      const result = await saveConnection(db, ctx(shop.impl), body);
      expect(result.kind, JSON.stringify(body)?.slice(0, 80)).toBe("invalid");
    }
    expect(shop.calls).toHaveLength(0);
    expect(await connectionRow(db)).toBeUndefined();
    const domainError = await saveConnection(db, ctx(shop.impl), {
      shopDomain: "example.com",
      token: TOKEN,
    });
    expect(domainError).toMatchObject({ kind: "invalid", error: expect.stringContaining(".myshopify.com") });
  });

  it("never returns the token or the ciphertext, whatever the outcome", async () => {
    const db = await setup();
    const echo = (async () =>
      new Response(JSON.stringify({ errors: [{ message: `bad token ${TOKEN}` }] }), {
        status: 200,
      })) as typeof fetch;
    const echoThrow = (async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    }) as typeof fetch;
    const outcomes = [
      await saveConnection(db, ctx(echo), { shopDomain: "impactrentals", token: TOKEN }),
      await saveConnection(db, ctx(echoThrow), { shopDomain: "impactrentals", token: TOKEN }),
      await saveConnection(db, ctx(shopFetch(401, {}).impl), { shopDomain: "impactrentals", token: TOKEN }),
      await saveConnection(db, ctx(okShop().impl), { shopDomain: "impactrentals", token: TOKEN }),
    ];
    const row = await connectionRow(db);
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain(row.encryptedToken);
      expect(serialized).not.toContain("encryptedToken");
    }
  });

  // drizzle wraps a failed query in an error whose message lists the bound
  // params (here: the ciphertext), and route errors are logged. The service
  // must throw a fresh error that carries neither the token nor the
  // ciphertext, and no cause chain back to the original.
  it("throws a redacted error when the write fails", async () => {
    const { db, raw } = openTestDb();
    await seedWorkspace(db, WS);
    // Remove the workspace behind the foreign key's back so the insert fails.
    raw.pragma("foreign_keys = OFF");
    raw.prepare("DELETE FROM workspaces WHERE id = ?").run(WS);
    raw.pragma("foreign_keys = ON");

    let thrown: unknown;
    try {
      await saveConnection(db, ctx(okShop().impl), { shopDomain: "impactrentals", token: TOKEN });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { cause?: unknown; params?: unknown };
    expect(error.message).toContain("FOREIGN KEY");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("v1.");
    expect(error.message).not.toContain("params");
    expect(error.cause).toBeUndefined();
    expect(error.params).toBeUndefined();
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("v1.");
  });
});

// Disconnect is disable: the row stays (so the one-store rule still knows
// which store the workspace's orders came from), every stored secret goes.
describe("deleteConnection", () => {
  it("disables the connection, clears every secret, the error and the lease, and keeps the orders", async () => {
    const db = await setup();
    await seedConnection(db, {
      authMode: "client_credentials",
      clientId: "client-id-123",
      encryptedClientSecret: "v1.secret-ciphertext",
      encryptedAccessToken: "v1.access-ciphertext",
      accessTokenExpiresAt: 1_759_100_000_000,
      webhooksRegisteredAt: 1_759_000_000_000,
    });
    await seedOrder(db, WS, { id: "o1" });

    await deleteConnection(db, WS);
    // Deliveries for a disabled store are refused, so live updates are off.
    expect((await connectionRow(db)).webhooksRegisteredAt).toBeNull();
    expect(await connectionRow(db)).toMatchObject({
      shopDomain: "impactrentals.myshopify.com",
      status: "disabled",
      encryptedToken: "",
      encryptedClientSecret: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      lastError: null,
      runningUntil: 0,
      // Sync progress stays, so reconnecting the same store resumes.
      lastSyncAt: 1_759_000_000_000,
      syncCursor: "1759000000000|cursor-abc",
    });
    const orders = await db.select().from(schema.orders).where(eq(schema.orders.workspaceId, WS));
    expect(orders.map((o) => o.id)).toEqual(["o1"]);

    // Idempotent, and a no-op without a connection.
    await expect(deleteConnection(db, WS)).resolves.toEqual({ revokedUserIds: [] });
    await expect(deleteConnection(db, OTHER)).resolves.toEqual({ revokedUserIds: [] });
    expect(await connectionRow(db, OTHER)).toBeUndefined();
  });

  it("only touches its own workspace", async () => {
    const db = await setup();
    await seedConnection(db);
    await deleteConnection(db, OTHER);
    expect((await connectionRow(db)).status).toBe("error");
  });

  // Once disconnected, neither the roster sync nor the customer webhooks run
  // for the store, so a tag removed in Shopify could never revoke anything:
  // the disconnect itself takes away every access a tag gave here. A
  // reconnect grants it again at the next roster sync.
  it("takes away every access a Shopify tag gave in this workspace, and answers whose membership went", async () => {
    const db = await setup();
    await seedConnection(db, { status: "ok" });
    await seedUser(db, "u_tagged", "tagged@example.com");
    await seedUser(db, "u_manual", "manual@example.com");
    await seedUser(db, "u_elsewhere", "elsewhere@example.com");
    await seedMember(db, WS, "u_tagged", "manager", "shopify");
    await seedMember(db, WS, "u_manual", "staff", "manual");
    await seedMember(db, OTHER, "u_elsewhere", "staff", "shopify");
    const rosterRow = (id: string, workspaceId: string, email: string) => ({
      id,
      workspaceId,
      email,
      role: "staff" as const,
      shopifyCustomerId: id,
      updatedAt: 1,
      approvedRole: "staff" as const,
      approvedAt: 2,
      approvedBy: "u_manager",
    });
    await db.insert(schema.shopifyRoster).values([
      rosterRow("r1", WS, "tagged@example.com"),
      rosterRow("r2", WS, "newhire@example.com"),
      rosterRow("r3", OTHER, "elsewhere@example.com"),
    ]);

    expect(await canCreateAccount(db, {}, "newhire@example.com")).toBe(true);
    expect(await deleteConnection(db, WS)).toEqual({ revokedUserIds: ["u_tagged"] });
    const members = await db
      .select({ userId: schema.workspaceMembers.userId, workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers);
    expect(members.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: "u_elsewhere", workspaceId: OTHER },
      { userId: "u_manual", workspaceId: WS },
    ]);
    const rosterLeft = await db.select({ email: schema.shopifyRoster.email }).from(schema.shopifyRoster);
    expect(rosterLeft).toEqual([{ email: "elsewhere@example.com" }]);
    // An approved roster email of this workspace can no longer create an
    // account (a reconnect brings the tags back as new requests).
    expect(await canCreateAccount(db, {}, "newhire@example.com")).toBe(false);
  });

  it("lets the same store reconnect and re-enables it with sync progress kept", async () => {
    const db = await setup();
    await seedConnection(db);
    await seedOrder(db, WS, { id: "o1" });
    await deleteConnection(db, WS);

    const result = await saveConnection(db, ctx(okShop().impl), {
      shopDomain: "impactrentals",
      token: NEW_TOKEN,
    });
    expect(result).toMatchObject({ kind: "saved", connection: { status: "ok", lastSyncAt: 1_759_000_000_000 } });
    const row = await connectionRow(db);
    expect(row).toMatchObject({ status: "ok", lastError: null, syncCursor: "1759000000000|cursor-abc" });
    expect(await decryptSecret(row.encryptedToken, KEY, WS)).toBe(NEW_TOKEN);
  });

  it("refuses a different store after a disconnect while the workspace has orders", async () => {
    const db = await setup();
    await seedConnection(db);
    await seedOrder(db, WS, { id: "o1" });
    await deleteConnection(db, WS);
    const before = await connectionRow(db);
    const shop = okShop();

    const result = await saveConnection(db, ctx(shop.impl), { shopDomain: "impact-two", token: NEW_TOKEN });
    expect(result).toEqual({ kind: "store-change", error: STORE_CHANGE_ERROR });
    expect(shop.calls).toHaveLength(0);
    expect(await connectionRow(db)).toEqual(before);
  });

  it("accepts a different store after a disconnect when the workspace has no orders, starting sync over", async () => {
    const db = await setup();
    await seedConnection(db);
    await deleteConnection(db, WS);

    const result = await saveConnection(db, ctx(okShop().impl), { shopDomain: "impact-two", token: NEW_TOKEN });
    expect(result).toMatchObject({ kind: "saved", connection: { shopDomain: "impact-two.myshopify.com", lastSyncAt: 0 } });
    expect(await connectionRow(db)).toMatchObject({
      shopDomain: "impact-two.myshopify.com",
      status: "ok",
      lastSyncAt: 0,
      syncCursor: null,
      syncCursorSince: null,
      runningUntil: 0,
    });
  });
});
