import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import {
  openTestDb,
  seedDraft,
  seedDraftStatuses,
  seedMember,
  seedOrder,
  seedUser,
  seedWorkspace,
} from "@/server/desk/test-helpers";

const state: {
  db: Db | null;
  session: { user: { id: string; email: string } } | null;
  after: Promise<unknown>[];
} = { db: null, session: null, after: [] };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test" },
    ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));
vi.mock("@/server/broadcast", () => ({ broadcast: vi.fn(async () => undefined) }));
vi.mock("@/server/shopify/fanout", () => ({ pushAndShare: vi.fn(async () => undefined) }));
vi.mock("@/server/notify", () => ({ notifyActivity: vi.fn(async () => ({ pushed: 0 })) }));

const { POST } = await import("./route");
const { broadcast } = await import("@/server/broadcast");
const { pushAndShare } = await import("@/server/shopify/fanout");
const { notifyActivity } = await import("@/server/notify");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const post = (body: unknown) =>
  new Request("https://orderingdesk.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  vi.mocked(broadcast).mockClear();
  vi.mocked(pushAndShare).mockClear();
  vi.mocked(notifyActivity).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedDraftStatuses(db, "ws_impact");
  await seedOrder(db, "ws_impact", { id: "o1", name: "#1001" });
  await seedOrder(db, "ws_impact", { id: "o2", name: "#1002", statusKey: "processing" });
  await seedDraft(db, "ws_impact", { id: "d1" });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("POST /api/workspaces/[id]/orders/status", () => {
  it("answers 401 signed out and 404 to a non-member, moving nothing", async () => {
    const body = { orderIds: ["o1"], statusKey: "shipped" };
    expect((await POST(post(body), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await POST(post(body), context)).status).toBe(404);
    expect(state.after).toEqual([]);
  });

  it("moves every card it may, says why the others stay, and writes each to Shopify once after the response", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await POST(post({ orderIds: ["o1", "o2", "d1"], statusKey: "shipped" }), context);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: { orderId: string; outcome: string; error?: string }[] };
    expect(body.results.map((row) => [row.orderId, row.outcome])).toEqual([
      ["o1", "changed"],
      ["o2", "changed"],
      ["d1", "refused"],
    ]);
    await Promise.all(state.after);
    expect(vi.mocked(pushAndShare).mock.calls.map((call) => call[3])).toEqual(["o1", "o2"]);
    expect(vi.mocked(broadcast)).toHaveBeenCalledTimes(2);
    // One push per card would flood phones: a bulk move pushes nothing.
    expect(notifyActivity).not.toHaveBeenCalled();
  });

  it("refuses more than 25 cards at once", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await POST(post({ orderIds: Array.from({ length: 26 }, (_, i) => `o${i}`), statusKey: "shipped" }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Move up to 25 cards at a time" });
  });
});
