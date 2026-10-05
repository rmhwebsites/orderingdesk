// Store connection: the workspace's Shopify domain and credentials, in one
// of two modes (platform amendment section 3):
// - client_credentials: a Dev Dashboard app's Client ID and secret, traded
//   for an access token that lasts about 24 hours (cached, renewed by
//   src/server/shopify/token.ts). Connecting also registers the webhooks.
// - legacy_token: a long-lived Admin API token from an app made before 2026.
//   No webhooks (their signatures could not be verified without the app's
//   secret); the cron sync carries these stores.
// Security-critical. Credentials are verified against Shopify before
// anything is stored, stored only encrypted (AES-GCM, aad = workspaceId, so
// a ciphertext only decrypts on this workspace's row), and neither a secret,
// a token nor a ciphertext is ever returned, logged or put into an error.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { orders, storeConnections } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { failureText, replaceWebhookSubscriptions, webhookCallbackUrl } from "@/server/shopify/admin";
import { clearShopifyAccess } from "@/server/shopify/roster-sync";
import { isValidShopDomain, mintAccessToken, testShopConnection } from "@/server/shopify/client";
import { isRecord } from "./shapes";

export const TOKEN_MAX = 255;
// Bounds the work done on pasted input before it is parsed.
const DOMAIN_INPUT_MAX = 2048;
const MYSHOPIFY_SUFFIX = ".myshopify.com";
// A store handle is a single DNS label.
const STORE_HANDLE = /^[a-z0-9][a-z0-9-]*$/;
const HANDLE_MAX = 63;
// Visible ASCII only (so no whitespace or control characters): the token
// travels in an HTTP header, and Shopify tokens are ASCII.
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

const DOMAIN_ERROR =
  "Use your store's .myshopify.com address, for example your-store.myshopify.com";

