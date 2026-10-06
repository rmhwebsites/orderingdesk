import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedWorkspace } from "@/server/desk/test-helpers";

const state: { db: Db | null; host: string } = { db: null, host: "orderingdesk.test" };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: {} }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { default: NotFound } = await import("./not-found");
const CLIENT_HOST = "orders.impactrentals.store";

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  await seedWorkspace(db, "ws_impact");
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
});
