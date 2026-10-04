import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import type { AdminPageData } from "@/server/admin-page";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// /admin by host and viewer, for real against an in-memory database.
const state: { db: Db | null; host: string; session: { user: { id: string; email: string } } | null } = {
  db: null,
  host: "orderingdesk.test",
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("next/navigation", () => ({
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

const { default: AdminPage } = await import("./page");
const { AdminScreen } = await import("@/components/admin/admin-screen");

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.workspaces)
    .set({ name: "Impact Rentals", customDomain: "orders.impactrentals.store", customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await seedUser(db, "u_boss", "boss@example.com", "Boss");
  await seedUser(db, "u_lead", "lead@example.com", "Lead");
  await seedMember(db, "ws_impact", "u_lead", "manager");
});

async function outcome(): Promise<string | ReactElement> {
  try {
    const element = await AdminPage();
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

describe("/admin", () => {
  it("sends a signed-out visitor to sign in and answers anyone but a platform admin with not found", async () => {
    expect(await outcome()).toBe("REDIRECT /sign-in");
    state.session = { user: { id: "u_lead", email: "lead@example.com" } };
    expect(await outcome()).toBe("NOT_FOUND");
  });

  it("shows a platform admin every workspace, the platform admins and every user", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const element = (await outcome()) as ReactElement<{ data: AdminPageData }>;
    expect(element.type).toBe(AdminScreen);
    const { data } = element.props;
    expect(data.viewerUserId).toBe("u_boss");
    expect(data.workspaces).toEqual([
      { id: "ws_impact", name: "Impact Rentals", slug: "ws_impact", customDomain: "orders.impactrentals.store", customDomainStatus: "active", members: 1 },
    ]);
    expect(data.admins.admins.map((admin) => admin.email)).toEqual(["boss@example.com"]);
    expect(data.users.map((user) => user.email)).toEqual(["boss@example.com", "lead@example.com"]);
  });

  it("does not exist on a client host", async () => {
    state.host = "orders.impactrentals.store";
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    expect(await outcome()).toBe("NOT_FOUND");
  });
});
