import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The domain routes for real against an in-memory database, on the hub;
// the session, routed host and env are stood in, and fetch is stubbed (the
// check never leaves the test).
const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = {
  db: null,
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com" },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async () => ({ api: { getSession: async () => state.session } }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { PUT, DELETE } = await import("./route");
const { POST: CHECK } = await import("./check/route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };

function put(body: unknown) {
  return new Request("https://orderingdesk.test/api/workspaces/ws_impact/domain", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedMember(db, "ws_impact", "u_manager", "manager");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function domainOf() {
  const [row] = await state.db!.select().from(schema.workspaces).where(eq(schema.workspaces.id, "ws_impact"));
  return { domain: row.customDomain, status: row.customDomainStatus };
}

describe("/api/workspaces/[id]/domain", () => {
  it("answers 401 signed out and 404 to a workspace manager, changing nothing", async () => {
    expect((await PUT(put({ domain: "orders.impactrentals.store" }), context)).status).toBe(401);
    state.session = { user: { id: "u_manager", email: "manager@example.com" } };
    expect((await PUT(put({ domain: "orders.impactrentals.store" }), context)).status).toBe(404);
    expect((await DELETE(new Request("https://x/"), context)).status).toBe(404);
    expect((await CHECK(new Request("https://x/"), context)).status).toBe(404);
    expect(await domainOf()).toEqual({ domain: null, status: null });
  });

  it("lets a platform admin save, check and clear a domain", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const saved = await PUT(put({ domain: "Orders.ImpactRentals.Store" }), context);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ domain: "orders.impactrentals.store", status: "pending" });

    const fetchStub = vi.fn(async () => Response.json({ ok: true, host: "orders.impactrentals.store" }));
    vi.stubGlobal("fetch", fetchStub);
    const checked = await CHECK(new Request("https://x/"), context);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ domain: "orders.impactrentals.store", status: "active", reason: null });
    expect(fetchStub).toHaveBeenCalledTimes(1);

    expect((await DELETE(new Request("https://x/"), context)).status).toBe(200);
    expect(await domainOf()).toEqual({ domain: null, status: null });
  });

  it("answers 400 for a bad domain and for a check with nothing saved", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const bad = await PUT(put({ domain: "https://orders.impactrentals.store" }), context);
    expect(bad.status).toBe(400);
    expect((await CHECK(new Request("https://x/"), context)).status).toBe(400);
  });
});
