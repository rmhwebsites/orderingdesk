import { describe, it, expect, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { approveRosterEntry } from "./roster";
import { openTestDb, seedRosterEntry, seedUser, seedWorkspace } from "./desk/test-helpers";

// getAuth() reads the Cloudflare context and the request headers;
// authForHost (tested here) takes them as arguments.
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: {}, ctx: {} }) }));

const { authForHost, createAuth } = await import("./auth");

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

// Sign-in links are delivered after the response (ctx.waitUntil in
// production). The instances below hand that work to track, and
// requestLink waits for it once the response is in, so the assertions see
// what was sent.
const pending: Promise<unknown>[] = [];
const track = (promise: Promise<unknown>) => {
  pending.push(promise);
};

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
  const auth = await authForHost(
    db,
    ENV,
    host,
    async (message) => {
      sent.push(message);
    },
    track,
  );
  if (!auth) {
    throw new Error(`expected ${host} to be served`);
  }
  return { db, auth, sent };
}

type Auth = Awaited<ReturnType<typeof setup>>["auth"];

async function requestLink(
  auth: Auth,
  email: string,
  opts: { origin?: string; callbackURL?: string; cookie?: string; name?: string } = {},
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
      body: JSON.stringify({ email, callbackURL: opts.callbackURL ?? "/", ...(opts.name !== undefined ? { name: opts.name } : {}) }),
    }),
  );
  const result = { status: response.status, body: await response.json() };
  await Promise.all(pending.splice(0));
  return result;
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

// The session cookie pairs of a response, as a Cookie request header.
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

async function signInOn(host: string, origin: string, db: Db) {
  const sent: Sent[] = [];
  const auth = await authForHost(
    db,
    ENV,
    host,
    async (message) => {
      sent.push(message);
    },
    track,
  );
  await requestLink(auth!, "boss@example.com", { origin });
  const response = await openLink(auth!, sent[0].url);
  expect(response.status).toBe(302);
  return { auth: auth!, cookie: cookieHeader(response), link: sent[0].url };
}

// A tenant controls the DNS of their client host and can put their own TLS
// proxy in front of it, so whatever a browser sends there (a session cookie,
// a magic-link token) must be worthless on any other host.
describe("sessions and sign-in links are bound to the host that issued them", () => {
  it("refuses on the hub a session cookie minted on a client host, and the reverse", async () => {
    const { db } = await setup();
    const client = await signInOn("orders.impactrentals.store", CLIENT, db);
    const hub = await signInOn("orderingdesk.test", BASE, db);

    // Each cookie works where it was issued.
    expect((await client.auth.api.getSession({ headers: new Headers({ cookie: client.cookie }) }))?.user.email).toBe(
      "boss@example.com",
    );
    expect((await hub.auth.api.getSession({ headers: new Headers({ cookie: hub.cookie }) }))?.user.email).toBe(
      "boss@example.com",
    );
    // And nowhere else.
    expect(await hub.auth.api.getSession({ headers: new Headers({ cookie: client.cookie }) })).toBeNull();
    expect(await client.auth.api.getSession({ headers: new Headers({ cookie: hub.cookie }) })).toBeNull();
  });

  it("keeps the hub's cookie signing key, so sessions from before this change stay valid there", async () => {
    const { db } = await setup();
    const hub = await signInOn("orderingdesk.test", BASE, db);
    const plain = createAuth({
      db,
      env: ENV,
      origin: BASE,
      secret: ENV.BETTER_AUTH_SECRET,
      deliverMagicLink: async () => {},
    });
    expect((await plain.api.getSession({ headers: new Headers({ cookie: hub.cookie }) }))?.user.email).toBe(
      "boss@example.com",
    );
  });

  it("refuses on the hub a sign-in link issued on a client host, which still works where it was issued", async () => {
    const { db } = await setup();
    const sent: Sent[] = [];
    const client = await authForHost(
      db,
      ENV,
      "orders.impactrentals.store",
      async (message) => {
        sent.push(message);
      },
      track,
    );
    const hub = await authForHost(db, ENV, "orderingdesk.test", async () => {}, track);
    await requestLink(client!, "boss@example.com", { origin: CLIENT });
    const replayed = new URL(sent[0].url);
    const onHub = await openLink(hub!, `${BASE}${replayed.pathname}${replayed.search}`);
    expect(onHub.status).toBe(302);
    expect(onHub.headers.get("location") ?? "").toContain("error=INVALID_TOKEN");
    expect(cookieHeader(onHub)).not.toContain("session_token");
    expect(await db.select().from(schema.session)).toEqual([]);

    const onClient = await openLink(client!, sent[0].url);
    expect(onClient.status).toBe(302);
    expect(cookieHeader(onClient)).toContain("session_token");
  });

  it("does not store the sign-in token itself", async () => {
    const { db, auth, sent } = await setup();
    await requestLink(auth, "boss@example.com");
    const token = new URL(sent[0].url).searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(20);
    const rows = await db.select({ identifier: schema.verification.identifier }).from(schema.verification);
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).not.toContain(token);
  });
});

