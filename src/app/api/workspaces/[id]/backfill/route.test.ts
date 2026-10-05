import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The order history import routes for real against an in-memory database.
// Platform admins only, on the hub: everyone else gets 404.
const CLIENT_HOST = "orders.impactrentals.store";
const state: { db: Db | null; host: string; session: { user: { id: string; email: string } } | null } = {
  db: null,
  host: "orderingdesk.test",
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
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

const { GET, POST, DELETE } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const URL_BASE = "https://orderingdesk.test/api/workspaces/ws_impact/backfill";
const DAY = 24 * 60 * 60 * 1000;

function post(body: unknown) {
  return new Request(URL_BASE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const signIn = (id: string, email: string) => {
  state.session = { user: { id, email } };
};

async function backfillStatus() {
  const [row] = await state.db!.select().from(schema.storeConnections).where(eq(schema.storeConnections.workspaceId, "ws_impact"));
  return row.backfillStatus;
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.workspaces)
    .set({ customDomain: CLIENT_HOST, customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_manager", "manager");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await db.insert(schema.storeConnections).values({
    workspaceId: "ws_impact",
    shopDomain: "impactrentals.myshopify.com",
    encryptedToken: "v1.ciphertext",
    status: "ok",
    scopes: ["read_orders", "write_orders", "read_customers"],
  });
});

describe("/api/workspaces/[id]/backfill authorization", () => {
  it("answers 401 signed out", async () => {
    expect((await GET(new Request(URL_BASE), context)).status).toBe(401);
    expect((await POST(post({ range: "all" }), context)).status).toBe(401);
    expect((await DELETE(new Request(URL_BASE, { method: "DELETE" }), context)).status).toBe(401);
  });

  it("answers 404 to managers, staff and strangers, and starts nothing", async () => {
    for (const [id, email] of [
      ["u_manager", "manager@example.com"],
      ["u_staff", "staff@example.com"],
      ["u_stranger", "stranger@example.com"],
    ]) {
      signIn(id, email);
      expect((await GET(new Request(URL_BASE), context)).status).toBe(404);
      expect((await POST(post({ range: "since", since: Date.now() - 10 * DAY }), context)).status).toBe(404);
      expect((await DELETE(new Request(URL_BASE, { method: "DELETE" }), context)).status).toBe(404);
    }
    expect(await backfillStatus()).toBeNull();
  });

  it("answers 404 to a platform admin on the client host (platform powers stay on the hub)", async () => {
    state.host = CLIENT_HOST;
    signIn("u_boss", "boss@example.com");
    expect((await POST(post({ range: "since", since: Date.now() - 10 * DAY }), context)).status).toBe(404);
    expect(await backfillStatus()).toBeNull();
  });
});

describe("/api/workspaces/[id]/backfill for a platform admin", () => {
  beforeEach(() => signIn("u_boss", "boss@example.com"));

  it("starts, shows and cancels an import", async () => {
    const started = await POST(post({ range: "since", since: Date.now() - 10 * DAY }), context);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ backfill: { status: "running", imported: 0 } });

    const shown = await GET(new Request(URL_BASE), context);
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ backfill: { status: "running", canReadAllOrders: false } });

    expect((await POST(post({ range: "since", since: Date.now() - 10 * DAY }), context)).status).toBe(409);

    const cancelled = await DELETE(new Request(URL_BASE, { method: "DELETE" }), context);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ backfill: { status: "cancelled" } });
    expect((await DELETE(new Request(URL_BASE, { method: "DELETE" }), context)).status).toBe(409);
  });

  it("refuses all orders without read_all_orders with 422 and the fix, and bad input with 400", async () => {
    const refused = await POST(post({ range: "all" }), context);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain("read_all_orders");
    expect((await POST(post({ range: "since", since: "last year" }), context)).status).toBe(400);
    expect(await backfillStatus()).toBeNull();
  });

  it("answers 409 when the store is not connected", async () => {
    await state.db!.update(schema.storeConnections).set({ status: "disabled" });
    expect((await POST(post({ range: "since", since: Date.now() - 10 * DAY }), context)).status).toBe(409);
    await state.db!.delete(schema.storeConnections);
    expect((await GET(new Request(URL_BASE), context)).status).toBe(404);
  });
});
