import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace, snapshotOf } from "@/server/desk/test-helpers";
import { indexOrders } from "@/server/search/index-orders";

const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test" }, ctx: { waitUntil: () => {} } }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET } = await import("./route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const get = (query = "") => new Request(`https://orderingdesk.test/api/workspaces/ws_impact/orders${query}`);

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.statuses)
    .set({ closed: true })
    .where(and(eq(schema.statuses.workspaceId, "ws_impact"), eq(schema.statuses.key, "shipped")));
  await seedOrder(db, "ws_impact", { id: "o_new", statusKey: "new", createdAt: 2 });
  await seedOrder(db, "ws_impact", { id: "o_shipped", statusKey: "shipped", createdAt: 1 });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("GET /api/workspaces/[id]/orders", () => {
  it("answers 401 signed out and 404 to a non-member", async () => {
    expect((await GET(get(), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await GET(get(), context)).status).toBe(404);
  });

  it("opens on the Open view when no view is asked for, with every view's count and the queue settings", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const body = (await (await GET(get(), context)).json()) as {
      view: string;
      orders: { id: string }[];
      viewCounts: unknown;
      queue: unknown;
    };
    expect(body.view).toBe("open");
    expect(body.orders.map((order) => order.id)).toEqual(["o_new"]);
    expect(body.viewCounts).toEqual({ open: 1, approval: 0, all: 2, closed: 1 });
    expect(body.queue).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });
  });

  it("loads the view it is asked for, and Open for one it does not know", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const all = (await (await GET(get("?view=all"), context)).json()) as { orders: unknown[] };
    expect(all.orders).toHaveLength(2);
    const unknown = (await (await GET(get("?view=nope"), context)).json()) as { view: string };
    expect(unknown.view).toBe("open");
  });
});

describe("GET /api/workspaces/[id]/orders search", () => {
  it("filters by the URL's words and pages by its limit and cursor", async () => {
    const db = state.db!;
    await seedOrder(db, "ws_impact", { id: "s1", createdAt: 1, shopify: snapshotOf({ items: [{ title: "Hard Hat", qty: 1, sku: "HH-1", variant: "", props: [] }] }) });
    await seedOrder(db, "ws_impact", { id: "s2", createdAt: 2, shopify: snapshotOf({ items: [{ title: "Safety Vest", qty: 1, sku: "SV-2", variant: "", props: [] }] }) });
    await indexOrders(db, "ws_impact", ["s1", "s2"]);
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    type Page = { orders: { id: string }[]; matchCount: number; nextCursor: string };
    const get = async (search: string) =>
      (await (await GET(new Request(`https://orderingdesk.test/api/workspaces/ws_impact/orders${search}`), context)).json()) as Page;
    const found = await get("?view=all&q=hard%20hat");
    expect(found.orders.map((order) => order.id)).toEqual(["s1"]);
    const first = await get("?view=all&limit=1");
    expect(first.orders).toHaveLength(1);
    expect(first.matchCount).toBeGreaterThanOrEqual(2);
    const second = await get(`?view=all&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(second.orders[0].id).not.toBe(first.orders[0].id);
  });
});
