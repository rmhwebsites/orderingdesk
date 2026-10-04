import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The team routes for real against an in-memory database, on the hub; the
// session, routed host and env are stood in. The ROOM binding records the
// kicks a removal sends.
const state: {
  db: Db | null;
  session: { user: { id: string; email: string } } | null;
  kicks: string[];
  mail: string[];
} = {
  db: null,
  session: null,
  kicks: [],
  mail: [],
};

// The EMAIL binding, recording each recipient.
const email = {
  async send(message: { to: string | string[] }) {
    state.mail.push(...(Array.isArray(message.to) ? message.to : [message.to]));
    return { messageId: "m1" };
  },
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
    env: {
      APP_URL: "https://orderingdesk.test",
      PLATFORM_ADMIN_EMAILS: "boss@example.com",
      EMAIL_FROM: "Ordering Desk <orders@orderingdesk.test>",
      ROOM: room,
      EMAIL: email,
    },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async () => ({ api: { getSession: async () => state.session } }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET, POST, PATCH, DELETE } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };

function request(method: string, body: unknown) {
  return new Request("https://orderingdesk.test/api/workspaces/ws_impact/members", {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

const as = (id: string, email: string) => {
  state.session = { user: { id, email } };
};

async function roleOf(userId: string) {
  const rows = await state
    .db!.select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, "ws_impact"), eq(schema.workspaceMembers.userId, userId)));
  return rows[0]?.role ?? null;
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.kicks = [];
  state.mail = [];
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_tagged", "tagged@example.com");
  await seedMember(db, "ws_impact", "u_manager", "manager");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_impact", "u_tagged", "staff", "shopify");
  // Someone with an account who belongs to another workspace only.
  await seedWorkspace(db, "ws_beta");
  await seedUser(db, "u_buyer", "buyer@b.example", "Pat Buyer");
  await seedMember(db, "ws_beta", "u_buyer", "manager");
});

describe("POST /api/workspaces/[id]/members", () => {
  // The answer, and what the team list shows afterwards, must not tell a
  // manager whether the email has an account somewhere on the platform.
  it("answers an existing account and an unknown email the same way, and lists both as pending invites", async () => {
    as("u_manager", "manager@example.com");
    const existing = await POST(request("POST", { email: "buyer@b.example", role: "staff" }), context);
    const unknown = await POST(request("POST", { email: "nobody@b.example", role: "staff" }), context);
    expect(existing.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(await existing.json()).toEqual(await unknown.json());
    expect(state.mail).toEqual(["buyer@b.example", "nobody@b.example"]);

    const list = (await (await GET(request("GET", undefined), context)).json()) as {
      members: Array<{ email: string; name: string | null }>;
      invites: Array<{ email: string }>;
    };
    expect(list.invites.map((invite) => invite.email)).toEqual(["buyer@b.example", "nobody@b.example"]);
    expect(list.members.map((member) => member.email)).not.toContain("buyer@b.example");
    expect(JSON.stringify(list)).not.toContain("Pat Buyer");
    expect(await roleOf("u_buyer")).toBeNull();
  });

  it("answers 429 once the workspace has sent its hourly allowance of invites", async () => {
    as("u_manager", "manager@example.com");
    for (let i = 0; i < 30; i++) {
      expect((await POST(request("POST", { email: `p${i}@b.example`, role: "staff" }), context)).status).toBe(201);
    }
    const limited = await POST(request("POST", { email: "one.more@b.example", role: "staff" }), context);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toContain("Try again");
    expect(state.mail).toHaveLength(30);
  });
});

describe("PATCH /api/workspaces/[id]/members", () => {
  it("answers 401 signed out and 404 to staff, changing nothing", async () => {
    expect((await PATCH(request("PATCH", { userId: "u_staff", role: "manager" }), context)).status).toBe(401);
    as("u_staff", "staff@example.com");
    expect((await PATCH(request("PATCH", { userId: "u_tagged", role: "manager" }), context)).status).toBe(404);
    expect(await roleOf("u_tagged")).toBe("staff");
  });

  it("lets a manager change a manual member's role, and refuses a Shopify-tagged one with 400", async () => {
    as("u_manager", "manager@example.com");
    const changed = await PATCH(request("PATCH", { userId: "u_staff", role: "manager" }), context);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ ok: true });
    expect(await roleOf("u_staff")).toBe("manager");

    const refused = await PATCH(request("PATCH", { userId: "u_tagged", role: "manager" }), context);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("Shopify");
  });
});

describe("DELETE /api/workspaces/[id]/members", () => {
  it("removes a member and closes their open sockets in this workspace", async () => {
    as("u_manager", "manager@example.com");
    const response = await DELETE(request("DELETE", { userId: "u_staff" }), context);
    expect(response.status).toBe(200);
    expect(await roleOf("u_staff")).toBeNull();
    expect(state.kicks).toEqual(["ws_impact:u_staff"]);
  });

  it("kicks nobody when an invite is withdrawn or a removal is refused", async () => {
    as("u_manager", "manager@example.com");
    expect((await DELETE(request("DELETE", { email: "nobody@example.com" }), context)).status).toBe(200);
    expect((await DELETE(request("DELETE", { userId: "u_tagged" }), context)).status).toBe(400);
    expect(state.kicks).toEqual([]);
  });
});
