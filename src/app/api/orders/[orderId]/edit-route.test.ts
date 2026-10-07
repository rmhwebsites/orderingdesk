import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedDraft, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The edit routes: who may call them (401 signed out, 404 for outsiders,
// 403 for staff) and what runs after the response. The service is covered
// in src/server/desk/edit-request.test.ts; here it is stood in.
type Session = { user: { id: string; email: string } } | null;
const state: { db: Db | null; session: Session; after: Promise<unknown>[] } = { db: null, session: null, after: [] };

const EDITOR = { updatedAt: "2026-10-06T14:00:00Z", lines: [], locationId: null, locationName: "", locations: [] };

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
vi.mock("@/server/desk/edit-request", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/desk/edit-request")>();
  return {
    ...real,
    loadRequestEditor: vi.fn(async () => ({ kind: "editor", editor: EDITOR })),
    editRequest: vi.fn(async () => ({ kind: "edited", event: { id: "e1" }, warning: null, statusChanges: [] })),
    followEdit: vi.fn(async () => undefined),
  };
});

const { GET, POST } = await import("./edit/route");
const service = await import("@/server/desk/edit-request");

const context = { params: Promise.resolve({ orderId: "d1" }) };
const get = () => new Request("https://orderingdesk.test/x");
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
  vi.mocked(service.loadRequestEditor).mockClear();
  vi.mocked(service.editRequest).mockClear();
  vi.mocked(service.followEdit).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedDraft(db, "ws_impact", { id: "d1" });
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

describe("GET and POST /api/orders/[orderId]/edit", () => {
  it("answers 401 signed out, 404 to an outsider and 403 to staff, touching nothing", async () => {
    expect((await GET(get(), context)).status).toBe(401);
    expect((await POST(post({}), context)).status).toBe(401);
    state.session = STRANGER;
    expect((await GET(get(), context)).status).toBe(404);
    expect((await POST(post({}), context)).status).toBe(404);
    state.session = STAFF;
    for (const response of [await GET(get(), context), await POST(post({}), context)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only a manager can edit requests." });
    }
    expect(service.loadRequestEditor).not.toHaveBeenCalled();
    expect(service.editRequest).not.toHaveBeenCalled();
  });

  it("hands a manager and a platform admin the editor", async () => {
    for (const [session, role] of [
      [MANAGER, "manager"],
      [ADMIN, "platform"],
    ] as const) {
      state.session = session;
      const response = await GET(get(), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ editor: EDITOR });
      expect(vi.mocked(service.loadRequestEditor).mock.lastCall?.[1]).toEqual({
        workspaceId: "ws_impact",
        orderId: "d1",
        userId: session!.user.id,
        role,
      });
    }
  });

  it("saves an edit and follows up after the response", async () => {
    state.session = MANAGER;
    const response = await POST(post({ updatedAt: "2026-10-06T14:00:00Z", lines: [], locationId: null }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "edited", event: { id: "e1" }, warning: null });
    expect(vi.mocked(service.editRequest).mock.lastCall?.[2]).toEqual({ updatedAt: "2026-10-06T14:00:00Z", lines: [], locationId: null });
    await Promise.all(state.after);
    expect(service.followEdit).toHaveBeenCalled();
  });

  it("passes refusals through with their status and the fresh editor", async () => {
    state.session = MANAGER;
    vi.mocked(service.editRequest).mockResolvedValueOnce({ kind: "refused", status: 409, error: "This request changed.", editor: EDITOR });
    const stale = await POST(post({}), context);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "This request changed.", editor: EDITOR });
    vi.mocked(service.editRequest).mockResolvedValueOnce({ kind: "invalid", error: "Bad." });
    expect((await POST(post({}), context)).status).toBe(400);
    vi.mocked(service.editRequest).mockResolvedValueOnce({ kind: "unchanged" });
    expect(await (await POST(post({}), context)).json()).toEqual({ kind: "unchanged" });
    vi.mocked(service.loadRequestEditor).mockResolvedValueOnce({ kind: "refused", status: 502, error: "Shopify did not answer." });
    expect((await GET(get(), context)).status).toBe(502);
    expect(service.followEdit).not.toHaveBeenCalled();
  });
});
