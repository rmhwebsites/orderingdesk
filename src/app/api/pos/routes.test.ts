import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedUser } from "@/server/desk/test-helpers";
import { loadPoView } from "@/server/po/service";
import {
  draftBody,
  fakeBucket,
  mailEnv,
  NORTH_RECIPIENTS,
  ORDER,
  seedPoWorkspace,
  WS,
  type FakeBucket,
  type SentEmail,
} from "@/server/po/test-helpers";

// Every purchase order route: who may call it (401 signed out; 404, never
// 403, for outsiders, staff on manager routes, and other workspaces on a
// client host), the explicit-confirmation rule at the API, and what runs
// after the response. Email Service and R2 are stood in; the room and the
// team notification are mocked.

type Session = { user: { id: string; email: string } } | null;
const state: {
  db: Db | null;
  session: Session;
  host: string;
  env: CloudflareEnv | null;
  after: Promise<unknown>[];
} = { db: null, session: null, host: "orderingdesk.test", env: null, after: [] };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: state.env,
    ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));
vi.mock("@/server/broadcast", () => ({ broadcast: vi.fn(async () => undefined) }));
vi.mock("@/server/notify", () => ({ notifyPoSent: vi.fn(async () => ({ pushed: 0, emailed: 0 })) }));

const { GET: LIST, POST: CREATE } = await import("../orders/[orderId]/pos/route");
const { PATCH } = await import("./[poId]/route");
const { POST: SEND } = await import("./[poId]/send/route");
const { GET: PDF } = await import("./[poId]/pdf/route");
const { GET: LINES } = await import("../orders/[orderId]/po-lines/route");
const { broadcast } = await import("@/server/broadcast");
const { notifyPoSent } = await import("@/server/notify");

const MANAGER: Session = { user: { id: "u_manager", email: "manager@impact.example" } };
const STAFF: Session = { user: { id: "u_staff", email: "staff@impact.example" } };
const STRANGER: Session = { user: { id: "u_stranger", email: "stranger@example.com" } };
const ADMIN: Session = { user: { id: "u_admin", email: "admin@rmh.example" } };

let db: Db;
let bucket: FakeBucket;
let sent: SentEmail[];
let poId: string;

