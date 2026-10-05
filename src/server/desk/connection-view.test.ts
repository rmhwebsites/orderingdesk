import { describe, it, expect } from "vitest";
import * as schema from "@/db/schema";
import { getConnectionSettings } from "./connection-view";
import { openTestDb, seedWorkspace } from "./test-helpers";

const WS = "ws_impact";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  return db;
}

describe("getConnectionSettings", () => {
  it("is null without a connection", async () => {
    expect(await getConnectionSettings(await setup(), WS)).toBeNull();
  });

  it("shows the store, mode, scopes with the missing ones named, webhooks and sync state, never a secret", async () => {
    const db = await setup();
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impact-rentals.myshopify.com",
      shopName: "IMPACT Rentals",
      encryptedToken: "",
      authMode: "client_credentials",
      clientId: "client-id-visible-to-nobody",
      encryptedClientSecret: "v1.cipher-secret",
      encryptedAccessToken: "v1.cipher-token",
      accessTokenExpiresAt: 5000,
      scopes: ["write_orders", "read_customers"],
      webhooksRegisteredAt: 1234,
      status: "error",
      lastSyncAt: 900,
      lastError: "Shopify answered 401",
      syncCursor: "100|abc",
    });
    const view = await getConnectionSettings(db, WS);
    expect(view).toEqual({
      shopDomain: "impact-rentals.myshopify.com",
      shopName: "IMPACT Rentals",
      authMode: "client_credentials",
      status: "error",
      scopes: ["write_orders", "read_customers"],
      // write_orders covers read_orders.
      missingScopes: ["read_merchant_managed_fulfillment_orders", "write_merchant_managed_fulfillment_orders"],
      // Draft orders need the draft scopes (draft orders spec section 14).
      draftsEnabled: false,
      missingDraftScopes: ["read_draft_orders", "write_draft_orders"],
      webhooksRegisteredAt: 1234,
      lastSyncAt: 900,
      lastError: "Shopify answered 401",
      catchingUp: true,
      backfill: {
        status: "idle",
        since: null,
        imported: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        paused: null,
        canReadAllOrders: false,
      },
    });
    const text = JSON.stringify(view);
    for (const secret of ["cipher", "client-id-visible-to-nobody"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reports unknown scopes (an older connection) as null with nothing named missing", async () => {
    const db = await setup();
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impact-rentals.myshopify.com",
      encryptedToken: "v1.cipher",
      status: "disabled",
    });
    expect(await getConnectionSettings(db, WS)).toMatchObject({
      authMode: "legacy_token",
      status: "disabled",
      scopes: null,
      missingScopes: [],
      shopName: null,
      catchingUp: false,
    });
  });

  it("shows a running order history import, paused while the regular sync catches up", async () => {
    const db = await setup();
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impact-rentals.myshopify.com",
      encryptedToken: "v1.cipher",
      scopes: ["write_orders", "read_all_orders"],
      syncCursor: "100|abc",
      backfillStatus: "running",
      backfillSince: 5000,
      backfillCursor: "cursor-not-shown",
      backfillImported: 140,
      backfillStartedAt: 9000,
      backfillError: "Shopify responded with HTTP 503",
    });
    const view = await getConnectionSettings(db, WS);
    expect(view?.backfill).toEqual({
      status: "running",
      since: 5000,
      imported: 140,
      startedAt: 9000,
      finishedAt: null,
      error: "Shopify responded with HTTP 503",
      paused: "sync",
      canReadAllOrders: true,
    });
    expect(JSON.stringify(view)).not.toContain("cursor-not-shown");
  });
});
