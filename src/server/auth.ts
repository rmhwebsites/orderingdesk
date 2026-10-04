import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDbFromEnv, type Db } from "@/db";
import { canCreateAccount, hasAccountRoute } from "./access";
import { sendMagicLinkEmail } from "./email/magic-link";
import { loadMailWorkspace } from "./email/workspace";
import { hostOrigin, resolveHost, type HostResolution } from "./host";
import { claimAccessOnSignIn } from "./invites";
import { requestHost } from "./request-host";

type AuthEnv = {
  APP_URL: string;
  BETTER_AUTH_SECRET: string;
  PLATFORM_ADMIN_EMAILS?: string;
};

// The better-auth instance, with closed sign-up (platform amendment
// section 2, rules in src/server/access.ts):
// - Magic-link request: sendMagicLink hands the delivery to `background`
//   (ctx.waitUntil in production) and returns at once, so better-auth
//   answers {status: true} before anything depends on the address. In the
//   background the link is delivered only when the email has a route to an
//   account (an existing user, a bootstrap platform admin, a pending
//   invite, or a Shopify roster entry); a failed delivery is logged without
//   the address and never reaches the response. An allowed and a refused
//   email therefore get the same answer in the same time, so nobody can
//   probe which addresses have access, not even through a sender that
//   errors or a slow mail send.
// - Account creation: databaseHooks.user.create.before refuses (returns
//   false) unless canCreateAccount allows the email at the moment the link
//   is opened, so a link requested while an invite existed cannot create an
//   account after the invite was withdrawn. The magic-link verify endpoint
//   then redirects with an error and creates no session.
// - Every sign-in (user.create.after for the first, session.create.after
//   for each) claims pending invites and the Shopify roster for the email.
//
// One host per instance (platform amendment section 1): origin is the host
// the request was routed to, either the hub or an active client host
// (hostOrigin in src/server/host.ts). It is better-auth's baseURL, so magic
// links point back at the host where sign-in was requested, and the only
// trusted origin, so another host's callback URL or Origin is refused.
// Cookies carry no Domain attribute, so each host keeps its own session.
//
// Bound to that host as well. A tenant controls the DNS of their client
// host and can put their own TLS proxy in front of it, so a session cookie
// or a sign-in link sent there must be worthless anywhere else:
// - secret (hostSecret below) signs the session cookies. The hub keeps
//   BETTER_AUTH_SECRET itself; each client host gets its own key derived
//   from it and its origin. better-auth checks the cookie signature before
//   it looks a session up, on every endpoint, so a cookie minted on one
//   host is no session on another, although the session table is shared.
// - The magic-link token is stored as a hash of the origin and the token
//   (linkTokenHash), so a link issued on one host finds nothing on
//   another, and the database never holds a usable token.
export function createAuth(opts: {
  db: Db;
  env: AuthEnv;
  origin: string;
  secret: string;
  deliverMagicLink: (email: string, url: string) => Promise<void>;
  background?: (work: Promise<unknown>) => void;
}) {
  const { db, env } = opts;
  const background = opts.background ?? ((work: Promise<unknown>) => void work);
  return betterAuth({
    baseURL: opts.origin,
    trustedOrigins: [opts.origin],
    secret: opts.secret,
    database: drizzleAdapter(db, { provider: "sqlite" }),
    emailAndPassword: { enabled: false },
    // Rate-limit counters persist in D1 (rate_limit table); the in-memory
    // default resets per isolate, which is useless on Workers.
    rateLimit: { storage: "database" },
    // Cloudflare sets cf-connecting-ip on every request and overwrites any
    // client-sent value, so it is the trustworthy key for rate limiting.
    // Without it every visitor shares one global bucket per path.
    // disableOriginCheck false is better-auth's production default, stated
    // so that tests (where better-auth skips the check) exercise it too.
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] }, disableOriginCheck: false },
    plugins: [
      magicLink({
        storeToken: { type: "custom-hasher", hash: (token) => linkTokenHash(opts.origin, token) },
        async sendMagicLink({ email, url }) {
          background(
            (async () => {
              if (await hasAccountRoute(db, env, email)) {
                await opts.deliverMagicLink(email, url);
              }
            })().catch((e: unknown) => {
              console.error(
                "[auth] " +
                  JSON.stringify({
                    magicLink: "delivery failed",
                    origin: opts.origin,
                    error: e instanceof Error ? e.message.split(email).join("<recipient>").slice(0, 200) : "unknown",
                  }),
              );
            }),
          );
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await canCreateAccount(db, env, user.email))) {
              return false;
            }
          },
          after: async (user) => {
            await claimAccessOnSignIn(db, user.id, user.email);
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await claimAccessOnSignIn(db, session.userId);
          },
        },
      },
    },
  });
}

