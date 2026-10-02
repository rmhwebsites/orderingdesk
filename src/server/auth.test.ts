import { describe, it, expect, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedUser, seedWorkspace } from "./desk/test-helpers";

// getAuth() reads the Cloudflare context and the request headers;
// authForHost (tested here) takes them as arguments.
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: {}, ctx: {} }) }));

const { authForHost } = await import("./auth");

// Real better-auth (1.7.x) endpoints against the in-memory database: the
// magic-link request, the link itself, user creation and its hooks. Only the
// email delivery is captured instead of sent.
const BASE = "https://orderingdesk.test";
const CLIENT = "https://orders.impactrentals.store";
const ENV = {
  APP_URL: BASE,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
  PLATFORM_ADMIN_EMAILS: "boss@example.com",
} as unknown as CloudflareEnv;

type Sent = { email: string; url: string; workspaceId: string | null };

async function setDomain(db: Db, id: string, domain: string, status: "pending" | "active" | "error") {
  await db
    .update(schema.workspaces)
    .set({ customDomain: domain, customDomainStatus: status })
    .where(eq(schema.workspaces.id, id));
}

async function setup(host = "orderingdesk.test") {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_pending");
  await setDomain(db, "ws_impact", "orders.impactrentals.store", "active");
  await setDomain(db, "ws_pending", "orders.pending.example", "pending");
  const sent: Sent[] = [];
  const auth = await authForHost(db, ENV, host, async (message) => {
    sent.push(message);
  });
  if (!auth) {
    throw new Error(`expected ${host} to be served`);
  }
  return { db, auth, sent };
}

type Auth = Awaited<ReturnType<typeof setup>>["auth"];

async function requestLink(
  auth: Auth,
  email: string,
  opts: { origin?: string; callbackURL?: string; cookie?: string } = {},
) {
  const origin = opts.origin ?? BASE;
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: JSON.stringify({ email, callbackURL: opts.callbackURL ?? "/" }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function openLink(auth: Auth, url: string) {
  return auth.handler(new Request(url, { headers: { origin: new URL(url).origin } }));
}

function users(db: Db) {
  return db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).orderBy(asc(schema.user.email));
}

describe("auth per host (baseURL and trusted origin from the routed host)", () => {
  it("serves the hub on the APP_URL origin, so its links point at the hub", async () => {
    const { auth, sent } = await setup("orderingdesk.test");
    expect((await requestLink(auth, "boss@example.com")).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url.startsWith(`${BASE}/api/auth/magic-link/verify?`)).toBe(true);
    expect(sent[0].workspaceId).toBeNull();
  });

  it("serves an active client host on its own origin and names its workspace to the sender", async () => {
    const { auth, sent } = await setup("Orders.ImpactRentals.Store:443");
    expect((await requestLink(auth, "boss@example.com", { origin: CLIENT })).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url.startsWith(`${CLIENT}/api/auth/magic-link/verify?`)).toBe(true);
    expect(sent[0].workspaceId).toBe("ws_impact");
  });

  it("refuses a pending client host and an unknown host", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_pending");
    await setDomain(db, "ws_pending", "orders.pending.example", "pending");
    const deliver = async () => {};
    expect(await authForHost(db, ENV, "orders.pending.example", deliver)).toBeNull();
    expect(await authForHost(db, ENV, "evil.example", deliver)).toBeNull();
    expect(await authForHost(db, ENV, null, deliver)).toBeNull();
  });

  it("trusts exactly its own origin: another host's callback or origin is refused", async () => {
    const client = await setup("orders.impactrentals.store");
    const crossCallback = await requestLink(client.auth, "boss@example.com", {
      origin: CLIENT,
      callbackURL: `${BASE}/`,
    });
    expect(crossCallback.status).toBe(403);
    const crossOrigin = await requestLink(client.auth, "boss@example.com", {
      origin: BASE,
      cookie: "unrelated=1",
    });
    expect(crossOrigin.status).toBe(403);
    expect(client.sent).toEqual([]);

    const hub = await setup("orderingdesk.test");
    expect((await requestLink(hub.auth, "boss@example.com", { callbackURL: `${CLIENT}/` })).status).toBe(403);
    expect(hub.sent).toEqual([]);
  });

  it("signs in on the client host with a host-only session cookie", async () => {
    const { auth, sent } = await setup("orders.impactrentals.store");
    await requestLink(auth, "boss@example.com", { origin: CLIENT });
    const response = await openLink(auth, sent[0].url);
    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("session_token=");
    expect(cookie.toLowerCase()).not.toContain("domain=");
    expect(response.headers.get("location")).toBe(`${CLIENT}/`);
  });
});

