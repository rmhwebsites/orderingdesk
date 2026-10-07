import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedLocation, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

const FILTER = {
  kind: "orders",
  status: null,
  state: "any",
  locations: ["North Yard"],
  person: null,
  itemTitle: null,
  itemText: null,
  personalization: null,
  orderNumber: null,
  date: "last_month",
  from: null,
  to: null,
  olderThanDays: null,
  newerThanDays: null,
  sort: "newest",
  text: null,
};

const state: {
  db: Db | null;
  session: { user: { id: string; email: string } } | null;
  run: Mock<(...args: unknown[]) => Promise<unknown>>;
} = { db: null, session: null, run: vi.fn() };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", AI: { run: (...args: unknown[]) => state.run(...args) } },
    ctx: { waitUntil: () => undefined },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { POST } = await import("./route");
const context = { params: Promise.resolve({ id: "ws_impact" }) };
const ask = (body: unknown) =>
  POST(new Request("https://orderingdesk.test/api/workspaces/ws_impact/search/ai", { method: "POST", body: JSON.stringify(body) }), context);

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.run = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(FILTER) } }] }));
  await seedWorkspace(db, "ws_impact");
  await seedLocation(db, "ws_impact", { shopifyLocationId: "loc_north", name: "North Yard" });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_out", "out@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("POST /api/workspaces/[id]/search/ai", () => {
  it("answers 401 signed out and 404 to a non-member, asking no model", async () => {
    expect((await ask({ q: "orders shipped to north yard last month" })).status).toBe(401);
    state.session = { user: { id: "u_out", email: "out@example.com" } };
    expect((await ask({ q: "orders shipped to north yard last month" })).status).toBe(404);
    expect(state.run).not.toHaveBeenCalled();
  });

  it("turns a member's question into desk params", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await ask({ q: "orders shipped to north yard last month" });
    expect(response.status).toBe(200);
    const params = new URLSearchParams(((await response.json()) as { params: string }).params);
    expect(Object.fromEntries(params)).toEqual({ view: "all", kind: "orders", location: "loc_north", date: "last_month" });
  });

  it("answers a fallback for a short search and 400 for no question or a huge body", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    expect(await (await ask({ q: "#1024" })).json()).toEqual({ fallback: "shortcut" });
    expect((await ask({})).status).toBe(400);
    expect((await ask({ q: "x ".repeat(3000) })).status).toBe(400);
    expect(state.run).not.toHaveBeenCalled();
  });
});
