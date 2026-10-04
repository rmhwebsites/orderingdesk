// Who is a platform admin, and who may have an account at all (platform
// amendment section 2). Sign-up is closed: an account exists only for
//   1. platform admins (the PLATFORM_ADMIN_EMAILS bootstrap list, or a user
//      promoted in the app, who for a new account arrives as a pending
//      platform-admin invite);
//   2. anyone with a pending workspace invite;
//   3. tagged Shopify customers on a workspace roster (shopify_roster).
// Existing users may always sign in.
//
// Relative imports on purpose: the realtime socket check (src/realtime/
// live.ts) bundles this into the custom worker.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { pendingInvites, platformAdmins, shopifyRoster, user, workspaceMembers } from "../db/schema";

type AdminEnv = { PLATFORM_ADMIN_EMAILS?: string };

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

// The bootstrap list from the Worker secret: comma separated, trimmed,
// lowercased, blanks dropped. A missing secret is an empty list.
export function platformAdminEmails(env: AdminEnv): Set<string> {
  const raw = typeof env.PLATFORM_ADMIN_EMAILS === "string" ? env.PLATFORM_ADMIN_EMAILS : "";
  return new Set(
    raw
      .split(",")
      .map(normalize)
      .filter((email) => email.length > 0),
  );
}

// Effective platform admin: on the bootstrap list (no query needed) or
// promoted in the app (a platform_admins row).
export async function isPlatformAdmin(
  db: Db,
  env: AdminEnv,
  userId: string,
  email: string,
): Promise<boolean> {
  if (platformAdminEmails(env).has(normalize(email))) {
    return true;
  }
  const rows = await db
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId))
    .limit(1);
  return rows.length > 0;
}

// Whether this user may see the workspace at all right now: a member, or a
// platform admin (by user id, for callers that hold no session, such as
// the realtime socket endpoint checking a ticket when it is used).
export async function canSeeWorkspace(db: Db, env: AdminEnv, userId: string, workspaceId: string): Promise<boolean> {
  const membership = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (membership.length > 0) {
    return true;
  }
  const rows = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  return rows[0] ? isPlatformAdmin(db, env, userId, rows[0].email) : false;
}

// Whether a NEW account may be created for this email: the closed sign-up
// rule, enforced in better-auth's user.create.before hook.
export async function canCreateAccount(db: Db, env: AdminEnv, email: string): Promise<boolean> {
  const normalized = normalize(email);
  if (normalized.length === 0) {
    return false;
  }
  if (platformAdminEmails(env).has(normalized)) {
    return true;
  }
  const [invites, roster] = await Promise.all([
    db
      .select({ id: pendingInvites.id })
      .from(pendingInvites)
      .where(eq(pendingInvites.email, normalized))
      .limit(1),
    db
      .select({ id: shopifyRoster.id })
      .from(shopifyRoster)
      .where(eq(shopifyRoster.email, normalized))
      .limit(1),
  ]);
  return invites.length > 0 || roster.length > 0;
}

// Whether a sign-in link for this email can lead anywhere: an existing user,
// or an email that canCreateAccount allows. The magic-link sender uses it to
// skip sending (the response is the same either way, so nobody can probe
// which addresses have access).
export async function hasAccountRoute(db: Db, env: AdminEnv, email: string): Promise<boolean> {
  const normalized = normalize(email);
  if (normalized.length === 0) {
    return false;
  }
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, normalized))
    .limit(1);
  return existing.length > 0 || (await canCreateAccount(db, env, normalized));
}
