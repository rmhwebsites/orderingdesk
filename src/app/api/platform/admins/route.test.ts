import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The platform admin route against an in-memory database, on the hub. The
// ROOM binding records the kicks a revocation sends.
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

function del(body: unknown) {
  return new Request("https://orderingdesk.test/api/platform/admins", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = { user: { id: "u_boss", email: "boss@example.com" } };
  state.kicks = [];
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_beta");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_helper", "helper@example.com");
  await db.insert(schema.platformAdmins).values({ userId: "u_helper", grantedBy: "u_boss", createdAt: 1 });
  await seedMember(db, "ws_impact", "u_helper", "staff");
});

describe("DELETE /api/platform/admins", () => {
  it("revokes a promoted admin and closes their sockets where they are not a member", async () => {
    const response = await DELETE(del({ userId: "u_helper" }));
    expect(response.status).toBe(200);
    // Still a member of ws_impact, so that socket stays.
    expect(state.kicks).toEqual(["ws_beta:u_helper"]);
  });

  it("kicks nobody for a withdrawn invite", async () => {
    expect((await DELETE(del({ email: "next@example.com" }))).status).toBe(200);
    expect(state.kicks).toEqual([]);
  });
});