export type MagicLinkMessage = { email: string; url: string; workspaceId: string | null };
export type MagicLinkDeliverer = (message: MagicLinkMessage) => Promise<void>;
export type Background = (work: Promise<unknown>) => void;

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The cookie signing key for a host: BETTER_AUTH_SECRET itself on the hub
// (sessions from before host binding stay valid there), and for a client
// host HMAC-SHA256(BETTER_AUTH_SECRET, purpose + origin), so no two hosts
// share a key and none can be worked out without the secret.
export async function hostSecret(secret: string, resolution: HostResolution, origin: string): Promise<string> {
  if (resolution.kind === "hub") {
    return secret;
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const derived = await crypto.subtle.sign("HMAC", key, encoder.encode(`ordering-desk.host-secret.v1:${origin}`));
  return base64Url(derived);
}

// What the verification table stores for a sign-in token: SHA-256 of the
// origin and the token, so the token works only on the host that issued it.
export async function linkTokenHash(origin: string, token: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", encoder.encode(`${origin}\n${token}`)));
}

// The auth instance for a resolved host, or null when the host is refused
// (unknown, which includes a client domain that is not active). A sign-in
// requested on a client host names that workspace to the deliverer, which
// sends the link from and branded as the workspace. background runs the
// delivery after the response (ctx.waitUntil in production).
export async function authForResolution(
  db: Db,
  env: CloudflareEnv,
  resolution: HostResolution,
  deliver?: MagicLinkDeliverer,
  background?: Background,
) {
  const origin = hostOrigin(env, resolution);
  if (origin === null) {
    return null;
  }
  const workspaceId = resolution.kind === "workspace" ? resolution.workspace.id : null;
  const send: MagicLinkDeliverer =
    deliver ??
    (async (message) =>
      sendMagicLinkEmail(env, {
        to: message.email,
        url: message.url,
        workspace: message.workspaceId ? await loadMailWorkspace(db, message.workspaceId) : null,
      }));
  return createAuth({
    db,
    env,
    origin,
    secret: await hostSecret(env.BETTER_AUTH_SECRET, resolution, origin),
    deliverMagicLink: (email, url) => send({ email, url, workspaceId }),
    background,
  });
}

// authForResolution for a raw Host value (lowercased, port ignored).
export async function authForHost(
  db: Db,
  env: CloudflareEnv,
  host: string | null | undefined,
  deliver?: MagicLinkDeliverer,
  background?: Background,
) {
  return authForResolution(db, env, await resolveHost(db, env, host), deliver, background);
}

export type Auth = NonNullable<Awaited<ReturnType<typeof authForResolution>>>;

// Instantiated per request: the D1 binding only exists inside a request's
// Cloudflare context, so there is no module-level auth singleton. The host
// is the one the platform routed (requestHost; custom-worker.ts pins
// x-forwarded-host to it), never a value the client chose. null means the
// host is refused: callers answer 404.
export async function getAuth(resolution?: HostResolution): Promise<Auth | null> {
  const { env, ctx } = getCloudflareContext();
  if (env.APP_URL.includes("REPLACE_ME")) {
    throw new Error("APP_URL is not configured (wrangler.jsonc still has the placeholder)");
  }
  const background: Background | undefined =
    typeof ctx?.waitUntil === "function" ? (work) => ctx.waitUntil(work) : undefined;
  return authForResolution(getDbFromEnv(env), env, resolution ?? (await requestHost()), undefined, background);
}
