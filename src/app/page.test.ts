import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// "/" by host, run for real against an in-memory database. The request
// context is stood in (routed Host, session, env), and redirect / notFound
// throw a marker the way Next's do.
const state: {
  db: Db | null;
  host: string;
  session: { user: { id: string; email: string } } | null;
} = { db: null, host: "orderingdesk.test", session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com" },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async (resolution: { kind: string }) =>
    resolution.kind === "unknown" ? null : { api: { getSession: async () => state.session } },
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { default: Home } = await import("./page");
const { WorkspaceShell } = await import("@/components/shell/workspace-shell");

const CLIENT_HOST = "orders.impactrentals.store";

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_other");
  await db
    .update(schema.workspaces)
    .set({ customDomain: CLIENT_HOST, customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_out", "out@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_other", "u_out", "manager");
});

async function outcome(): Promise<string | ReactElement> {
  try {
    const element = await Home();
    if (!isValidElement(element)) {
      throw new Error("expected an element");
    }
    return element;
  } catch (e) {
    if (e instanceof Error && (e.message.startsWith("REDIRECT") || e.message === "NOT_FOUND")) {
      return e.message;
    }
    throw e;
  }
}

describe("/ on an active client host", () => {
  it("sends a signed-out visitor to that host's sign-in page", async () => {
    state.host = CLIENT_HOST;
    expect(await outcome()).toBe("REDIRECT /sign-in");
  });

  it("renders the workspace desk for a member, in the client host shell", async () => {
    state.host = CLIENT_HOST;
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const element = (await outcome()) as ReactElement<{ clientHost: boolean; workspace: { id: string }; role: string }>;
    expect(element.type).toBe(WorkspaceShell);
    expect(element.props.clientHost).toBe(true);
    expect(element.props.workspace.id).toBe("ws_impact");
    expect(element.props.role).toBe("staff");
  });

  // Platform powers stay on the hub (src/server/guard.ts, Viewer): on a
  // client host a platform admin works as a manager of that workspace.
  it("renders it for a platform admin who is not a member, as a manager", async () => {
    state.host = CLIENT_HOST;
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const element = (await outcome()) as ReactElement<{ workspace: { id: string }; role: string }>;
    expect(element.type).toBe(WorkspaceShell);
    expect(element.props.role).toBe("manager");
  });

  it("answers a signed-in non-member with the not-found page", async () => {
    state.host = CLIENT_HOST;
    state.session = { user: { id: "u_out", email: "out@example.com" } };
    expect(await outcome()).toBe("NOT_FOUND");
  });
});

describe("/ on other hosts", () => {
  it("keeps the hub behavior: a client with one workspace goes straight into it", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    expect(await outcome()).toBe("REDIRECT /w/ws_impact");
  });

  it("shows nothing on an unknown host", async () => {
    state.host = "evil.example";
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    expect(await outcome()).toBe("NOT_FOUND");
  });
});

// An invite is always a pending invite (src/server/members.ts), and the
// invite email's button opens "/". Someone who already has an account and
// is signed in claims it there, without signing in again.
describe("/ claims a signed-in person's pending invites", () => {
  async function invite(email: string, workspaceId: string) {
    await state.db!.insert(schema.pendingInvites).values({
      id: `i_${workspaceId}`,
      email,
      workspaceId,
      role: "staff",
      invitedBy: "u_staff",
      createdAt: 1,
    });
  }

  it("on the hub", async () => {
    await seedUser(state.db!, "u_new", "new@example.com");
    await invite("new@example.com", "ws_other");
    state.session = { user: { id: "u_new", email: "new@example.com" } };
    expect(await outcome()).toBe("REDIRECT /w/ws_other");
    expect(await state.db!.select().from(schema.pendingInvites)).toEqual([]);
  });

  it("on the workspace's client host", async () => {
    await seedUser(state.db!, "u_new", "new@example.com");
    await invite("new@example.com", "ws_impact");
    state.host = CLIENT_HOST;
    state.session = { user: { id: "u_new", email: "new@example.com" } };
    const element = (await outcome()) as ReactElement<{ role: string }>;
    expect(element.type).toBe(WorkspaceShell);
    expect(element.props.role).toBe("staff");
  });
});

describe("the hub header", () => {
  it("puts the account controls in one menu that fits a phone", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const html = renderToStaticMarkup((await outcome()) as ReactElement);
    expect(html).toContain('aria-label="Account menu for boss@example.com"');
    expect(html).not.toContain("Signed in as");
    expect(html).not.toContain(">Sign out<");
    expect(html).not.toContain('name="theme"');
  });
});
