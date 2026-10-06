import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; host: string; session: { user: { id: string; email: string } } | null } = {
  db: null,
  host: "orderingdesk.test",
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: {} }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async (resolution: { kind: string }) =>
    resolution.kind === "unknown" ? null : { api: { getSession: async () => state.session } },
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { default: NotFound } = await import("./not-found");
const CLIENT_HOST = "orders.impactrentals.store";

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_out", "jordan.vale@example.com");
  await db
    .update(schema.workspaces)
    .set({ name: "Impact Rentals", customDomain: CLIENT_HOST, customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
});

describe("the not-found page", () => {
  it("keeps the Ordering Desk look on the hub", async () => {
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain("Ordering Desk");
    expect(html).toContain("Go to your workspaces");
  });

  it("wears the workspace's theme and name on its client host, with a way back to its orders", async () => {
    state.host = CLIENT_HOST;
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain("data-brand-scope");
    expect(html).toContain("Go to Impact Rentals orders");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("Go to your workspaces");
  });

  // clientHostDesk sends a signed-in person with no access here, and "/"
  // would only bring them back: they need the way to ask for access and a
  // way to sign in with another email (sessions are per host).
  it("tells someone signed in without access how to get in, with a way to switch email, on a client host", async () => {
    state.host = CLIENT_HOST;
    state.session = { user: { id: "u_out", email: "jordan.vale@example.com" } };
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain("ask your manager to invite you");
    expect(html).toContain("Signed in as jordan.vale@example.com");
    expect(html).toMatch(/<button[^>]*>Sign in with a different email<\/button>/);
  });

  it("offers no sign-out to someone signed out on a client host, but keeps the invite advice", async () => {
    state.host = CLIENT_HOST;
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain("ask your manager to invite you");
    expect(html).not.toContain("Signed in as");
    expect(html).not.toContain("<button");
  });
});