describe("sign-in link delivery never shapes the response (no account enumeration)", () => {
  it("answers 200 at once while delivery runs after the response, and swallows a failed delivery", async () => {
    const { db } = openTestDb();
    const scheduled: Promise<unknown>[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempts: string[] = [];
    const auth = await authForHost(
      db,
      ENV,
      "orderingdesk.test",
      async (message) => {
        attempts.push(message.email);
        await slow;
        throw new Error("sending domain offboarded");
      },
      (promise) => {
        scheduled.push(promise);
      },
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Delivery for the known email has not finished (it never does until
      // released), yet the request has answered, exactly like the stranger's.
      const boss = await requestLink(auth!, "boss@example.com");
      const stranger = await requestLink(auth!, "stranger@example.com");
      expect(boss).toEqual({ status: 200, body: { status: true } });
      expect(stranger).toEqual(boss);
      expect(scheduled).toHaveLength(2);
      release();
      await Promise.all(scheduled);
      expect(attempts).toEqual(["boss@example.com"]);
      // Logged without the address.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(errors.mock.calls)).not.toContain("boss@example.com");
    } finally {
      errors.mockRestore();
    }
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
    const auth = await authForHost(db, env, host, undefined, track);
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
    await seedRosterEntry(db, { workspaceId: "ws_impact", email: "buyer@example.com", role: "manager", state: "approved" });
    for (const email of ["old@example.com", "Crew@example.com", "buyer@example.com"]) {
      expect((await requestLink(auth, email)).body).toEqual({ status: true });
    }
    expect(sent.map((s) => s.email.toLowerCase())).toEqual([
      "old@example.com",
      "crew@example.com",
      "buyer@example.com",
    ]);
  });

  // Any storefront visitor can create a Shopify customer with tags (the
  // newsletter form's contact[tags]). Until a manager approves the request
  // the tagged email is a stranger: no link, no account, no membership.
  it("treats a storefront-tagged customer as a stranger until a manager approves the request", async () => {
    const { db, auth, sent } = await setup();
    const rosterId = await seedRosterEntry(db, { workspaceId: "ws_impact", email: "sneaky@example.com", role: "manager" });
    const tagged = await requestLink(auth, "sneaky@example.com");
    const stranger = await requestLink(auth, "stranger@example.com");
    expect(tagged).toEqual(stranger);
    expect(sent).toEqual([]);
    expect(await users(db)).toEqual([]);

    await approveRosterEntry(db, { workspaceId: "ws_impact", rosterId, approverId: "u_manager" }, {});
    await requestLink(auth, "sneaky@example.com");
    expect(sent.map((s) => s.email)).toEqual(["sneaky@example.com"]);
    const response = await openLink(auth, sent[0].url);
    expect(cookieHeader(response)).toContain("session_token");
    const memberships = await db
      .select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers);
    expect(memberships).toEqual([{ role: "manager", source: "shopify" }]);
  });

  it("refuses the account of a tagged customer whose request was denied after the link was sent", async () => {
    const { db, auth, sent } = await setup();
    await seedRosterEntry(db, { workspaceId: "ws_impact", email: "crew2@example.com", role: "staff", state: "approved" });
    await requestLink(auth, "crew2@example.com");
    await db.update(schema.shopifyRoster).set({ approvedRole: null, approvedAt: null, approvedBy: null, deniedAt: 9 });
    const response = await openLink(auth, sent[0].url);
    expect(response.headers.get("location") ?? "").toContain("error=");
    expect(await users(db)).toEqual([]);
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
    await seedRosterEntry(db, { workspaceId: "ws_impact", email: "buyer@example.com", role: "manager", state: "approved" });
    await requestLink(auth, "buyer@example.com");
    await openLink(auth, sent[0].url);
    const memberships = await db
      .select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers);
    expect(memberships).toEqual([{ role: "manager", source: "shopify" }]);
  });

  // The magic-link request body accepts a name for a new account, so whoever
  // asks for the link (anyone who knows an invited address) could pre-name
  // that person's account. The server picks the name instead.
  it("names a new account after its email's local part, ignoring any name the request sent", async () => {
    const { db, auth, sent } = await setup();
    await db.insert(schema.pendingInvites).values([
      { id: "i1", email: "crew.member@example.com", workspaceId: "ws_impact", role: "staff", invitedBy: "u_x", createdAt: 1 },
      { id: "i2", email: "plain@example.com", workspaceId: "ws_impact", role: "staff", invitedBy: "u_x", createdAt: 1 },
    ]);
    await requestLink(auth, "Crew.Member@example.com", { name: "Pat Smith (CEO)" });
    await requestLink(auth, "plain@example.com");
    for (const message of sent) {
      expect((await openLink(auth, message.url)).status).toBe(302);
    }
    const created = await db.select({ email: schema.user.email, name: schema.user.name }).from(schema.user).orderBy(asc(schema.user.email));
    expect(created).toEqual([
      { email: "crew.member@example.com", name: "crew.member" },
      { email: "plain@example.com", name: "plain" },
    ]);
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
    await seedRosterEntry(db, { workspaceId: "ws_impact", email: "old@example.com", role: "staff", state: "approved" });
    await requestLink(auth, "old@example.com");
    await openLink(auth, sent[0].url);
    const memberships = await db
      .select({ userId: schema.workspaceMembers.userId, source: schema.workspaceMembers.source })
      .from(schema.workspaceMembers);
    expect(memberships).toEqual([{ userId: "u_old", source: "shopify" }]);
  });
});