describe("sign-in email by host (the default deliverer, through the EMAIL binding)", () => {
  type Mail = { from: unknown; subject: string; html: string; text?: string };

  async function sentFor(host: string, origin: string) {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_impact");
    await db
      .update(schema.workspaces)
      .set({
        name: "Impact Rentals",
        customDomain: "orders.impactrentals.store",
        customDomainStatus: "active",
        sendingVerifiedAt: 1,
        branding: {
          logo: {
            light: { key: "branding/ws_impact/logo.svg", contentType: "image/svg+xml", pngKey: "branding/ws_impact/logo.png" },
            dark: null,
          },
        },
      })
      .where(eq(schema.workspaces.id, "ws_impact"));
    const email = { send: vi.fn(async (_message: Mail) => ({ messageId: "m1" })) };
    const env = { ...ENV, EMAIL: email, EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>" } as unknown as CloudflareEnv;
    const auth = await authForHost(db, env, host);
    expect((await requestLink(auth!, "boss@example.com", { origin })).status).toBe(200);
    expect(email.send).toHaveBeenCalledTimes(1);
    return email.send.mock.calls[0][0];
  }

  it("sends a sign-in requested on a client host from, and branded as, that workspace", async () => {
    const mail = await sentFor("orders.impactrentals.store", CLIENT);
    expect(mail.from).toEqual({ name: "Impact Rentals", email: "accounts@orders.impactrentals.store" });
    expect(mail.subject).toBe("Sign in to Impact Rentals orders");
    expect(mail.html).toContain("https://orderingdesk.test/api/branding/ws_impact/logo.png");
    expect(mail.text).toContain(`Sign in: ${CLIENT}/api/auth/magic-link/verify?`);
  });

  it("sends a sign-in requested on the hub from Ordering Desk, in its look", async () => {
    const mail = await sentFor("orderingdesk.test", BASE);
    expect(mail.from).toEqual({ name: "Ordering Desk", email: "orders@orderingdesk.com" });
    expect(mail.subject).toBe("Sign in to Ordering Desk");
    expect(mail.html).not.toContain("logo.png");
    expect(mail.text).toContain(`Sign in: ${BASE}/api/auth/magic-link/verify?`);
  });
});

describe("magic-link request (closed sign-up, no enumeration)", () => {
  it("answers a stranger exactly like everyone else and sends nothing", async () => {
    const { auth, sent } = await setup();
    const stranger = await requestLink(auth, "stranger@example.com");
    const boss = await requestLink(auth, "boss@example.com");
    expect(stranger).toEqual({ status: 200, body: { status: true } });
    expect(stranger).toEqual(boss);
    expect(sent.map((s) => s.email)).toEqual(["boss@example.com"]);
  });

  it("sends a link to an existing user, an invited email and a tagged Shopify customer", async () => {
    const { db, auth, sent } = await setup();
    await seedUser(db, "u_old", "old@example.com");
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "crew@example.com",
      workspaceId: "ws_impact",
      role: "staff",
      invitedBy: "u_old",
      createdAt: 1,
    });
    await db.insert(schema.shopifyRoster).values({
      id: "r1",
      workspaceId: "ws_impact",
      email: "buyer@example.com",
      role: "manager",
      shopifyCustomerId: "c1",
      updatedAt: 1,
    });
    for (const email of ["old@example.com", "Crew@example.com", "buyer@example.com"]) {
      expect((await requestLink(auth, email)).body).toEqual({ status: true });
    }
    expect(sent.map((s) => s.email.toLowerCase())).toEqual([
      "old@example.com",
      "crew@example.com",
      "buyer@example.com",
    ]);
  });
});

describe("account creation", () => {
  it("creates an invited person's account and claims the invite as a manual membership", async () => {
    const { db, auth, sent } = await setup();
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "crew@example.com",
      workspaceId: "ws_impact",
      role: "staff",
      invitedBy: "u_x",
      createdAt: 1,
    });
    await requestLink(auth, "crew@example.com");
    const response = await openLink(auth, sent[0].url);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie") ?? "").toContain("session_token");

    const [created] = await db.select().from(schema.user).where(eq(schema.user.email, "crew@example.com"));
    expect(created).toBeDefined();
    const memberships = await db
      .select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, created.id));
    expect(memberships).toEqual([{ role: "staff", source: "manual" }]);
    expect(await db.select().from(schema.pendingInvites)).toEqual([]);
  });

  it("creates a tagged Shopify customer's account as a shopify membership", async () => {
    const { db, auth, sent } = await setup();
    await db.insert(schema.shopifyRoster).values({
      id: "r1",
      workspaceId: "ws_impact",
      email: "buyer@example.com",
      role: "manager",
      shopifyCustomerId: "c1",
      updatedAt: 1,
    });
    await requestLink(auth, "buyer@example.com");
    await openLink(auth, sent[0].url);
    const memberships = await db
      .select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers);
    expect(memberships).toEqual([{ role: "manager", source: "shopify" }]);
  });

  it("refuses to create the account when the route to it is gone by the time the link is opened", async () => {
    const { db, auth, sent } = await setup();
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "crew@example.com",
      workspaceId: "ws_impact",
      role: "staff",
      invitedBy: "u_x",
      createdAt: 1,
    });
    await requestLink(auth, "crew@example.com");
    // The manager withdraws the invite before the link is opened.
    await db.delete(schema.pendingInvites);

    const response = await openLink(auth, sent[0].url);
    expect(response.status).toBe(302);
    expect(response.headers.get("location") ?? "").toContain("error=");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await users(db)).toEqual([]);
    expect(await db.select().from(schema.session)).toEqual([]);
  });

  it("claims access granted after the first sign-up at the next sign-in", async () => {
    const { db, auth, sent } = await setup();
    await seedUser(db, "u_old", "old@example.com");
    await db.insert(schema.shopifyRoster).values({
      id: "r1",
      workspaceId: "ws_impact",
      email: "old@example.com",
      role: "staff",
      shopifyCustomerId: "c1",
      updatedAt: 1,
    });
    await requestLink(auth, "old@example.com");
    await openLink(auth, sent[0].url);
    const memberships = await db
      .select({ userId: schema.workspaceMembers.userId, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers);
    expect(memberships).toEqual([{ userId: "u_old", source: "shopify" }]);
  });
});
