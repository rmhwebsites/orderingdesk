import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace } from "./desk/test-helpers";

// The guards against the in-memory database with the request context stood
// in: the routed Host header, the session, and the Cloudflare env.
const state: {
  db: Db | null;
  host: string;
  session: { user: { id: string; email: string } } | null;
} = { db: null, host: "orderingdesk.test", session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com" },
    ctx: {},
  }),
}));
vi.mock("./auth", () => ({
  getAuth: async (resolution: { kind: string }) =>
    resolution.kind === "unknown" ? null : { api: { getSession: async () => state.session } },
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { AuthError, requireMember, requireMemberByOrder, requireMemberBySlug, requireSession } = await import(
  "./guard"
);

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
  await seedUser(db, "u_both", "both@example.com");
  await seedUser(db, "u_out", "out@example.com");
  await seedMember(db, "ws_impact", "u_both", "staff");
  await seedMember(db, "ws_other", "u_both", "manager");
  await seedMember(db, "ws_other", "u_out", "manager");
  await seedOrder(db, "ws_other", { id: "o_other" });
  await seedOrder(db, "ws_impact", { id: "o_impact" });
});

function signIn(id: string, email: string) {
  state.session = { user: { id, email } };
}

async function statusOf(promise: Promise<unknown>): Promise<number | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (e) {
    if (e instanceof AuthError) {
      return e.status;
    }
    throw e;
  }
}

describe("guards on a client host", () => {
  it("answers 401 to a signed-out request, as on the hub", async () => {
    state.host = CLIENT_HOST;
    expect(await statusOf(requireSession())).toBe(401);
    expect(await statusOf(requireMember("ws_impact", "staff"))).toBe(401);
  });

  it("reaches only the host's own workspace, even for someone who belongs to another", async () => {
    state.host = CLIENT_HOST;
    signIn("u_both", "both@example.com");
    expect(await statusOf(requireMember("ws_impact", "staff"))).toBe("ok");
    expect(await statusOf(requireMember("ws_other", "staff"))).toBe(404);
    expect(await statusOf(requireMemberBySlug("ws_impact", "staff"))).toBe("ok");
    expect(await statusOf(requireMemberBySlug("ws_other", "staff"))).toBe(404);
    expect(await statusOf(requireMemberByOrder("o_impact", "staff"))).toBe("ok");
    expect(await statusOf(requireMemberByOrder("o_other", "staff"))).toBe(404);
  });

  it("scopes a platform admin to the host's workspace too", async () => {
    state.host = CLIENT_HOST;
    signIn("u_boss", "boss@example.com");
    expect(await statusOf(requireMember("ws_impact", "platform"))).toBe("ok");
    expect(await statusOf(requireMember("ws_other", "platform"))).toBe(404);
  });

  it("answers a signed-in non-member of the host's workspace with 404", async () => {
    state.host = CLIENT_HOST;
    signIn("u_out", "out@example.com");
    expect(await statusOf(requireMemberBySlug("ws_impact", "staff"))).toBe(404);
  });

  it("refuses an unknown host before any session check", async () => {
    state.host = "evil.example";
    signIn("u_boss", "boss@example.com");
    expect(await statusOf(requireSession())).toBe(404);
    expect(await statusOf(requireMember("ws_impact", "staff"))).toBe(404);
  });

  it("leaves the hub unscoped", async () => {
    signIn("u_both", "both@example.com");
    expect(await statusOf(requireMember("ws_impact", "staff"))).toBe("ok");
    expect(await statusOf(requireMember("ws_other", "manager"))).toBe("ok");
    expect(await statusOf(requireMemberByOrder("o_other", "staff"))).toBe("ok");
  });
});