// better-auth's account endpoints act on the one global user from every
// host. A tenant who proxies their own client host and captures a cookie
// there could otherwise rename the user (the name shows in other tenants'
// timelines) or revoke all their sessions. The app uses none of them, so
// every endpoint but the sign-in flow answers 404, on the hub and on client
// hosts alike, signed in or not.
const UNUSED_AUTH_PATHS = [
  "/update-user",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/list-accounts",
  "/unlink-account",
  "/link-social",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
  "/update-session",
  "/sign-in/social",
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  "/reset-password",
  "/verify-password",
  "/send-verification-email",
  "/verify-email",
  "/ok",
  // Routes with a path parameter.
  "/callback/google",
  "/reset-password/a-token",
];

describe("better-auth endpoints the app does not use", () => {
  const hosts = [
    ["the hub", "orderingdesk.test", BASE],
    ["a client host", "orders.impactrentals.store", CLIENT],
  ] as const;

  for (const [label, host, origin] of hosts) {
    it(`answer 404 on ${label}, with a valid session, and change nothing`, async () => {
      const { db } = await setup();
      const { auth, cookie } = await signInOn(host, origin, db);
      const sessionsBefore = await db.select({ id: schema.session.id }).from(schema.session);
      const statuses: Array<[string, string, number]> = [];
      for (const path of UNUSED_AUTH_PATHS) {
        for (const method of ["GET", "POST"]) {
          const response = await auth.handler(
            new Request(`${origin}/api/auth${path}`, {
              method,
              headers: { origin, cookie, "content-type": "application/json" },
              body:
                method === "POST"
                  ? JSON.stringify({ name: "Renamed by a tenant", revokeOtherSessions: true, token: "x", newEmail: "x@evil.example" })
                  : undefined,
            }),
          );
          statuses.push([method, path, response.status]);
        }
      }
      expect(statuses.filter(([, , status]) => status !== 404)).toEqual([]);
      const [boss] = await db.select({ name: schema.user.name, email: schema.user.email }).from(schema.user);
      expect(boss.name).not.toBe("Renamed by a tenant");
      expect(boss.email).toBe("boss@example.com");
      expect(await db.select({ id: schema.session.id }).from(schema.session)).toEqual(sessionsBefore);
    });

    it(`keep sign-in, get-session and sign-out working on ${label}`, async () => {
      const { db } = await setup();
      const { auth, cookie } = await signInOn(host, origin, db);
      const session = await auth.handler(new Request(`${origin}/api/auth/get-session`, { headers: { origin, cookie } }));
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user: { email: string } }).user.email).toBe("boss@example.com");

      const signOut = await auth.handler(
        new Request(`${origin}/api/auth/sign-out`, {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(signOut.status).toBe(200);
      expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    });
  }
});
