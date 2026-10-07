import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The cancel route: who may call it (401 signed out, 404 for outsiders like
// every order route, 403 for staff, managers and platform admins through)
// and what runs after the response. The service is covered in
// src/server/desk/cancel-order.test.ts; here it is stood in.
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
vi.mock("@/server/desk/cancel-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/desk/cancel-order")>();
  return {
    ...real,
    cancelOrder: vi.fn(async () => ({
      kind: "cancelled",
      order: { id: "o1", statusKey: "cancelled", statusSetBy: "u", statusSetAt: 1 },
      events: [],
      statusEvent: {},
      noteEvent: {},
      cancelEvent: {},
      confirmed: true,
    })),
    followCancellation: vi.fn(async () => undefined),
  };
});

const { POST } = await import("./cancel/route");
const service = await import("@/server/desk/cancel-order");

const context = { params: Promise.resolve({ orderId: "o1" }) };
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
  vi.mocked(service.cancelOrder).mockClear();
  vi.mocked(service.followCancellation).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedOrder(db, "ws_impact", { id: "o1" });
  for (const [id, email] of [
    ["u_staff", "staff@example.com"],
    ["u_manager", "manager@example.com"],
    ["u_admin", "admin@rmh.example"],
    ["u_stranger", "stranger@example.com"],
  ] as const) {
    await seedUser(db, id, email);
  }
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_impact", "u_manager", "manager");
});

describe("POST /api/orders/[orderId]/cancel", () => {
  it("answers 401 signed out, 404 to an outsider and 403 to staff, touching nothing", async () => {
    expect((await POST(post({ reason: "Duplicate" }), context)).status).toBe(401);
    state.session = STRANGER;
    expect((await POST(post({ reason: "Duplicate" }), context)).status).toBe(404);
    state.session = STAFF;
    const staff = await POST(post({ reason: "Duplicate" }), context);
    expect(staff.status).toBe(403);
    expect(await staff.json()).toEqual({ error: "Only a manager can cancel orders." });
    expect(service.cancelOrder).not.toHaveBeenCalled();
  });

  it("lets a manager and a platform admin cancel, following up after the response", async () => {
    for (const [session, role] of [
      [MANAGER, "manager"],
      [ADMIN, "platform"],
    ] as const) {
      state.session = session;
      state.after = [];
      const response = await POST(post({ reason: "Duplicate" }), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: "cancelled",
        order: { id: "o1", statusKey: "cancelled", statusSetBy: "u", statusSetAt: 1 },
        events: [],
        confirmed: true,
      });
      expect(vi.mocked(service.cancelOrder).mock.lastCall?.[1]).toEqual({
        workspaceId: "ws_impact",
        orderId: "o1",
        userId: session!.user.id,
        role,
      });
      expect(vi.mocked(service.cancelOrder).mock.lastCall?.[2]).toEqual({ reason: "Duplicate" });
      await Promise.all(state.after);
      expect(service.followCancellation).toHaveBeenCalled();
    }
  });

  it("passes refusals and bad input through with their status", async () => {
    state.session = MANAGER;
    vi.mocked(service.cancelOrder).mockResolvedValueOnce({ kind: "refused", status: 409, error: "Shopify no longer has this order." });
    const refusedResponse = await POST(post({ reason: "Duplicate" }), context);
    expect(refusedResponse.status).toBe(409);
    expect(await refusedResponse.json()).toEqual({ error: "Shopify no longer has this order." });
    vi.mocked(service.cancelOrder).mockResolvedValueOnce({ kind: "invalid", error: "Give a reason." });
    expect((await POST(post({}), context)).status).toBe(400);
    vi.mocked(service.cancelOrder).mockResolvedValueOnce({ kind: "already-cancelled" });
    expect(await (await POST(post({ reason: "Duplicate" }), context)).json()).toEqual({ kind: "already-cancelled" });
    expect(service.followCancellation).not.toHaveBeenCalled();
  });
});
