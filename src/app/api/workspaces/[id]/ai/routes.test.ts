import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "u_admin@example.com" },
    ctx: { waitUntil: () => {} },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const settings = await import("./route");
const connection = await import("./connections/[grantId]/route");
const all = await import("./revoke-all/route");

const WS = "ws_impact";
const ctx = { params: Promise.resolve({ id: WS }) };
const grantCtx = (grantId: string) => ({ params: Promise.resolve({ id: WS, grantId }) });
const as = (id: string) => {
  state.session = { user: { id, email: `${id}@example.com` } };
};
const json = (method: string, body?: unknown) =>
  new Request("https://orderingdesk.test/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, WS);
  for (const id of ["u_manager", "u_staff", "u_stranger", "u_admin"]) {
    await seedUser(db, id, `${id}@example.com`);
  }
  await seedMember(db, WS, "u_manager", "manager");
  await seedMember(db, WS, "u_staff", "staff");
  await db.insert(schema.aiGrants).values({
    id: "g_staff",
    workspaceId: WS,
    userId: "u_staff",
    host: "orderingdesk.test",
    clientId: "https://claude.ai/oauth/mcp-client",
    client: "claude",
    clientDomain: "claude.ai",
    redirectHost: "claude.ai",
    scopes: ["desk.read", "desk.write"],
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 86400000,
  });
});

describe("/api/workspaces/[id]/ai", () => {
  it("shows a member their AI connections and the address to add, 401 signed out, 404 outside", async () => {
    expect((await settings.GET(json("GET"), ctx)).status).toBe(401);
    as("u_stranger");
    expect((await settings.GET(json("GET"), ctx)).status).toBe(404);
    as("u_staff");
    const response = await settings.GET(json("GET"), ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ai: { mcpUrl: string; connections: { id: string }[] } };
    expect(body.ai.mcpUrl).toBe("https://orderingdesk.test/mcp");
    expect(body.ai.connections.map((entry) => entry.id)).toEqual(["g_staff"]);
  });

  it("saves limits for managers only (404 to staff)", async () => {
    as("u_staff");
    expect((await settings.PATCH(json("PATCH", { readsPerDay: 500 }), ctx)).status).toBe(404);
    as("u_manager");
    const saved = await settings.PATCH(json("PATCH", { readsPerDay: 500 }), ctx);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { ai: { limits: { readsPerDay: number } } }).ai.limits.readsPerDay).toBe(500);
    expect((await settings.PATCH(json("PATCH", { readsPerDay: 1 }), ctx)).status).toBe(400);
  });

  it("revokes a connection for its owner or a manager, and all of them for a platform admin", async () => {
    as("u_stranger");
    expect((await connection.DELETE(json("DELETE"), grantCtx("g_staff"))).status).toBe(404);
    as("u_staff");
    expect(await (await connection.DELETE(json("DELETE"), grantCtx("g_staff"))).json()).toEqual({ revoked: true });
    expect((await connection.DELETE(json("DELETE"), grantCtx("g_staff"))).status).toBe(404);
    as("u_manager");
    expect((await all.POST(json("POST"), ctx)).status).toBe(404);
    as("u_admin");
    expect(await (await all.POST(json("POST"), ctx)).json()).toEqual({ revoked: 0 });
  });
});
