import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The disconnect route for real against an in-memory database, on the hub.
// The ROOM binding records the kicks it sends.
const state: { db: Db | null; session: { user: { id: string; email: string } } | null; kicks: string[] } = {
  db: null,
  session: null,
  kicks: [],
};

const room = {
  idFromName: (name: string) => ({ name }),
  get: (id: { name: string }) => ({
    async fetch(url: string, init: RequestInit) {
      if (url.endsWith("/kick")) {
        state.kicks.push(`${id.name}:${(JSON.parse(String(init.body)) as { userId: string }).userId}`);
      }
      return Response.json({ closed: 1 });
    },
  }),
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com", ROOM: room },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async () => ({ api: { getSession: async () => state.session } }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { DELETE } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.kicks = [];
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_tagged", "tagged@example.com");
  await seedUser(db, "u_manual", "manual@example.com");
  await seedMember(db, "ws_impact", "u_tagged", "manager", "shopify");
  await seedMember(db, "ws_impact", "u_manual", "manager", "manual");
  await db.insert(schema.storeConnections).values({
    workspaceId: "ws_impact",
    shopDomain: "impactrentals.myshopify.com",
    encryptedToken: "v1.ciphertext",
    status: "ok",
  });
});

describe("DELETE /api/workspaces/[id]/connection", () => {
  it("answers a manager with 404 and keeps the store connected", async () => {
    state.session = { user: { id: "u_manual", email: "manual@example.com" } };
    const response = await DELETE(new Request("https://orderingdesk.test/api/workspaces/ws_impact/connection"), context);
    expect(response.status).toBe(404);
    const [row] = await state.db!.select().from(schema.storeConnections);
    expect(row.status).toBe("ok");
    expect(state.kicks).toEqual([]);
  });

  it("disconnects, takes away tag-based access and closes those people's sockets", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const response = await DELETE(new Request("https://orderingdesk.test/api/workspaces/ws_impact/connection"), context);
    expect(response.status).toBe(200);
    expect(state.kicks).toEqual(["ws_impact:u_tagged"]);
    const members = await state
      .db!.select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, "ws_impact"));
    expect(members).toEqual([{ userId: "u_manual" }]);
  });
});
