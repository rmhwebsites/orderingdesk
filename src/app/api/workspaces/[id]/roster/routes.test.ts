import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedRosterEntry, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// Approving and denying Shopify tag requests, for real against an in-memory
// database on the hub; the session, routed host and env are stood in. The
// ROOM binding records the kicks a denial sends.
const state: {
  db: Db | null;
  session: { user: { id: string; email: string } } | null;
  kicks: string[];
} = { db: null, session: null, kicks: [] };

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

const approveRoute = await import("./[rosterId]/approve/route");
const denyRoute = await import("./[rosterId]/deny/route");
const membersRoute = await import("../members/route");

const WS = "ws_impact";

function call(
  route: { POST: (request: Request, context: { params: Promise<{ id: string; rosterId: string }> }) => Promise<Response> },
  rosterId: string,
  body?: unknown,
  workspaceId = WS,
) {
  return route.POST(
    new Request(`https://orderingdesk.test/api/workspaces/${workspaceId}/roster/${rosterId}/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: workspaceId, rosterId }) },
  );
}

const as = (id: string, email: string) => {
  state.session = { user: { id, email } };
};

async function membership(userId: string, workspaceId = WS) {
  const rows = await state
    .db!.select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  return rows[0];
}

async function entry(id: string) {
  const rows = await state.db!.select().from(schema.shopifyRoster).where(eq(schema.shopifyRoster.id, id));
  return rows[0];
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.kicks = [];
  await seedWorkspace(db, WS);
  await seedWorkspace(db, "ws_beta");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_jo", "jo@example.com");
  await seedUser(db, "u_beta", "beta@example.com");
  await seedMember(db, WS, "u_manager", "manager");
  await seedMember(db, WS, "u_staff", "staff");
  await seedMember(db, "ws_beta", "u_beta", "manager");
  await seedRosterEntry(db, { id: "r_jo", workspaceId: WS, email: "jo@example.com", role: "manager" });
  await seedRosterEntry(db, { id: "r_new", workspaceId: WS, email: "nobody.yet@example.com", role: "staff" });
  await seedRosterEntry(db, { id: "r_beta", workspaceId: "ws_beta", email: "jo@example.com", role: "staff" });
});

describe("POST /api/workspaces/[id]/roster/[rosterId]/approve", () => {
  it("answers 401 signed out and 404 to staff, approving nothing", async () => {
    expect((await call(approveRoute, "r_jo")).status).toBe(401);
    as("u_staff", "staff@example.com");
    expect((await call(approveRoute, "r_jo")).status).toBe(404);
    expect((await entry("r_jo")).approvedRole).toBeNull();
    expect(await membership("u_jo")).toBeUndefined();
  });

  it("lets a manager approve: an existing user gets the membership at once, and nobody is kicked", async () => {
    as("u_manager", "manager@example.com");
    const response = await call(approveRoute, "r_jo", { role: "manager" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, role: "manager" });
    expect(await membership("u_jo")).toEqual({ role: "manager", source: "shopify" });
    expect(await entry("r_jo")).toMatchObject({ approvedRole: "manager", approvedBy: "u_manager", deniedAt: null });
    expect(state.kicks).toEqual([]);
    // Without an account yet, the approval waits for the first sign-in.
    expect((await call(approveRoute, "r_new")).status).toBe(200);
    expect((await entry("r_new")).approvedRole).toBe("staff");
  });

  it("lets a platform admin approve in any workspace", async () => {
    await seedUser(state.db!, "u_boss", "boss@example.com");
    as("u_boss", "boss@example.com");
    expect((await call(approveRoute, "r_beta", undefined, "ws_beta")).status).toBe(200);
    expect(await membership("u_jo", "ws_beta")).toEqual({ role: "staff", source: "shopify" });
  });

  it("answers 404 for a roster entry of another workspace, or one that does not exist", async () => {
    as("u_manager", "manager@example.com");
    expect((await call(approveRoute, "r_beta")).status).toBe(404);
    expect((await call(approveRoute, "r_missing")).status).toBe(404);
    expect((await entry("r_beta")).approvedRole).toBeNull();
    expect(await membership("u_jo", "ws_beta")).toBeUndefined();
    // A manager of the other workspace cannot reach this one's entries.
    as("u_beta", "beta@example.com");
    expect((await call(approveRoute, "r_jo")).status).toBe(404);
    expect((await call(approveRoute, "r_jo", undefined, "ws_beta")).status).toBe(404);
  });

  it("answers 409 when the tag changed since the manager looked, and 400 for a role that is not one", async () => {
    as("u_manager", "manager@example.com");
    const changed = await call(approveRoute, "r_jo", { role: "staff" });
    expect(changed.status).toBe(409);
    expect(((await changed.json()) as { error: string }).error).toContain("Manager");
    expect((await call(approveRoute, "r_jo", { role: "owner" })).status).toBe(400);
    expect((await entry("r_jo")).approvedRole).toBeNull();
  });
});

describe("POST /api/workspaces/[id]/roster/[rosterId]/deny", () => {
  it("answers 404 to staff and for another workspace's entry", async () => {
    as("u_staff", "staff@example.com");
    expect((await call(denyRoute, "r_jo")).status).toBe(404);
    as("u_manager", "manager@example.com");
    expect((await call(denyRoute, "r_beta")).status).toBe(404);
    expect((await entry("r_beta")).deniedAt).toBeNull();
  });

  it("denies, takes away the shopify membership for the email here and closes their sockets", async () => {
    as("u_manager", "manager@example.com");
    await call(approveRoute, "r_jo");
    const response = await call(denyRoute, "r_jo");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await membership("u_jo")).toBeUndefined();
    expect(await entry("r_jo")).toMatchObject({ approvedRole: null, approvedAt: null, approvedBy: null });
    expect((await entry("r_jo")).deniedAt).toEqual(expect.any(Number));
    expect(state.kicks).toEqual([`${WS}:u_jo`]);
    // Approving a denied entry later grants again.
    expect((await call(approveRoute, "r_jo")).status).toBe(200);
    expect(await membership("u_jo")).toEqual({ role: "manager", source: "shopify" });
  });

  it("kicks nobody when there was no membership to take away", async () => {
    as("u_manager", "manager@example.com");
    expect((await call(denyRoute, "r_new")).status).toBe(200);
    expect(state.kicks).toEqual([]);
  });
});

describe("GET /api/workspaces/[id]/members (tag requests)", () => {
  const list = async () =>
    (await (
      await membersRoute.GET(new Request(`https://orderingdesk.test/api/workspaces/${WS}/members`), {
        params: Promise.resolve({ id: WS }),
      })
    ).json()) as { requests?: { waiting: Array<{ id: string }>; denied: Array<{ id: string }> } };

  it("shows managers the waiting and denied requests, and staff neither", async () => {
    as("u_manager", "manager@example.com");
    await call(denyRoute, "r_new");
    const view = await list();
    expect(view.requests?.waiting.map((request) => request.id)).toEqual(["r_jo"]);
    expect(view.requests?.denied.map((request) => request.id)).toEqual(["r_new"]);

    as("u_staff", "staff@example.com");
    expect((await list()).requests).toBeUndefined();
  });
});
