import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null; host: string } = {
  db: null,
  session: null,
  host: "orderingdesk.test",
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com" },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET } = await import("./route");
const { POST: SEEN } = await import("../seen/route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.host = "orderingdesk.test";
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_client");
  await db
    .update(schema.workspaces)
    .set({ customDomain: "orders.client.example", customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_client"));
  await seedOrder(db, "ws_impact", { id: "o1", name: "#1001" });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_other", "other@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_impact", "u_other", "manager");
  await db.insert(schema.events).values({
    id: "e1",
    workspaceId: "ws_impact",
    orderId: "o1",
    type: "note",
    text: "Called the customer",
    actorId: "u_other",
    createdAt: Date.now() - 1000,
    source: "app",
  });
});

describe("GET /api/workspaces/[id]/activity", () => {
  it("answers 401 signed out and 404 to a non-member", async () => {
    expect((await GET(new Request("https://x/"), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await GET(new Request("https://x/"), context)).status).toBe(404);
  });

  it("answers 404 for a workspace other than a client host's own", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    state.host = "orders.client.example";
    expect((await GET(new Request("https://x/"), context)).status).toBe(404);
  });

  it("gives a member the feed and their unread count", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const body = (await (await GET(new Request("https://x/"), context)).json()) as { unread: number; items: Array<{ id: string; orderName: string }> };
    expect(body.unread).toBe(1);
    expect(body.items.map((item) => [item.id, item.orderName])).toEqual([["e1", "#1001"]]);
  });

  it("gives a platform admin who is not a member the feed without a count", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const body = (await (await GET(new Request("https://x/"), context)).json()) as { unread: number | null; items: unknown[] };
    expect(body.unread).toBeNull();
    expect(body.items).toHaveLength(1);
  });
});

describe("POST /api/workspaces/[id]/seen", () => {
  it("answers 401 signed out and 404 to a non-member or a platform admin who is not a member", async () => {
    expect((await SEEN(new Request("https://x/", { method: "POST" }), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await SEEN(new Request("https://x/", { method: "POST" }), context)).status).toBe(404);
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    expect((await SEEN(new Request("https://x/", { method: "POST" }), context)).status).toBe(404);
  });

  it("marks everything read for the member", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const marked = await SEEN(new Request("https://x/", { method: "POST" }), context);
    expect(marked.status).toBe(200);
    const { lastSeenAt } = (await marked.json()) as { lastSeenAt: number };
    expect(lastSeenAt).toBeGreaterThan(Date.now() - 5000);
    const body = (await (await GET(new Request("https://x/"), context)).json()) as { unread: number };
    expect(body.unread).toBe(0);
  });
});
