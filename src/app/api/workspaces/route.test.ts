import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The route handlers run for real against an in-memory database; only the
// request context is stood in: the session (better-auth), the request
// headers (the routed hub host) and the Cloudflare env (APP_URL,
// PLATFORM_ADMIN_EMAILS).
const state: { db: Db | null; host: string; session: { user: { id: string; email: string } } | null } = {
  db: null,
  host: "orderingdesk.com",
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.com", PLATFORM_ADMIN_EMAILS: "boss@example.com" },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => state.session } }),
}));
vi.mock("@/db", () => ({
  getDb: () => state.db,
  getDbFromEnv: () => state.db,
}));

const { GET, POST } = await import("./route");

function postRequest(body: unknown) {
  return new Request("https://orderingdesk.com/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.com";
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_other");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_client", "client@example.com");
  await seedMember(db, "ws_impact", "u_client", "manager");
});

describe("POST /api/workspaces", () => {
  it("answers 401 when signed out and creates nothing", async () => {
    const response = await POST(postRequest({ name: "Sneaky" }));
    expect(response.status).toBe(401);
    expect(await state.db!.select().from(schema.workspaces)).toHaveLength(2);
  });

  it("answers a client (even a manager) with 404 and creates nothing", async () => {
    state.session = { user: { id: "u_client", email: "client@example.com" } };
    const response = await POST(postRequest({ name: "Second store" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(await state.db!.select().from(schema.workspaces)).toHaveLength(2);
  });

  it("lets a platform admin create a workspace", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const response = await POST(postRequest({ name: "New Client" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      workspace: { name: "New Client", slug: "new-client", role: "platform" },
    });
    expect(await state.db!.select().from(schema.workspaces)).toHaveLength(3);
  });

  // A tenant controls their client host's DNS, so platform powers answer
  // only on the hub (src/server/guard.ts).
  it("answers a platform admin on a client host with 404 and creates nothing", async () => {
    await state
      .db!.update(schema.workspaces)
      .set({ customDomain: "orders.impactrentals.store", customDomainStatus: "active" })
      .where(eq(schema.workspaces.id, "ws_impact"));
    state.host = "orders.impactrentals.store";
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const response = await POST(postRequest({ name: "Through the client host" }));
    expect(response.status).toBe(404);
    expect(await state.db!.select().from(schema.workspaces)).toHaveLength(2);
  });
});

describe("GET /api/workspaces", () => {
  it("lists only a client's own workspaces", async () => {
    state.session = { user: { id: "u_client", email: "client@example.com" } };
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspaces: Array<{ id: string; role: string }> };
    expect(body.workspaces.map((w) => [w.id, w.role])).toEqual([["ws_impact", "manager"]]);
  });

  it("lists every workspace for a platform admin", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const body = (await (await GET()).json()) as { workspaces: Array<{ id: string; role: string }> };
    expect(body.workspaces.map((w) => [w.id, w.role])).toEqual([
      ["ws_impact", "platform"],
      ["ws_other", "platform"],
    ]);
  });

  it("answers 401 when signed out", async () => {
    expect((await GET()).status).toBe(401);
  });
});