const orderContext = { params: Promise.resolve({ orderId: ORDER }) };
const poContext = () => ({ params: Promise.resolve({ poId }) });
const json = (method: string, body: unknown) =>
  new Request("https://orderingdesk.test/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let counter = 0;
// A confirmation of exactly what the PO says now (as the review step shows
// it) and who it goes to.
const confirmed = async (overrides: Record<string, unknown> = {}) => ({
  requestId: `route-request-${++counter}`,
  confirm: true,
  recipients: NORTH_RECIPIENTS,
  contentVersion: (await loadPoView(db, WS, poId, Date.now()))!.contentVersion,
  ...overrides,
});

beforeEach(async () => {
  db = openTestDb().db;
  state.db = db;
  state.session = null;
  state.host = "orderingdesk.test";
  state.after = [];
  bucket = fakeBucket();
  const mail = mailEnv(bucket);
  sent = mail.sent;
  state.env = { ...(mail.env as unknown as Record<string, unknown>), PLATFORM_ADMIN_EMAILS: "admin@rmh.example" } as unknown as CloudflareEnv;
  vi.mocked(broadcast).mockClear();
  vi.mocked(notifyPoSent).mockClear();
  await seedPoWorkspace(db);
  await seedUser(db, "u_admin", "admin@rmh.example");
  await db
    .insert(schema.workspaces)
    .values({ id: "ws_client", name: "Client", slug: "client", createdBy: "u", createdAt: 1, customDomain: "orders.client.example", customDomainStatus: "active" });
  state.session = MANAGER;
  const created = await CREATE(json("POST", draftBody()), orderContext);
  poId = ((await created.json()) as { po: { id: string } }).po.id;
  state.session = null;
  state.after = [];
  vi.mocked(broadcast).mockClear();
});

describe("GET /api/orders/[orderId]/pos", () => {
  it("answers 401 signed out and 404 to an outsider", async () => {
    expect((await LIST(new Request("https://x/"), orderContext)).status).toBe(401);
    state.session = STRANGER;
    expect((await LIST(new Request("https://x/"), orderContext)).status).toBe(404);
  });

  it("shows staff the history without the next number or manage rights", async () => {
    state.session = STAFF;
    const response = await LIST(new Request("https://x/"), orderContext);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { pos: Array<{ id: string }>; canManage: boolean; nextNumber: string | null };
    expect(body.pos.map((po) => po.id)).toEqual([poId]);
    expect(body.canManage).toBe(false);
    expect(body.nextNumber).toBeNull();
  });

  it("shows managers and platform admins the number the next send would take", async () => {
    for (const session of [MANAGER, ADMIN]) {
      state.session = session;
      const body = (await (await LIST(new Request("https://x/"), orderContext)).json()) as { canManage: boolean; nextNumber: string };
      expect(body.canManage).toBe(true);
      expect(body.nextNumber).toBe(`IMP-${new Date().getUTCFullYear()}-0001`);
    }
  });

  it("answers 404 on another workspace's client host, even to a platform admin", async () => {
    state.host = "orders.client.example";
    for (const session of [MANAGER, ADMIN]) {
      state.session = session;
      expect((await LIST(new Request("https://x/"), orderContext)).status).toBe(404);
    }
  });
});

describe("POST /api/orders/[orderId]/pos", () => {
  it("lets only managers and platform admins create a draft (404 for staff and outsiders)", async () => {
    expect((await CREATE(json("POST", draftBody()), orderContext)).status).toBe(401);
    for (const session of [STAFF, STRANGER]) {
      state.session = session;
      expect((await CREATE(json("POST", draftBody()), orderContext)).status).toBe(404);
    }
    state.session = ADMIN;
    const response = await CREATE(json("POST", draftBody()), orderContext);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { po: { state: string; number: string | null } }).po).toMatchObject({ state: "draft", number: null });
    await Promise.all(state.after);
    expect(vi.mocked(broadcast).mock.calls.map((call) => (call[2] as { kind: string; event: { type: string } }).event.type)).toEqual([
      "po_draft",
    ]);
    expect(sent).toHaveLength(0);
  });

  it("answers 400 with the problem for a bad draft", async () => {
    state.session = MANAGER;
    const response = await CREATE(json("POST", draftBody({ lines: [] })), orderContext);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("lines");
  });
});

describe("GET /api/orders/[orderId]/po-lines", () => {
  it("gives managers and platform admins the prefill, and 404 to staff and outsiders", async () => {
    expect((await LINES(new Request("https://x/"), orderContext)).status).toBe(401);
    for (const session of [STAFF, STRANGER]) {
      state.session = session;
      expect((await LINES(new Request("https://x/"), orderContext)).status).toBe(404);
    }
    await db
      .update(schema.orders)
      .set({ shopify: { items: [{ title: "Hard Hat", qty: 2, price: "10.00", sku: "HH-1", variant: "" }], itemsTruncated: false } })
      .where(eq(schema.orders.id, ORDER));
    for (const session of [MANAGER, ADMIN]) {
      state.session = session;
      const response = await LINES(new Request("https://x/"), orderContext);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        lines: [{ description: "Hard Hat", sku: "HH-1", quantity: 2, unitCost: null }],
        source: "stored",
      });
    }
  });

  it("answers 502 with the reason when a partial list cannot be completed", async () => {
    state.session = MANAGER;
    await db.update(schema.orders).set({ shopify: { items: [], itemsTruncated: true } }).where(eq(schema.orders.id, ORDER));
    const response = await LINES(new Request("https://x/"), orderContext);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("more items than Ordering Desk stores");
  });
});

