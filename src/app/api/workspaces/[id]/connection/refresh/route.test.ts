import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// Refresh connection (draft orders spec section 7.3): platform admins only,
// on the hub. Shopify is a stubbed global fetch.
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const state: { db: Db | null; session: { user: { id: string; email: string } } | null; after: Promise<unknown>[] } = {
  db: null,
  session: null,
  after: [],
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com", ENCRYPTION_KEY: KEY },
    ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));
vi.mock("@/server/sync/locations", () => ({ syncLocations: vi.fn(async () => ({ kind: "skipped", reason: "no-companies-scope" })) }));

const { POST } = await import("./route");
const { syncLocations } = await import("@/server/sync/locations");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const request = () => new Request("https://orderingdesk.test/api/workspaces/ws_impact/connection/refresh", { method: "POST" });
const SCOPES = [
  "read_orders",
  "write_orders",
  "read_customers",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "write_draft_orders",
];
const shopifyCalls: string[] = [];

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  shopifyCalls.length = 0;
  vi.mocked(syncLocations).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedMember(db, "ws_impact", "u_manager", "manager");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/admin/oauth/access_token")) {
      shopifyCalls.push("mint");
      return Response.json({ access_token: "shpat_route_minted", scope: "read_orders", expires_in: 86399 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    shopifyCalls.push(body.query.includes("currentAppInstallation") ? "verify" : body.query.includes("webhookSubscriptionCreate") ? "create" : "list");
    if (body.query.includes("currentAppInstallation")) {
      return Response.json({
        data: { shop: { name: "IMPACT Rentals" }, currentAppInstallation: { accessScopes: SCOPES.map((handle) => ({ handle })) } },
      });
    }
    if (body.query.includes("webhookSubscriptions(")) {
      return Response.json({ data: { webhookSubscriptions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    return Response.json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: "w1" }, userErrors: [] } } });
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connect(db: Db) {
  await db.insert(schema.storeConnections).values({
    workspaceId: "ws_impact",
    shopDomain: "impactrentals.myshopify.com",
    encryptedToken: "",
    authMode: "client_credentials",
    clientId: "client-id",
    encryptedClientSecret: await encryptSecret("shpss_route_secret", KEY, "ws_impact"),
    scopes: ["read_orders"],
  });
}

describe("POST /api/workspaces/[id]/connection/refresh", () => {
  it("answers 401 signed out and 404 to managers and staff, asking Shopify nothing", async () => {
    await connect(state.db!);
    expect((await POST(request(), context)).status).toBe(401);
    for (const [id, email] of [
      ["u_manager", "manager@example.com"],
      ["u_staff", "staff@example.com"],
    ]) {
      state.session = { user: { id, email } };
      expect((await POST(request(), context)).status).toBe(404);
    }
    expect(shopifyCalls).toEqual([]);
  });

  it("refreshes for a platform admin: new token, saved scopes, draft topics registered", async () => {
    await connect(state.db!);
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connection: { draftsEnabled: boolean; scopes: string[] }; warning?: string };
    expect(body.connection.draftsEnabled).toBe(true);
    expect(body.connection.scopes).toEqual(SCOPES);
    expect(body.warning).toBeUndefined();
    expect(shopifyCalls[0]).toBe("mint");
    expect(shopifyCalls.filter((call) => call === "create")).toHaveLength(13);
    const [row] = await state.db!.select().from(schema.storeConnections).where(eq(schema.storeConnections.workspaceId, "ws_impact"));
    expect(row.scopes).toEqual(SCOPES);
    expect(JSON.stringify(body)).not.toContain("shpat_route_minted");
    await Promise.all(state.after);
    // The store's company locations follow, after the response.
    expect(vi.mocked(syncLocations).mock.lastCall?.[2]).toBe("ws_impact");
  });

  it("answers 409 when no store is connected", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Connect the store first." });
    expect(syncLocations).not.toHaveBeenCalled();
  });
});
