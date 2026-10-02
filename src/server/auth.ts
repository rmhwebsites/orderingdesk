import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDbFromEnv, type Db } from "@/db";
import { canCreateAccount, hasAccountRoute } from "./access";
import { sendMagicLinkEmail } from "./email/magic-link";
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
// - Magic-link request: sendMagicLink delivers only when the email has a
//   route to an account (an existing user, a bootstrap platform admin, a
//   pending invite, or a Shopify roster entry). Otherwise it returns without
//   sending, and better-auth answers {status: true} exactly as it does for
//   an allowed email, so nobody can probe which addresses have access.
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
export function createAuth(opts: {
  db: Db;
  env: AuthEnv;
  origin: string;
  deliverMagicLink: (email: string, url: string) => Promise<void>;
}) {
  const { db, env } = opts;
  return betterAuth({
    baseURL: opts.origin,
    trustedOrigins: [opts.origin],
    secret: env.BETTER_AUTH_SECRET,
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
        async sendMagicLink({ email, url }) {
          if (await hasAccountRoute(db, env, email)) {
            await opts.deliverMagicLink(email, url);
          }
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

// The auth instance for a resolved host, or null when the host is refused
// (unknown, which includes a client domain that is not active). A sign-in
// requested on a client host names that workspace to the deliverer, which
// sends the link from and branded as the workspace.
export function authForResolution(
  db: Db,
  env: CloudflareEnv,
  resolution: HostResolution,
  deliver?: MagicLinkDeliverer,
) {
  const origin = hostOrigin(env, resolution);
  if (origin === null) {
    return null;
  }
  const workspaceId = resolution.kind === "workspace" ? resolution.workspace.id : null;
  const send: MagicLinkDeliverer =
    deliver ?? ((message) => sendMagicLinkEmail(env, message.email, message.url));
  return createAuth({
    db,
    env,
    origin,
    deliverMagicLink: (email, url) => send({ email, url, workspaceId }),
  });
}

// authForResolution for a raw Host value (lowercased, port ignored).
export async function authForHost(
  db: Db,
  env: CloudflareEnv,
  host: string | null | undefined,
  deliver?: MagicLinkDeliverer,
) {
  return authForResolution(db, env, await resolveHost(db, env, host), deliver);
}

export type Auth = NonNullable<ReturnType<typeof authForResolution>>;

// Instantiated per request: the D1 binding only exists inside a request's
// Cloudflare context, so there is no module-level auth singleton. The host
// is the one the platform routed (requestHost; custom-worker.ts pins
// x-forwarded-host to it), never a value the client chose. null means the
// host is refused: callers answer 404.
export async function getAuth(resolution?: HostResolution): Promise<Auth | null> {
  const { env } = getCloudflareContext();
  if (env.APP_URL.includes("REPLACE_ME")) {
    throw new Error("APP_URL is not configured (wrangler.jsonc still has the placeholder)");
  }
  return authForResolution(getDbFromEnv(env), env, resolution ?? (await requestHost()));
}