// Accepts what an owner is likely to paste: a bare store handle, the
// myshopify host in any case, or a URL on it. Trims and lowercases, strips a
// leading http:// or https://, drops any path, query or fragment, and appends
// .myshopify.com to a bare handle. The result must pass the same host
// allowlist the sync client enforces; anything else is null.
export function normalizeShopDomain(input: unknown): string | null {
  if (typeof input !== "string" || input.length > DOMAIN_INPUT_MAX) {
    return null;
  }
  let value = input.trim().toLowerCase();
  if (value.startsWith("https://")) {
    value = value.slice("https://".length);
  } else if (value.startsWith("http://")) {
    value = value.slice("http://".length);
  }
  const end = value.search(/[/?#]/);
  if (end !== -1) {
    value = value.slice(0, end);
  }
  if (STORE_HANDLE.test(value)) {
    value += MYSHOPIFY_SUFFIX;
  }
  if (!isValidShopDomain(value) || value.length - MYSHOPIFY_SUFFIX.length > HANDLE_MAX) {
    return null;
  }
  return value;
}

// Trimmed token, 1 to TOKEN_MAX visible ASCII characters (no whitespace
// inside); null otherwise.
export function normalizeToken(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const token = input.trim();
  if (token.length === 0 || token.length > TOKEN_MAX || !TOKEN_CHARS.test(token)) {
    return null;
  }
  return token;
}

export type ConnectionView = {
  shopDomain: string;
  status: "ok";
  lastSyncAt: number;
  // Same shape as the connection in GET /api/workspaces/[id]/sync; always
  // null right after a save.
  lastError: string | null;
  shopName: string;
  authMode: "client_credentials" | "legacy_token";
  // When the webhooks were registered. Null for a legacy token (no
  // webhooks) and when Shopify refused them (see warning).
  webhooksRegisteredAt: number | null;
};

export type SaveConnectionResult =
  // Bad input, or no Shopify store at the address (400).
  | { kind: "invalid"; error: string }
  // Shopify refused the token, or the token cannot read orders (422).
  | { kind: "rejected"; error: string }
  // The workspace already has orders and the domain names another store (409).
  | { kind: "store-change"; error: string }
  // Shopify could not be reached or answered with an error (502).
  | { kind: "unreachable"; error: string }
  // warning: saved, but the webhooks could not be registered.
  | { kind: "saved"; connection: ConnectionView; warning?: string };

const TOKEN_REJECTED = "Shopify rejected this token";
const MINTED_TOKEN_REJECTED = "Shopify rejected the access token it issued for this app";
const STORE_CHANGE_REFUSED =
  "This workspace already has orders from another store. Create a new workspace for a different store.";
const BOTH_MODES =
  "Enter either an Admin API access token or a Client ID and secret, not both";
const NO_STORE = "No Shopify store at this address";

// What the two-way sync needs (platform amendment section 3): reading and
// tagging orders, reading the tagged customers, and fulfilling orders. A
// write scope implies its read scope (Shopify may list only the write
// handle), so read_orders is satisfied by write_orders and so on.
// read_all_orders only widens the order window past 60 days, so it is
// optional and never stands in for read_orders.
export const REQUIRED_SCOPES = [
  "read_orders",
  "write_orders",
  "read_customers",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
] as const;

export function missingScopes(granted: readonly string[]): string[] {
  const has = new Set(granted);
  return REQUIRED_SCOPES.filter(
    (scope) => !(has.has(scope) || (scope.startsWith("read_") && has.has("write_" + scope.slice("read_".length)))),
  );
}

function missingScopesMessage(missing: string[]): string {
  return `The Shopify app is missing these permissions: ${missing.join(", ")}. Add them to the app's access scopes, approve the new version on the store, and connect again.`;
}

function credentialsRejected(detail: string): string {
  return `Shopify rejected this Client ID and secret (${detail}). Check them in the Dev Dashboard and make sure the app is installed on this store.`;
}

function webhooksWarning(detail: string): string {
  return `Connected, but Shopify did not accept the webhooks (${detail}). Orders still sync every 10 minutes; connect again to retry live updates.`;
}

export type ConnectionContext = {
  workspaceId: string;
  encryptionKey: string;
  // The platform origin webhook callbacks are built from (env.APP_URL).
  appUrl?: string;
  fetchImpl?: typeof fetch;
  // Injectable clock for tests.
  now?: () => number;
};

function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

// The innermost cause's message. drizzle wraps a failed query in an error
// whose message lists the bound params (the ciphertext among them); the
// driver error underneath it does not, so that is the one worth keeping.
function failureReason(e: unknown): string {
  let current = e;
  for (let depth = 0; depth < 10 && current instanceof Error && current.cause instanceof Error; depth++) {
    current = current.cause;
  }
  const message = current instanceof Error ? current.message : "";
  return message.length > 0 && !message.startsWith("Failed query:")
    ? message
    : "unexpected database error";
}

// Whether the workspace's stored connection names a different shop while
// the workspace already has orders: the one change saveConnection refuses.
async function storeChangeBlocked(db: Db, workspaceId: string, shopDomain: string) {
  const rows = await db
    .select({ shopDomain: storeConnections.shopDomain })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  if (!rows[0] || rows[0].shopDomain === shopDomain) {
    return false;
  }
  const anyOrder = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.workspaceId, workspaceId))
    .limit(1);
  return anyOrder.length > 0;
}

// The credentials a save carries, after input validation.
type Credentials =
  | { mode: "legacy_token"; token: string }
  | { mode: "client_credentials"; clientId: string; clientSecret: string };

function parseCredentials(fields: Record<string, unknown>): Credentials | { error: string } {
  const wantsClientCredentials = fields.clientId !== undefined || fields.clientSecret !== undefined;
  if (wantsClientCredentials && fields.token !== undefined) {
    return { error: BOTH_MODES };
  }
  if (!wantsClientCredentials) {
    const token = normalizeToken(fields.token);
    return token === null
      ? { error: `Paste the Admin API access token: 1 to ${TOKEN_MAX} characters, no spaces` }
      : { mode: "legacy_token", token };
  }
  const clientId = normalizeToken(fields.clientId);
  if (clientId === null) {
    return { error: `Paste the app's Client ID: 1 to ${TOKEN_MAX} characters, no spaces` };
  }
  const clientSecret = normalizeToken(fields.clientSecret);
  if (clientSecret === null) {
    return { error: `Paste the app's Client secret: 1 to ${TOKEN_MAX} characters, no spaces` };
  }
  return { mode: "client_credentials", clientId, clientSecret };
}

