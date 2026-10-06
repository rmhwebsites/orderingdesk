import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedDraft, seedDraftStatuses, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: { waitUntil: () => {} } }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET } = await import("./route");
const context = { params: Promise.resolve({ id: "ws_impact" }) };
const get = () => new Request("https://orderingdesk.test/api/workspaces/ws_impact/queue");
const as = (id: string) => {
  state.session = { user: { id, email: `${id}@example.com` } };
};

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedDraftStatuses(db, "ws_impact");
  await seedDraft(db, "ws_impact", { id: "d1" });
  await seedDraft(db, "ws_impact", { id: "d2", statusKey: "rejected" });
  for (const id of ["u_manager", "u_staff", "u_stranger"]) {
    await seedUser(db, id, `${id}@example.com`);
  }
  await seedMember(db, "ws_impact", "u_manager", "manager");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("GET /api/workspaces/[id]/queue", () => {
  it("answers 401 signed out and 404 to staff and outsiders", async () => {
    expect((await GET(get(), context)).status).toBe(401);
    as("u_staff");
    expect((await GET(get(), context)).status).toBe(404);
    as("u_stranger");
    expect((await GET(get(), context)).status).toBe(404);
  });

  it("tells a manager how many requests wait (a rejected one does not)", async () => {
    as("u_manager");
    const response = await GET(get(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ needsApproval: 1 });
  });
});
