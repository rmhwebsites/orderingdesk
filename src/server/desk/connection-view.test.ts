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
      webhooksRegisteredAt: 1234,
      lastSyncAt: 900,
      lastError: "Shopify answered 401",
      catchingUp: true,
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
});
