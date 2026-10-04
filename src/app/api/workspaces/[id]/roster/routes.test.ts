import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedRosterEntry, seedUser, seedWorkspace } from "@/server/desk/test-helpers";
import { claimAccessOnSignIn } from "@/server/invites";

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

// What every sign-in and "/" load runs: the person claims their access.
function signIn(userId: string, email: string) {
  return claimAccessOnSignIn(state.db!, userId, email);
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

  // Approving adds nobody, whether or not the email has an account: the
  // person claims it at their next sign-in or "/" load, like an invite. So
  // the answer, and the Team list, say nothing about who has an account.
  it("lets a manager approve, adding nobody, the same with or without an account, and kicks nobody", async () => {
    as("u_manager", "manager@example.com");
    const response = await call(approveRoute, "r_jo", { role: "manager" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, role: "manager" });
    expect(await membership("u_jo")).toBeUndefined();
    expect(await entry("r_jo")).toMatchObject({ approvedRole: "manager", approvedBy: "u_manager", deniedAt: null });
    expect(state.kicks).toEqual([]);
    // No account yet: the same answer.
    const unknown = await call(approveRoute, "r_new", { role: "staff" });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true, role: "staff" });
    expect((await entry("r_new")).approvedRole).toBe("staff");

    await signIn("u_jo", "jo@example.com");
    expect(await membership("u_jo")).toEqual({ role: "manager", source: "shopify" });
    expect(state.kicks).toEqual([]);
  });

  it("lets a platform admin approve in any workspace", async () => {
    await seedUser(state.db!, "u_boss", "boss@example.com");
    as("u_boss", "boss@example.com");
    expect((await call(approveRoute, "r_beta", undefined, "ws_beta")).status).toBe(200);
    expect((await entry("r_beta")).approvedRole).toBe("staff");
    expect(await membership("u_jo", "ws_beta")).toBeUndefined();
    await signIn("u_jo", "jo@example.com");
    expect(await membership("u_jo", "ws_beta")).toEqual({ role: "staff", source: "shopify" });
    // Only what was approved: the waiting request here grants nothing.
    expect(await membership("u_jo")).toBeUndefined();
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
    await signIn("u_jo", "jo@example.com");
    const response = await call(denyRoute, "r_jo");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await membership("u_jo")).toBeUndefined();
    expect(await entry("r_jo")).toMatchObject({ approvedRole: null, approvedAt: null, approvedBy: null });
    expect((await entry("r_jo")).deniedAt).toEqual(expect.any(Number));
    expect(state.kicks).toEqual([`${WS}:u_jo`]);
    // Approving a denied entry later grants again, from the next sign-in.
    expect((await call(approveRoute, "r_jo")).status).toBe(200);
    expect(await membership("u_jo")).toBeUndefined();
    await signIn("u_jo", "jo@example.com");
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
    ).json()) as {
      members: Array<{ userId: string }>;
      requests?: { waiting: Array<{ id: string }>; denied: Array<{ id: string }>; approved: Array<{ id: string }> };
    };

  it("shows managers the waiting and denied requests, and staff neither", async () => {
    as("u_manager", "manager@example.com");
    await call(denyRoute, "r_new");
    const view = await list();
    expect(view.requests?.waiting.map((request) => request.id)).toEqual(["r_jo"]);
    expect(view.requests?.denied.map((request) => request.id)).toEqual(["r_new"]);
    expect(view.requests?.approved).toEqual([]);

    as("u_staff", "staff@example.com");
    expect((await list()).requests).toBeUndefined();
  });

  it("lists an approved request as approved until the person signs in, then the member instead", async () => {
    as("u_manager", "manager@example.com");
    await call(approveRoute, "r_jo", { role: "manager" });
    await call(approveRoute, "r_new", { role: "staff" });
    const before = await list();
    expect(before.members.map((member) => member.userId)).toEqual(["u_manager", "u_staff"]);
    expect(before.requests?.approved.map((request) => request.id)).toEqual(["r_jo", "r_new"]);

    await signIn("u_jo", "jo@example.com");
    const after = await list();
    expect(after.members.map((member) => member.userId)).toEqual(["u_jo", "u_manager", "u_staff"]);
    expect(after.requests?.approved.map((request) => request.id)).toEqual(["r_new"]);
  });
});