describe("PATCH /api/pos/[poId]", () => {
  it("lets only managers and platform admins save a draft", async () => {
    expect((await PATCH(json("PATCH", draftBody({ notes: "x" })), poContext())).status).toBe(401);
    for (const session of [STAFF, STRANGER]) {
      state.session = session;
      expect((await PATCH(json("PATCH", draftBody({ notes: "x" })), poContext())).status).toBe(404);
    }
    state.session = MANAGER;
    const response = await PATCH(json("PATCH", draftBody({ notes: "Updated" })), poContext());
    expect(response.status).toBe(200);
    expect(((await response.json()) as { po: { notes: string } }).po.notes).toBe("Updated");
    const missing = await PATCH(json("PATCH", draftBody()), { params: Promise.resolve({ poId: "po_missing" }) });
    expect(missing.status).toBe(404);
  });

  it("answers 409 once the PO was sent", async () => {
    state.session = MANAGER;
    expect((await SEND(json("POST", await confirmed()), poContext())).status).toBe(200);
    const response = await PATCH(json("PATCH", draftBody({ notes: "Too late" })), poContext());
    expect(response.status).toBe(409);
  });
});

describe("POST /api/pos/[poId]/send", () => {
  it("answers 401 signed out and 404 to staff and outsiders, sending nothing", async () => {
    expect((await SEND(json("POST", await confirmed()), poContext())).status).toBe(401);
    for (const session of [STAFF, STRANGER]) {
      state.session = session;
      expect((await SEND(json("POST", await confirmed()), poContext())).status).toBe(404);
    }
    state.host = "orders.client.example";
    state.session = ADMIN;
    expect((await SEND(json("POST", await confirmed()), poContext())).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("sends nothing without an explicit confirmation of the reviewed recipients", async () => {
    state.session = MANAGER;
    const unconfirmed = await SEND(json("POST", { requestId: "route-unconfirmed-1" }), poContext());
    expect(unconfirmed.status).toBe(400);
    expect(((await unconfirmed.json()) as { recipients: unknown }).recipients).toEqual(NORTH_RECIPIENTS);

    const wrong = await SEND(json("POST", await confirmed({ recipients: { to: ["orders@northline.example"], cc: [] } })), poContext());
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { recipients: unknown }).recipients).toEqual(NORTH_RECIPIENTS);

    expect((await SEND(json("POST", { recipients: NORTH_RECIPIENTS }), poContext())).status).toBe(400);
    expect((await SEND(new Request("https://x/", { method: "POST", body: "not json" }), poContext())).status).toBe(400);

    // Recipients alone do not confirm what the PO says.
    const versionless = await SEND(json("POST", { requestId: "route-versionless-1", confirm: true, recipients: NORTH_RECIPIENTS }), poContext());
    expect(versionless.status).toBe(400);
    const asked = (await versionless.json()) as { contentVersion: string; po: { contentVersion: string; notes: string } };
    expect(asked.contentVersion).toBe(asked.po.contentVersion);
    expect(asked.po.notes).toBe("Deliver before noon");
    expect(sent).toHaveLength(0);
    expect(vi.mocked(notifyPoSent)).not.toHaveBeenCalled();
  });

  it("answers 409 with what would go out now when another manager saved after the review, then sends it once confirmed", async () => {
    state.session = MANAGER;
    const reviewed = await confirmed();
    const saved = await PATCH(json("PATCH", draftBody({ notes: "Second manager's notes" })), poContext());
    expect(saved.status).toBe(200);

    const refused = await SEND(json("POST", reviewed), poContext());
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      error: string;
      recipients: unknown;
      contentVersion: string;
      po: { notes: string; contentVersion: string; recipients: unknown };
    };
    expect(body.error).toContain("changed since you reviewed it");
    expect(body.recipients).toEqual(NORTH_RECIPIENTS);
    expect(body.po).toMatchObject({ notes: "Second manager's notes", recipients: NORTH_RECIPIENTS });
    expect(body.contentVersion).toBe(body.po.contentVersion);
    expect(body.contentVersion).not.toBe(reviewed.contentVersion);
    expect(sent).toHaveLength(0);

    const response = await SEND(json("POST", { ...reviewed, requestId: "route-reconfirmed-1", contentVersion: body.contentVersion }), poContext());
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("Second manager");
  });

  it("sends once with the PDF attached, then broadcasts and notifies the team, skipping addresses already emailed", async () => {
    state.session = MANAGER;
    const body = await confirmed();
    const response = await SEND(json("POST", body), poContext());
    expect(response.status).toBe(200);
    const { po } = (await response.json()) as { po: { state: string; number: string } };
    expect(po.state).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments?.[0]).toMatchObject({ filename: `${po.number}.pdf`, type: "application/pdf" });
    expect(sent[0].to).toEqual(NORTH_RECIPIENTS.to);
    expect(sent[0].cc).toEqual(NORTH_RECIPIENTS.cc);
    expect([...bucket.objects.keys()].every((key) => key.startsWith(`pos/${WS}/${poId}-`))).toBe(true);

    await Promise.all(state.after);
    expect(vi.mocked(broadcast).mock.calls.map((call) => (call[2] as { event: { type: string } }).event.type)).toEqual(["po_sent"]);
    expect(vi.mocked(notifyPoSent).mock.calls).toHaveLength(1);
    expect(vi.mocked(notifyPoSent).mock.calls[0][3]).toMatchObject({ poId, poNumber: po.number, actorId: "u_manager" });
    expect(vi.mocked(notifyPoSent).mock.calls[0][4]).toEqual({ alreadyEmailed: [...NORTH_RECIPIENTS.to, ...NORTH_RECIPIENTS.cc] });

    // The same request again, and a new send, both send nothing.
    const replay = await SEND(json("POST", body), poContext());
    expect(((await replay.json()) as { unchanged: string }).unchanged).toBe("replayed");
    const again = await SEND(json("POST", await confirmed()), poContext());
    expect(((await again.json()) as { unchanged: string }).unchanged).toBe("already-sent");
    expect(sent).toHaveLength(1);
  });

  it("resends only on request, without notifying the team again", async () => {
    state.session = MANAGER;
    await SEND(json("POST", await confirmed()), poContext());
    await Promise.all(state.after);
    vi.mocked(notifyPoSent).mockClear();
    const response = await SEND(json("POST", await confirmed({ resend: true })), poContext());
    expect(response.status).toBe(200);
    await Promise.all(state.after);
    expect(sent).toHaveLength(2);
    expect(vi.mocked(notifyPoSent)).not.toHaveBeenCalled();
  });

  it("answers 502 with the reason when the email fails, leaving the PO failed for a retry", async () => {
    state.session = MANAGER;
    const email = (state.env as unknown as { EMAIL: { send: ReturnType<typeof vi.fn> } }).EMAIL;
    email.send.mockImplementationOnce(async () => {
      throw new Error("sending domain not onboarded");
    });
    const response = await SEND(json("POST", await confirmed()), poContext());
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; po: { state: string; lastError: string } };
    expect(body.error).toContain("sending domain not onboarded");
    expect(body.po).toMatchObject({ state: "failed", lastError: body.error });
    await Promise.all(state.after);
    expect(vi.mocked(broadcast).mock.calls.map((call) => (call[2] as { event: { type: string } }).event.type)).toEqual(["po_failed"]);
    expect(vi.mocked(notifyPoSent)).not.toHaveBeenCalled();

    expect((await SEND(json("POST", await confirmed()), poContext())).status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe("GET /api/pos/[poId]/pdf", () => {
  it("streams the PDF to anyone in the workspace (staff too), and 404 to everyone else", async () => {
    state.session = MANAGER;
    await SEND(json("POST", await confirmed()), poContext());

    state.session = null;
    expect((await PDF(new Request("https://x/"), poContext())).status).toBe(401);
    state.session = STRANGER;
    expect((await PDF(new Request("https://x/"), poContext())).status).toBe(404);
    state.host = "orders.client.example";
    state.session = ADMIN;
    expect((await PDF(new Request("https://x/"), poContext())).status).toBe(404);

    state.host = "orderingdesk.test";
    for (const session of [STAFF, MANAGER, ADMIN]) {
      state.session = session;
      const response = await PDF(new Request("https://x/"), poContext());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="IMP-\d{4}-0001\.pdf"$/);
      expect(new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    }
  });

  it("answers 404 while a PO has no PDF", async () => {
    state.session = STAFF;
    expect((await PDF(new Request("https://x/"), poContext())).status).toBe(404);
    await db.update(schema.purchaseOrders).set({ pdfKey: `branding/${WS}/logo-light-${"a".repeat(32)}.png` }).where(eq(schema.purchaseOrders.id, poId));
    expect((await PDF(new Request("https://x/"), poContext())).status).toBe(404);
  });
});
