import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The push routes against an in-memory database. The routed host can be
// the hub or IMPACT's client host; the session and env are stood in.
const state: {
  db: Db | null;
  session: { user: { id: string; email: string } } | null;
  host: string;
  env: Record<string, unknown>;
} = { db: null, session: null, host: "orderingdesk.test", env: {} };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host, "user-agent": "Test Phone" }) }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: state.env, ctx: {} }) }));
// Like the real getAuth: no auth instance (so the guards answer 404) on a
// refused host.
vi.mock("@/server/auth", () => ({
  getAuth: async (host: { kind: string }) =>
    host.kind === "unknown" ? null : { api: { getSession: async () => state.session } },
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET: KEY } = await import("./key/route");
const { POST: SUBSCRIBE, DELETE: UNSUBSCRIBE } = await import("./subscribe/route");

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/device-1",
  keys: { p256dh: "B" + "A".repeat(86), auth: "abcdefghijklmnopqrstuv" },
};

function json(method: string, body: unknown) {
  return new Request(`https://${state.host}/api/push/subscribe`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "Test Phone" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.host = "orderingdesk.test";
  state.env = {
    APP_URL: "https://orderingdesk.test",
    VAPID_PUBLIC_KEY: "BPublicKeyForTests",
    VAPID_PRIVATE_KEY: "private",
    VAPID_SUBJECT: "mailto:ops@example.com",
  };
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.workspaces)
    .set({ customDomain: "orders.impactrentals.store", customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_other", "other@example.com");
});

describe("GET /api/push/key", () => {
  it("answers 401 signed out", async () => {
    expect((await KEY()).status).toBe(401);
  });

  it("gives a signed-in person the public key, never the private one", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await KEY();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ publicKey: "BPublicKeyForTests" });
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("answers 503 while push is not set up", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    state.env = { APP_URL: "https://orderingdesk.test" };
    const response = await KEY();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Push notifications are not set up yet." });
  });

  it("answers 404 on a host that is not the hub or an active client host", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    state.host = "stranger.example";
    expect((await KEY()).status).toBe(404);
  });
});

describe("/api/push/subscribe", () => {
  it("answers 401 signed out and stores nothing", async () => {
    expect((await SUBSCRIBE(json("POST", subscription))).status).toBe(401);
    expect((await UNSUBSCRIBE(json("DELETE", { endpoint: subscription.endpoint }))).status).toBe(401);
    expect(await state.db!.select().from(schema.pushSubscriptions)).toEqual([]);
  });

  it("stores the caller's subscription with the host it was made on", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    state.host = "orders.impactrentals.store";
    const response = await SUBSCRIBE(json("POST", subscription));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const rows = await state.db!.select().from(schema.pushSubscriptions);
    expect(rows).toEqual([
      expect.objectContaining({ userId: "u_staff", endpoint: subscription.endpoint, host: "orders.impactrentals.store", userAgent: "Test Phone" }),
    ]);
  });

  it("records the hub host for a subscription made on the hub", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    await SUBSCRIBE(json("POST", subscription));
    const [row] = await state.db!.select().from(schema.pushSubscriptions);
    expect(row.host).toBe("orderingdesk.test");
  });

  it("answers 400 for something that is not a push subscription", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const response = await SUBSCRIBE(json("POST", { endpoint: "https://evil.example/x", keys: subscription.keys }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "This browser's push service is not supported" });
  });

  it("removes the caller's own subscription and answers 404 for anyone else's", async () => {
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    await SUBSCRIBE(json("POST", subscription));
    state.session = { user: { id: "u_other", email: "other@example.com" } };
    expect((await UNSUBSCRIBE(json("DELETE", { endpoint: subscription.endpoint }))).status).toBe(404);
    expect(await state.db!.select().from(schema.pushSubscriptions)).toHaveLength(1);
    state.session = { user: { id: "u_staff", email: "staff@example.com" } };
    const removed = await UNSUBSCRIBE(json("DELETE", { endpoint: subscription.endpoint }));
    expect(removed.status).toBe(200);
    expect(await state.db!.select().from(schema.pushSubscriptions)).toEqual([]);
    expect((await UNSUBSCRIBE(json("DELETE", {}))).status).toBe(400);
  });
});
