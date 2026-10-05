// Refresh connection (draft orders spec section 7.3), behind POST
// /api/workspaces/[id]/connection/refresh (platform admins only). After a
// platform admin approves a new version of the store's Shopify app (new
// scopes, such as the draft order ones), this re-reads the granted scopes
// with a freshly minted token, stores them, and registers the webhooks for
// them, without asking for the credentials again. The first sync after
// draft orders become enabled runs the first draft sync by itself.
// Like saveConnection, no secret, token or ciphertext is ever returned,
// logged or put into an error.

import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { storeConnections } from "@/db/schema";
import { failureText, replaceWebhookSubscriptions, webhookCallbackUrl, webhookTopicsFor } from "@/server/shopify/admin";
import { testShopConnection } from "@/server/shopify/client";
import { getAccessToken } from "@/server/shopify/token";
import { missingScopes, type ConnectionContext } from "./connection";
import { getConnectionSettings, type ConnectionSettingsView } from "./connection-view";

export type RefreshConnectionResult =
  // No store connected, or it was disconnected (409).
  | { kind: "no-connection"; error: string }
  // Shopify refused the stored credentials (409).
  | { kind: "rejected"; error: string }
  // Shopify could not be reached or answered with an error (502).
  | { kind: "unreachable"; error: string }
  // warning: refreshed, but a required scope is missing or the webhooks
  // were not registered.
  | { kind: "refreshed"; connection: ConnectionSettingsView; warning?: string };

const NO_CONNECTION = "Connect the store first.";
const CREDENTIALS_REJECTED = "Shopify rejected the store credentials. Reconnect the store in Settings.";
const CREDENTIALS_UNREADABLE = "The store credentials cannot be read. Reconnect the store in Settings.";

function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => (secret.length > 0 ? out.split(secret).join("[redacted]") : out), text);
}

export async function refreshConnection(db: Db, ctx: ConnectionContext): Promise<RefreshConnectionResult> {
  const rows = await db
    .select({
      status: storeConnections.status,
      shopDomain: storeConnections.shopDomain,
      authMode: storeConnections.authMode,
      encryptedClientSecret: storeConnections.encryptedClientSecret,
    })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, ctx.workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row || row.status === "disabled") {
    return { kind: "no-connection", error: NO_CONNECTION };
  }
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const clock = ctx.now ?? Date.now;

  // client_credentials: a new token, so it carries the scopes approved
  // since the cached one was minted. legacy_token: the stored token.
  const access = await getAccessToken(
    db,
    { ENCRYPTION_KEY: ctx.encryptionKey },
    ctx.workspaceId,
    { fetchImpl, now: clock, forceRenew: row.authMode === "client_credentials" },
  );
  switch (access.kind) {
    case "unavailable":
      return { kind: "no-connection", error: NO_CONNECTION };
    case "unreadable":
      return { kind: "rejected", error: CREDENTIALS_UNREADABLE };
    case "rejected":
      return { kind: "rejected", error: CREDENTIALS_REJECTED };
    case "transient":
      return { kind: "unreachable", error: `Could not refresh the connection: ${access.detail}` };
  }
  const secrets = [access.token];

  const check = await testShopConnection(access.shopDomain, access.token, fetchImpl);
  if (check.kind === "auth" || check.kind === "no-store") {
    return { kind: "rejected", error: CREDENTIALS_REJECTED };
  }
  if (check.kind !== "ok") {
    return { kind: "unreachable", error: `Could not refresh the connection: ${redact(check.detail, secrets)}` };
  }

  // Only on the store the check ran against, while it is still connected.
  // The store's own myshopify domain too: Shopify names the store by it on
  // webhooks, and a store connected under an alias (IMPACT) has its
  // deliveries accepted from here on.
  await db
    .update(storeConnections)
    .set({ scopes: check.accessScopes, shopName: check.shopName, canonicalShopDomain: check.myshopifyDomain })
    .where(
      and(
        eq(storeConnections.workspaceId, ctx.workspaceId),
        eq(storeConnections.shopDomain, access.shopDomain),
        ne(storeConnections.status, "disabled"),
      ),
    );

  const warnings: string[] = [];
  const missing = missingScopes(check.accessScopes);
  if (missing.length > 0) {
    warnings.push(`The Shopify app is missing these permissions: ${missing.join(", ")}. The store stays connected.`);
  }
  if (row.authMode === "client_credentials") {
    if (!ctx.appUrl) {
      warnings.push("Webhooks were not registered: the app has no APP_URL to receive them");
    } else {
      const registered = await replaceWebhookSubscriptions(
        access.shopDomain,
        access.token,
        webhookCallbackUrl(ctx.appUrl, ctx.workspaceId),
        webhookTopicsFor(check.accessScopes),
        fetchImpl,
      );
      if (registered.kind === "ok") {
        // Only on the credentials this refresh ran with: a reconnect in
        // between keeps its own state.
        await db
          .update(storeConnections)
          .set({ webhooksRegisteredAt: clock() })
          .where(
            and(
              eq(storeConnections.workspaceId, ctx.workspaceId),
              eq(storeConnections.shopDomain, access.shopDomain),
              ne(storeConnections.status, "disabled"),
              row.encryptedClientSecret === null
                ? eq(storeConnections.authMode, "client_credentials")
                : eq(storeConnections.encryptedClientSecret, row.encryptedClientSecret),
            ),
          );
      } else {
        warnings.push(`Webhooks were not registered: ${redact(failureText(registered), secrets)}`);
      }
    }
  }

  const connection = await getConnectionSettings(db, ctx.workspaceId);
  if (!connection) {
    return { kind: "no-connection", error: NO_CONNECTION };
  }
  return { kind: "refreshed", connection, ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}) };
}
