import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedDraft, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The approve and reject routes: who may call them (401 signed out, 404 for
// outsiders like every order route, 403 for staff, managers and platform
// admins through) and what runs after the response. The review service
// itself is covered in src/server/desk/review.test.ts; here it is stood in.
type Session = { user: { id: string; email: string } } | null;
const state: { db: Db | null; session: Session; after: Promise<unknown>[] } = { db: null, session: null, after: [] };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "admin@rmh.example" },
    ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));
vi.mock("@/server/broadcast", () => ({ broadcast: vi.fn(async () => undefined), broadcastSync: vi.fn(async () => undefined) }));
vi.mock("@/server/notify", () => ({ notifyActivity: vi.fn(async () => ({ pushed: 0 })) }));
vi.mock("@/server/desk/review", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/desk/review")>();
  return {
    ...real,
    approveRequest: vi.fn(async () => ({
      kind: "approved",
      order: { id: "d1", statusKey: "approved", statusSetBy: "u", statusSetAt: 1 },
      orderName: "#1234",
      shopifyOrderId: "9001",
      events: [],
      triggersPo: true,
      follow: { order: {}, statusEvent: null, completedEvent: null, statusChanges: [], merged: null, pushStatus: true },
    })),
    rejectRequest: vi.fn(async () => ({
      kind: "rejected",
      order: { id: "d1", statusKey: "rejected", statusSetBy: "u", statusSetAt: 1 },
      events: [],
      statusEvent: {},
      noteEvent: {},
    })),
    followApproval: vi.fn(async () => undefined),
    followRejection: vi.fn(async () => undefined),
  };
});

const { POST: APPROVE } = await import("./approve/route");
const { POST: REJECT } = await import("./reject/route");
const review = await import("@/server/desk/review");

const context = { params: Promise.resolve({ orderId: "d1" }) };
const post = (body?: unknown) =>
  new Request("https://orderingdesk.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const STAFF: Session = { user: { id: "u_staff", email: "staff@example.com" } };
const MANAGER: Session = { user: { id: "u_manager", email: "manager@example.com" } };
const ADMIN: Session = { user: { id: "u_admin", email: "admin@rmh.example" } };
const STRANGER: Session = { user: { id: "u_stranger", email: "stranger@example.com" } };

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  vi.mocked(review.approveRequest).mockClear();
  vi.mocked(review.rejectRequest).mockClear();
  vi.mocked(review.followApproval).mockClear();
  vi.mocked(review.followRejection).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedDraft(db, "ws_impact", { id: "d1" });
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedUser(db, "u_admin", "admin@rmh.example");
  await seedUser(db, "u_stranger", "stranger@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_impact", "u_manager", "manager");
});

describe("POST /api/orders/[orderId]/approve and /reject", () => {
  it("answers 401 signed out and 404 to an outsider, touching nothing", async () => {
    expect((await APPROVE(post(), context)).status).toBe(401);
    expect((await REJECT(post({ reason: "No" }), context)).status).toBe(401);
    state.session = STRANGER;
    expect((await APPROVE(post(), context)).status).toBe(404);
    expect((await REJECT(post({ reason: "No" }), context)).status).toBe(404);
    expect(review.approveRequest).not.toHaveBeenCalled();
    expect(review.rejectRequest).not.toHaveBeenCalled();
  });

  it("answers 403 to staff with the plain reason", async () => {
    state.session = STAFF;
    for (const response of [await APPROVE(post(), context), await REJECT(post({ reason: "No" }), context)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only a manager can approve or reject requests." });
    }
    expect(review.approveRequest).not.toHaveBeenCalled();
    expect(review.rejectRequest).not.toHaveBeenCalled();
  });

  it("lets a manager and a platform admin approve, following up after the response", async () => {
    for (const [session, role] of [
      [MANAGER, "manager"],
      [ADMIN, "platform"],
    ] as const) {
      state.session = session;
      state.after = [];
      const response = await APPROVE(post(), context);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        kind: "approved",
        order: { id: "d1", statusKey: "approved", statusSetBy: "u", statusSetAt: 1 },
        orderName: "#1234",
        shopifyOrderId: "9001",
        events: [],
        triggersPo: true,
      });
      expect(vi.mocked(review.approveRequest).mock.lastCall?.[1]).toEqual({
        workspaceId: "ws_impact",
        orderId: "d1",
        userId: session!.user.id,
        role,
      });
      await Promise.all(state.after);
      expect(review.followApproval).toHaveBeenCalled();
    }
  });

  it("lets a manager and a platform admin reject, following up after the response", async () => {
    for (const session of [MANAGER, ADMIN]) {
      state.session = session;
      state.after = [];
      const response = await REJECT(post({ reason: "Over budget" }), context);
      expect(response.status).toBe(200);
      expect(vi.mocked(review.rejectRequest).mock.lastCall?.[2]).toEqual({ reason: "Over budget" });
      await Promise.all(state.after);
    }
    expect(review.followRejection).toHaveBeenCalledTimes(2);
  });

  it("passes the service's refusals through with their status", async () => {
    state.session = MANAGER;
    vi.mocked(review.approveRequest).mockResolvedValueOnce({ kind: "refused", status: 502, error: "Shopify did not answer." });
    const response = await APPROVE(post(), context);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Shopify did not answer." });
    vi.mocked(review.rejectRequest).mockResolvedValueOnce({ kind: "invalid", error: "Give a reason." });
    expect((await REJECT(post({}), context)).status).toBe(400);
    expect(state.after).toEqual([]);
  });
});
