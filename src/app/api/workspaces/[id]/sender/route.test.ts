import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The sender routes for real against an in-memory database, on the hub; the
// session, routed host and env (with a stub EMAIL binding) are stood in.
const email = { send: vi.fn(async (_message: { from: unknown; to: string[] }) => ({ messageId: "m1" })) };
const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = {
  db: null,
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      APP_URL: "https://orderingdesk.test",
      PLATFORM_ADMIN_EMAILS: "boss@example.com",
      EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>",
      EMAIL: email,
    },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async () => ({ api: { getSession: async () => state.session } }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { PUT } = await import("./route");
const { POST: VERIFY } = await import("./verify/route");

const context = { params: Promise.resolve({ id: "ws_impact" }) };

function put(body: unknown) {
  return new Request("https://orderingdesk.test/api/workspaces/ws_impact/sender", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  email.send.mockClear();
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.workspaces)
    .set({ name: "Impact Rentals", customDomain: "orders.impactrentals.store", customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedMember(db, "ws_impact", "u_manager", "manager");
});

describe("/api/workspaces/[id]/sender", () => {
  it("answers 401 signed out and 404 to a workspace manager, sending nothing", async () => {
    expect((await PUT(put({ address: "hello@impactrentals.store" }), context)).status).toBe(401);
    expect((await VERIFY(new Request("https://x/"), context)).status).toBe(401);
    state.session = { user: { id: "u_manager", email: "manager@example.com" } };
    expect((await PUT(put({ address: "hello@impactrentals.store" }), context)).status).toBe(404);
    expect((await VERIFY(new Request("https://x/"), context)).status).toBe(404);
    expect(email.send).not.toHaveBeenCalled();
  });

  it("lets a platform admin set an override and verify it with a test send to themselves", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const saved = await PUT(put({ address: "hello@impactrentals.store" }), context);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ address: "hello@impactrentals.store", verified: false });

    const verified = await VERIFY(new Request("https://x/"), context);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      address: "hello@impactrentals.store",
      verified: true,
      from: "Impact Rentals <hello@impactrentals.store>",
    });
    expect(email.send.mock.calls[0][0].to).toEqual(["boss@example.com"]);
  });

  it("answers 422 with the onboarding instruction when Cloudflare refuses the domain", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    email.send.mockRejectedValueOnce(new Error("could not find domain config of sending domain"));
    const refused = await VERIFY(new Request("https://x/"), context);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      error:
        "Onboard orders.impactrentals.store under Compute > Email Service > Email Sending in Cloudflare (Email Sending only), then press Verify again.",
    });
  });

  it("answers 400 for an address that is not one", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    expect((await PUT(put({ address: "nope" }), context)).status).toBe(400);
  });
});
