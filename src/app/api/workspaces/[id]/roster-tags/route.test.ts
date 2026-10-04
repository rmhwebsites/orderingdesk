import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The roster tag route for real against an in-memory database, on the hub.
const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

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

const { PUT } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };

function put(body: unknown) {
  return new Request("https://orderingdesk.test/api/workspaces/ws_impact/roster-tags", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function storedTags() {
  const [row] = await state.db!.select().from(schema.workspaces).where(eq(schema.workspaces.id, "ws_impact"));
  return row.rosterTags ?? null;
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

describe("PUT /api/workspaces/[id]/roster-tags", () => {
  it("answers 401 signed out and 404 to a workspace manager", async () => {
    expect((await PUT(put({ manager: "Lead", staff: "Crew" }), context)).status).toBe(401);
    state.session = { user: { id: "u_manager", email: "manager@example.com" } };
    expect((await PUT(put({ manager: "Lead", staff: "Crew" }), context)).status).toBe(404);
    expect(await storedTags()).toBeNull();
  });

  it("lets a platform admin set the tags, refuse bad ones, and go back to the defaults", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const saved = await PUT(put({ manager: "Desk Lead", staff: "Desk Crew" }), context);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ tags: { manager: "Desk Lead", staff: "Desk Crew" } });
    expect((await PUT(put({ manager: "Same", staff: "same" }), context)).status).toBe(400);
    const reset = await PUT(put(null), context);
    expect(await reset.json()).toEqual({ tags: { manager: "Ordering Desk Manager", staff: "Ordering Desk Staff" } });
    expect(await storedTags()).toBeNull();
  });
});
