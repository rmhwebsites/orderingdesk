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

// The status and note routes: guards, the write, and what runs after the
// response (since Phase 6 that includes the all-activity push). The room,
// Shopify and push are stood in.
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

const { POST: STATUS } = await import("./status/route");
const { POST: NOTE } = await import("./note/route");
const { notifyActivity } = await import("@/server/notify");

const context = { params: Promise.resolve({ orderId: "o1" }) };
const post = (body: unknown) =>
  new Request("https://orderingdesk.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  vi.mocked(notifyActivity).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedOrder(db, "ws_impact", { id: "o1" });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
});

describe("POST /api/orders/[orderId]/status and /note", () => {
  it("answers 401 signed out and 404 to a non-member, pushing nothing", async () => {
    expect((await STATUS(post({ statusKey: "shipped" }), context)).status).toBe(401);
    expect((await NOTE(post({ text: "hi" }), context)).status).toBe(401);
    state.session = { user: { id: "u_stranger", email: "stranger@example.com" } };
    expect((await STATUS(post({ statusKey: "shipped" }), context)).status).toBe(404);
    expect((await NOTE(post({ text: "hi" }), context)).status).toBe(404);
    expect(notifyActivity).not.toHaveBeenCalled();
  });

  it("hands a status change to the all-activity push after the response", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await STATUS(post({ statusKey: "shipped" }), context);
    expect(response.status).toBe(200);
    const { event } = (await response.json()) as { event: { id: string; actorId: string } };
    await Promise.all(state.after);
    expect(vi.mocked(notifyActivity).mock.calls.map((call) => [call[2], (call[3] as { id: string }).id])).toEqual([
      ["ws_impact", event.id],
    ]);
    expect(event.actorId).toBe("u_staff");
  });

  it("answers 403 when staff move a rejected request and 400 for a status a request cannot take", async () => {
    const db = state.db as Db;
    await seedDraftStatuses(db, "ws_impact");
    await seedDraft(db, "ws_impact", { id: "d1", statusKey: "rejected" });
    await seedDraft(db, "ws_impact", { id: "d2" });
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const rejected = await STATUS(post({ statusKey: "new" }), { params: Promise.resolve({ orderId: "d1" }) });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: "Only a manager can reopen a rejected request." });
    const approve = await STATUS(post({ statusKey: "approved" }), { params: Promise.resolve({ orderId: "d2" }) });
    expect(approve.status).toBe(400);
    expect(await approve.json()).toEqual({ error: "Use Approve to approve this request. It creates the order in Shopify." });
    expect(state.after).toEqual([]);
  });

  it("hands a note to the all-activity push after the response", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await NOTE(post({ text: "Called the customer" }), context);
    expect(response.status).toBe(200);
    await Promise.all(state.after);
    expect(vi.mocked(notifyActivity).mock.calls.map((call) => (call[3] as { type: string }).type)).toEqual(["note"]);
  });
});