// Verifies the credentials with Shopify, then upserts the connection.
// Nothing is written unless Shopify accepted them and they carry every
// scope in REQUIRED_SCOPES (a 422 names each missing one).
//
// Body {shopDomain, token} (legacy_token) or {shopDomain, clientId,
// clientSecret} (client_credentials). For client credentials the app first
// mints an access token (which also proves the app is installed and the
// secret is right), then verifies that token like a legacy one.
//
// A workspace is one business with one store: once it has orders, a save
// that names another shop is refused and nothing changes. A changed domain
// on a workspace with no orders, or new credentials for the same domain
// (either mode), is saved. A disconnected (disabled) row counts as the
// workspace's store for this rule, and a successful save re-enables it.
//
// The row describes one mode only: a save writes that mode's fields and
// clears the other's, and records the verified shop name and scopes.
//
// On save the connection is marked ok with no last error. A new row, or a
// row whose shop domain changed, also starts over: lastSyncAt 0, no sync
// cursor and no order history import, so the next sync opens a fresh
// first-sync window for that store. A credentials-only change keeps
// lastSyncAt, any cursor and any import (which carries on next tick). Either way the
// sync lease is released (runningUntil 0). What that buys: a run still
// holding the lease started under the old settings, so its fenced
// connection writes (lastSyncAt, cursor, status) match nothing from here on,
// and it re-checks the lease after its fetch, between existence chunks and
// before its write loop, returning superseded without writing orders once
// it sees the change. What it does not buy: a run already inside its write
// loop finishes that loop (see the fence comment in src/server/sync/run.ts).
//
// One statement decides: whether the shop changed, and whether the
// workspace has orders, are both evaluated inside the upsert against the
// tables as they are at write time (the setWhere below), so no concurrent
// save, delete or first synced order can slip between a read and the write.
// storeChangeBlocked runs first only to refuse early, without sending the
// credentials to Shopify for a change that would be refused anyway.
//
// After a client-credentials save the webhooks are registered (replacing
// this workspace's earlier subscriptions) and webhooks_registered_at is
// set. If Shopify refuses them the connection stays saved (the cron sync
// still runs) with webhooks_registered_at null, and the result carries a
// warning saying so.
export async function saveConnection(
  db: Db,
  ctx: ConnectionContext,
  body: unknown,
): Promise<SaveConnectionResult> {
  const fields = isRecord(body) ? body : {};
  const shopDomain = normalizeShopDomain(fields.shopDomain);
  if (shopDomain === null) {
    return { kind: "invalid", error: DOMAIN_ERROR };
  }
  const credentials = parseCredentials(fields);
  if ("error" in credentials) {
    return { kind: "invalid", error: credentials.error };
  }

  if (await storeChangeBlocked(db, ctx.workspaceId, shopDomain)) {
    return { kind: "store-change", error: STORE_CHANGE_REFUSED };
  }

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const now = ctx.now?.() ?? Date.now();

  // The token the verification runs with: the legacy token itself, or one
  // minted from the client credentials.
  let accessToken: string;
  let accessTokenExpiresAt: number | null = null;
  if (credentials.mode === "client_credentials") {
    const minted = await mintAccessToken(shopDomain, credentials.clientId, credentials.clientSecret, fetchImpl);
    if (minted.kind === "rejected") {
      return { kind: "rejected", error: credentialsRejected(minted.detail) };
    }
    if (minted.kind === "no-store") {
      return { kind: "invalid", error: NO_STORE };
    }
    if (minted.kind !== "ok") {
      // minted.detail is secret-free by mintAccessToken's contract.
      return { kind: "unreachable", error: `Could not verify the connection: ${minted.detail}` };
    }
    accessToken = minted.accessToken;
    accessTokenExpiresAt = now + minted.expiresInSeconds * 1000;
  } else {
    accessToken = credentials.token;
  }

  const check = await testShopConnection(shopDomain, accessToken, fetchImpl);
  if (check.kind === "auth") {
    return {
      kind: "rejected",
      error: credentials.mode === "client_credentials" ? MINTED_TOKEN_REJECTED : TOKEN_REJECTED,
    };
  }
  if (check.kind === "no-store") {
    return { kind: "invalid", error: NO_STORE };
  }
  if (check.kind !== "ok") {
    // check.detail is token-free by testShopConnection's contract.
    return { kind: "unreachable", error: `Could not verify the connection: ${check.detail}` };
  }
  const missing = missingScopes(check.accessScopes);
  if (missing.length > 0) {
    return { kind: "rejected", error: missingScopesMessage(missing) };
  }

  const secrets: Array<string | undefined> = [
    accessToken,
    credentials.mode === "client_credentials" ? credentials.clientSecret : undefined,
  ];
  let encryptedClientSecret: string | null = null;
  try {
    let modeFields: Partial<typeof storeConnections.$inferInsert> & { encryptedToken: string };
    if (credentials.mode === "client_credentials") {
      encryptedClientSecret = await encryptSecret(credentials.clientSecret, ctx.encryptionKey, ctx.workspaceId);
      const encryptedAccessToken = await encryptSecret(accessToken, ctx.encryptionKey, ctx.workspaceId);
      secrets.push(encryptedClientSecret, encryptedAccessToken);
      modeFields = {
        authMode: "client_credentials",
        // The column cannot be null; empty in this mode (as after a
        // disconnect).
        encryptedToken: "",
        clientId: credentials.clientId,
        encryptedClientSecret,
        encryptedAccessToken,
        accessTokenExpiresAt,
      };
    } else {
      const encryptedToken = await encryptSecret(accessToken, ctx.encryptionKey, ctx.workspaceId);
      secrets.push(encryptedToken);
      modeFields = {
        authMode: "legacy_token",
        encryptedToken,
        clientId: null,
        encryptedClientSecret: null,
        encryptedAccessToken: null,
        accessTokenExpiresAt: null,
      };
    }
    const savedFields = {
      ...modeFields,
      scopes: check.accessScopes,
      shopName: check.shopName,
      // Set again below once this save's webhooks are registered.
      webhooksRegisteredAt: null,
    };
    const sameShop = sql`${storeConnections.shopDomain} = excluded.shop_domain`;
    const noOrders = sql`not exists (select 1 from ${orders} where ${orders.workspaceId} = ${ctx.workspaceId})`;
    const rows = await db
      .insert(storeConnections)
      .values({
        workspaceId: ctx.workspaceId,
        shopDomain,
        ...savedFields,
        status: "ok",
        lastError: null,
        lastSyncAt: 0,
        runningUntil: 0,
        syncCursor: null,
        syncCursorSince: null,
      })
      .onConflictDoUpdate({
        target: storeConnections.workspaceId,
        // Every expression here sees the row as it was before this write.
        set: {
          shopDomain,
          ...savedFields,
          status: "ok",
          lastError: null,
          runningUntil: 0,
          lastSyncAt: sql`case when ${sameShop} then ${storeConnections.lastSyncAt} else 0 end`,
          syncCursor: sql`case when ${sameShop} then ${storeConnections.syncCursor} else null end`,
          syncCursorSince: sql`case when ${sameShop} then ${storeConnections.syncCursorSince} else null end`,
          // An order history import (src/server/sync/backfill.ts) belongs to
          // its store: another store starts with none.
          backfillStatus: sql`case when ${sameShop} then ${storeConnections.backfillStatus} else null end`,
          backfillSince: sql`case when ${sameShop} then ${storeConnections.backfillSince} else null end`,
          backfillCursor: sql`case when ${sameShop} then ${storeConnections.backfillCursor} else null end`,
          backfillImported: sql`case when ${sameShop} then ${storeConnections.backfillImported} else 0 end`,
          backfillStartedAt: sql`case when ${sameShop} then ${storeConnections.backfillStartedAt} else null end`,
          backfillFinishedAt: sql`case when ${sameShop} then ${storeConnections.backfillFinishedAt} else null end`,
          backfillError: sql`case when ${sameShop} then ${storeConnections.backfillError} else null end`,
        },
        // An existing row is only updated for the same shop, or for another
        // shop while the workspace has no orders. Otherwise the update is
        // skipped and RETURNING yields no row. (A new row is always inserted:
        // with no stored connection there is no other store to protect.)
        setWhere: sql`${sameShop} or ${noOrders}`,
      })
      .returning({ lastSyncAt: storeConnections.lastSyncAt, lastError: storeConnections.lastError });
    const saved = rows[0];
    if (!saved) {
      return { kind: "store-change", error: STORE_CHANGE_REFUSED };
    }

    let webhooksRegisteredAt: number | null = null;
    let warning: string | undefined;
    if (credentials.mode === "client_credentials" && encryptedClientSecret !== null) {
      if (!ctx.appUrl) {
        warning = webhooksWarning("the app has no APP_URL to receive them");
      } else {
        const registered = await replaceWebhookSubscriptions(
          shopDomain,
          accessToken,
          webhookCallbackUrl(ctx.appUrl, ctx.workspaceId),
          fetchImpl,
        );
        if (registered.kind === "ok") {
          // Only on the row this save wrote: a newer save of other
          // credentials in between keeps its own state.
          await db
            .update(storeConnections)
            .set({ webhooksRegisteredAt: now })
            .where(
              and(
                eq(storeConnections.workspaceId, ctx.workspaceId),
                eq(storeConnections.encryptedClientSecret, encryptedClientSecret),
              ),
            );
          webhooksRegisteredAt = now;
        } else {
          warning = webhooksWarning(redact(failureText(registered), secrets));
        }
      }
    }

    return {
      kind: "saved",
      connection: {
        shopDomain,
        status: "ok",
        lastSyncAt: saved.lastSyncAt,
        lastError: saved.lastError,
        shopName: check.shopName,
        authMode: credentials.mode,
        webhooksRegisteredAt,
      },
      ...(warning ? { warning } : {}),
    };
  } catch (e) {
    // A fresh error with no cause chain and no params: whatever the route
    // logs from here carries no secret, token or ciphertext.
    throw new Error("Saving the store connection failed: " + redact(failureReason(e), secrets));
  }
}

