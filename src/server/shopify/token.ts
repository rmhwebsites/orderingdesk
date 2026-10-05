// The access token for a workspace's store (platform amendment section 3).
// Relative imports on purpose: the sync engine and the cron path use this,
// and they are bundled into the custom worker entrypoint.
//
// legacy_token: the stored Admin API token, decrypted.
// client_credentials: a cached token (encrypted with aad = workspaceId,
// with its expiry) while it is good for more than RENEW_WITHIN_MS; otherwise
// a new one minted from the stored Client ID and secret and cached.
//
// Two runs can renew at once (a webhook and the cron, in two isolates). Both
// mint, and Shopify keeps both tokens valid until they expire, so neither
// run is ever handed a dead token. Exactly one renewal is cached: the cache
// write is a compare-and-set on the cached ciphertext the run started from
// (and on the credentials, the mode and the row still being enabled), and
// token and expiry are written by the same statement, so the cache never
// holds one run's token with another run's expiry. A run that loses the
// race uses the winner's cached token. A disconnect or reconnect while a
// token is being minted makes the write match nothing, so a token minted
// from old credentials is never cached over new ones.
//
// Nothing here returns, logs or throws the secret, the token or a
// ciphertext; failures are reported as kinds with Shopify's own detail.

import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../../db";
import { rowsAffected } from "../../db/batch";
import { storeConnections } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { mintAccessToken } from "./client";

// A cached token that expires within this window is renewed first.
export const RENEW_WITHIN_MS = 10 * 60 * 1000;

export type AccessTokenResult =
  | { kind: "ok"; token: string; shopDomain: string }
  | { kind: "unavailable"; reason: "no-connection" | "disabled" }
  // The stored token, Client ID or secret is missing or does not decrypt.
  | { kind: "unreadable" }
  // Shopify refused the Client ID and secret (detail in Shopify's words).
  | { kind: "rejected"; detail: string }
  | { kind: "transient"; detail: string };

export type AccessTokenOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  // client_credentials: ignore the cached token and mint a new one (cached
  // through the same compare-and-set), so it carries scopes approved since
  // the cached one was minted (Refresh connection). No effect on a legacy
  // token.
  forceRenew?: boolean;
};

// The columns this module reads. Callers that already hold the whole
// connection row (runSync) pass it straight to accessTokenFor.
export type CredentialRow = Pick<
  typeof storeConnections.$inferSelect,
  | "workspaceId"
  | "shopDomain"
  | "status"
  | "authMode"
  | "encryptedToken"
  | "clientId"
  | "encryptedClientSecret"
  | "encryptedAccessToken"
  | "accessTokenExpiresAt"
>;

async function readCredentials(db: Db, workspaceId: string): Promise<CredentialRow | undefined> {
  const rows = await db
    .select({
      workspaceId: storeConnections.workspaceId,
      shopDomain: storeConnections.shopDomain,
      status: storeConnections.status,
      authMode: storeConnections.authMode,
      encryptedToken: storeConnections.encryptedToken,
      clientId: storeConnections.clientId,
      encryptedClientSecret: storeConnections.encryptedClientSecret,
      encryptedAccessToken: storeConnections.encryptedAccessToken,
      accessTokenExpiresAt: storeConnections.accessTokenExpiresAt,
    })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  return rows[0];
}

async function tryDecrypt(payload: string | null, key: string, aad: string): Promise<string | null> {
  if (!payload) {
    return null;
  }
  try {
    const plain = await decryptSecret(payload, key, aad);
    return plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}

// The cached token when it is good beyond the renewal window and decrypts.
async function usableCached(row: CredentialRow, key: string, now: number): Promise<string | null> {
  if (row.accessTokenExpiresAt === null || row.accessTokenExpiresAt <= now + RENEW_WITHIN_MS) {
    return null;
  }
  return tryDecrypt(row.encryptedAccessToken, key, row.workspaceId);
}

export async function getAccessToken(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  opts?: AccessTokenOptions,
): Promise<AccessTokenResult> {
  const row = await readCredentials(db, workspaceId);
  if (!row) {
    return { kind: "unavailable", reason: "no-connection" };
  }
  return accessTokenFor(db, env, row, opts);
}

export async function accessTokenFor(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  row: CredentialRow,
  opts?: AccessTokenOptions,
): Promise<AccessTokenResult> {
  if (row.status === "disabled") {
    return { kind: "unavailable", reason: "disabled" };
  }
  const key = env.ENCRYPTION_KEY;
  if (row.authMode === "legacy_token") {
    const token = await tryDecrypt(row.encryptedToken, key, row.workspaceId);
    return token ? { kind: "ok", token, shopDomain: row.shopDomain } : { kind: "unreadable" };
  }
  const now = opts?.now?.() ?? Date.now();
  const cached = opts?.forceRenew === true ? null : await usableCached(row, key, now);
  if (cached) {
    return { kind: "ok", token: cached, shopDomain: row.shopDomain };
  }
  return renew(db, key, row, now, opts?.fetchImpl ?? fetch);
}

async function renew(
  db: Db,
  key: string,
  row: CredentialRow,
  now: number,
  fetchImpl: typeof fetch,
): Promise<AccessTokenResult> {
  const secret = row.clientId ? await tryDecrypt(row.encryptedClientSecret, key, row.workspaceId) : null;
  if (!row.clientId || !secret || !row.encryptedClientSecret) {
    return { kind: "unreadable" };
  }
  const minted = await mintAccessToken(row.shopDomain, row.clientId, secret, fetchImpl);
  switch (minted.kind) {
    case "rejected":
      return { kind: "rejected", detail: minted.detail };
    case "no-store":
      return { kind: "rejected", detail: `No Shopify store answers at ${row.shopDomain}` };
    case "transient":
    case "fatal":
      return { kind: "transient", detail: minted.detail };
  }

  // The expiry counts from before the request, so it can only be early.
  const expiresAt = now + minted.expiresInSeconds * 1000;
  const ciphertext = await encryptSecret(minted.accessToken, key, row.workspaceId);
  const result = await db
    .update(storeConnections)
    .set({ encryptedAccessToken: ciphertext, accessTokenExpiresAt: expiresAt })
    .where(
      and(
        eq(storeConnections.workspaceId, row.workspaceId),
        ne(storeConnections.status, "disabled"),
        eq(storeConnections.authMode, "client_credentials"),
        eq(storeConnections.shopDomain, row.shopDomain),
        eq(storeConnections.encryptedClientSecret, row.encryptedClientSecret),
        row.encryptedAccessToken === null
          ? isNull(storeConnections.encryptedAccessToken)
          : eq(storeConnections.encryptedAccessToken, row.encryptedAccessToken),
      ),
    );
  if (rowsAffected(result, "shopify-token") === 1) {
    return { kind: "ok", token: minted.accessToken, shopDomain: row.shopDomain };
  }

  // Someone else wrote the row since it was read: another renewal, a
  // reconnect or a disconnect.
  const fresh = await readCredentials(db, row.workspaceId);
  if (!fresh) {
    return { kind: "unavailable", reason: "no-connection" };
  }
  if (fresh.status === "disabled") {
    return { kind: "unavailable", reason: "disabled" };
  }
  if (fresh.authMode !== "client_credentials" || fresh.shopDomain !== row.shopDomain) {
    return { kind: "transient", detail: "The store connection changed while its token was renewed" };
  }
  const winner = await usableCached(fresh, key, now);
  // No usable winner (it cannot be read): this run's token is still valid
  // for its own work, just not cached.
  return { kind: "ok", token: winner ?? minted.accessToken, shopDomain: fresh.shopDomain };
}
