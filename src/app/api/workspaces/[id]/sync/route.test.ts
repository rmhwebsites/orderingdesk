import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";
import type { SyncResult } from "@/server/sync/run";

// The Sync button's route: guards, then what runs after the response (the
// broadcast, Shopify status moves and, since Phase 6, new-order
// notifications). The engine itself is stood in.
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
vi.mock("@/server/broadcast", () => ({
  broadcastSync: vi.fn(async () => undefined),
  broadcastMerges: vi.fn(async () => undefined),
}));
vi.mock("@/server/shopify/fanout", () => ({ shareShopifyMoves: vi.fn(async () => undefined) }));
vi.mock("@/server/notify", () => ({ notifyNewOrders: vi.fn(async () => ({ claimed: 0, announced: [], pushed: 0, emailed: 0 })) }));
vi.mock("@/server/desk/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/desk/sync")>();
  return { ...actual, manualSync: vi.fn() };
});

const { POST } = await import("./route");
const { manualSync } = await import("@/server/desk/sync");
const { notifyNewOrders } = await import("@/server/notify");
const { broadcastMerges } = await import("@/server/broadcast");

const context = { params: Promise.resolve({ id: "ws_impact" }) };
const result = (overrides: Partial<SyncResult> = {}): SyncResult => ({
  added: 0,
  updated: 0,
  addedOrderIds: [],
  updatedOrderIds: [],
  ...overrides,
});

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  vi.mocked(manualSync).mockReset();
  vi.mocked(notifyNewOrders).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("POST /api/workspaces/[id]/sync", () => {
  it("answers 401 signed out and 404 to a non-member, running nothing", async () => {
    expect((await POST(new Request("https://x/"), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await POST(new Request("https://x/"), context)).status).toBe(404);
    expect(manualSync).not.toHaveBeenCalled();
  });

  it("announces the orders the run inserted, after the response", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    vi.mocked(manualSync).mockResolvedValue({ kind: "done", result: result({ added: 1, addedOrderIds: ["o1"] }) });
    expect((await POST(new Request("https://x/"), context)).status).toBe(200);
    await Promise.all(state.after);
    expect(vi.mocked(notifyNewOrders).mock.calls.map((call) => [call[2], call[3]])).toEqual([["ws_impact", ["o1"]]]);
  });

  it("announces what landed even when the run then failed", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    vi.mocked(manualSync).mockResolvedValue({ kind: "failed", result: result({ added: 1, addedOrderIds: ["o2"], error: "Shopify did not answer" }) });
    expect((await POST(new Request("https://x/"), context)).status).toBe(502);
    await Promise.all(state.after);
    expect(vi.mocked(notifyNewOrders).mock.calls.map((call) => call[3])).toEqual([["o2"]]);
  });

  it("broadcasts the order cards the run folded into draft cards", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    vi.mocked(broadcastMerges).mockClear();
    const merged = [{ fromId: "o_orphan", toId: "o_draft" }];
    vi.mocked(manualSync).mockResolvedValue({ kind: "done", result: result({ updated: 1, updatedOrderIds: ["o_draft"], mergedOrders: merged }) });
    expect((await POST(new Request("https://x/"), context)).status).toBe(200);
    await Promise.all(state.after);
    expect(vi.mocked(broadcastMerges).mock.calls.map((call) => [call[1], call[2]])).toEqual([["ws_impact", merged]]);
  });
});
