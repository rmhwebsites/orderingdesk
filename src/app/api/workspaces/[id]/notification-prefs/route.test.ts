import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com" },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET, PUT } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const put = (body: unknown) =>
  new Request("https://orderingdesk.test/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("/api/workspaces/[id]/notification-prefs", () => {
  it("answers 401 signed out and 404 to a non-member", async () => {
    expect((await GET(new Request("https://x/"), context)).status).toBe(401);
    expect((await PUT(put({ pushAllActivity: true }), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await GET(new Request("https://x/"), context)).status).toBe(404);
    expect((await PUT(put({ pushAllActivity: true }), context)).status).toBe(404);
    expect(await state.db!.select().from(schema.notificationPrefs)).toEqual([]);
  });

  it("lets any member read and change their own choices", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    expect(await (await GET(new Request("https://x/"), context)).json()).toEqual({
      member: true,
      prefs: { pushNewOrders: true, emailNewOrders: true, pushAllActivity: false },
    });
    const saved = await PUT(put({ pushAllActivity: true, emailNewOrders: false }), context);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ prefs: { pushNewOrders: true, emailNewOrders: false, pushAllActivity: true } });
    const rows = await state.db!.select().from(schema.notificationPrefs);
    expect(rows).toEqual([expect.objectContaining({ userId: "u_staff", workspaceId: "ws_impact", pushAllActivity: true })]);
  });

  it("answers 400 for a body with nothing to save", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    expect((await PUT(put({ pushAllActivity: "on" }), context)).status).toBe(400);
  });

  it("shows a platform admin who is not a member that nothing notifies them, and saves nothing for them", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    expect(await (await GET(new Request("https://x/"), context)).json()).toMatchObject({ member: false });
    expect((await PUT(put({ pushAllActivity: true }), context)).status).toBe(404);
  });
});
