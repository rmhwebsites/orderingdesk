// Merges with the wrangler-generated CloudflareEnv (cloudflare-env.d.ts) so the
// secret keys are always typed, even when a developer has no local .dev.vars.
// Email sends through the EMAIL binding (Cloudflare Email Service), which
// cf-typegen types from wrangler.jsonc; no entry is needed here.
interface CloudflareEnv {
  BETTER_AUTH_SECRET: string;
  ENCRYPTION_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  CRON_SECRET: string;
  APP_URL: string;
  // Bootstrap platform admins, comma separated (case-insensitive). May be
  // unset at runtime (typed like the other secrets so a .dev.vars entry,
  // which wrangler types as string, does not conflict); readers treat a
  // missing value as an empty list (src/server/access.ts).
  PLATFORM_ADMIN_EMAILS: string;
  // Workers AI (wrangler.jsonc "ai"). Tools and tests that build a partial
  // env leave it out; src/server/search/ai.ts treats a missing binding as
  // AI search off.
  AI: Ai;
}
