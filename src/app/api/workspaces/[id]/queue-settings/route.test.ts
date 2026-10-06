import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: { waitUntil: () => {} } }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { PUT } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const put = (body: unknown) =>
  new Request("https://orderingdesk.test/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const as = (id: string) => {
  state.session = { user: { id, email: `${id}@example.com` } };
};
const VALID = { ageAmberDays: 3, ageRedDays: 6, priceDisplay: "hide" };

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  for (const id of ["u_manager", "u_staff", "u_stranger"]) {
    await seedUser(db, id, `${id}@example.com`);
  }
  await seedMember(db, "ws_impact", "u_manager", "manager");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("PUT /api/workspaces/[id]/queue-settings", () => {
  it("answers 401 signed out and 404 to staff and to outsiders", async () => {
    expect((await PUT(put(VALID), context)).status).toBe(401);
    as("u_staff");
    expect((await PUT(put(VALID), context)).status).toBe(404);
    as("u_stranger");
    expect((await PUT(put(VALID), context)).status).toBe(404);
  });

  it("saves a manager's change and explains a refusal", async () => {
    as("u_manager");
    const saved = await PUT(put(VALID), context);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ queue: VALID });
    const refused = await PUT(put({ ...VALID, priceDisplay: "always" }), context);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Show prices must be auto, show or hide" });
  });
});