// Disconnects the store by disabling its row rather than deleting it, so
// the one-store-per-workspace rule (saveConnection) still knows which store
// this workspace's orders came from. Every stored secret is cleared (the
// token column cannot be null, so it becomes empty), the last error goes,
// and the sync lease is released: a run in flight sees the lease change and
// writes nothing (see runSync), and the cron skips disabled rows. Sync
// progress (lastSyncAt, cursor) stays, so reconnecting the same store
// resumes where it left off. Orders and their history stay. A no-op for a
// workspace with no connection.
//
// It also takes away every access a Shopify tag gave in the workspace
// (clearShopifyAccess): with the store disconnected, neither the roster
// sync nor the customer webhooks run, so a removed tag could otherwise
// never revoke anything again. Manual members stay; tagged customers get
// their access back at the first roster sync after a reconnect. Answers
// the users whose membership went, for the caller to close their sockets.
// The store is disabled first: a roster write running at the same time
// then sees it disabled and takes back what it wrote (roster-sync.ts).
export async function deleteConnection(db: Db, workspaceId: string): Promise<{ revokedUserIds: string[] }> {
  await db
    .update(storeConnections)
    .set({
      status: "disabled",
      encryptedToken: "",
      encryptedClientSecret: null,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      // The webhook receiver refuses a disabled store's deliveries, so live
      // updates are off until the store is connected again.
      webhooksRegisteredAt: null,
      lastError: null,
      runningUntil: 0,
    })
    .where(eq(storeConnections.workspaceId, workspaceId));
  return { revokedUserIds: await clearShopifyAccess(db, workspaceId) };
}
