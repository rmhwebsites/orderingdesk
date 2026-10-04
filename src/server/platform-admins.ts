// Platform admins behind /api/platform/admins (platform admins only). The
// bootstrap list comes from the PLATFORM_ADMIN_EMAILS Worker secret and can
// only change there; everyone else is promoted here (a platform_admins row
// for an existing user, a pending platform-admin invite for someone with no
// account yet, claimed at their first sign-in).

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { pendingInvites, platformAdmins, user } from "@/db/schema";
import { platformAdminEmails } from "./access";
import { isRecord } from "./desk/shapes";
import { normalizeEmail } from "./desk/validate";

type AdminEnv = { PLATFORM_ADMIN_EMAILS?: string };

export type PlatformAdminView = {
  email: string;
  // null for a bootstrap admin who has not signed in yet.
  userId: string | null;
  name: string | null;
  source: "bootstrap" | "granted";
  grantedBy: string | null;
  createdAt: number | null;
};

export type PlatformInviteView = { email: string; invitedBy: string; createdAt: number };

// One entry per email: bootstrap admins first (in secret order), then
// promoted admins by email. A promoted admin who is also on the bootstrap
// list shows as bootstrap, since revoking the grant would not remove access.
export async function listPlatformAdmins(
  db: Db,
  env: AdminEnv,
): Promise<{ admins: PlatformAdminView[]; invites: PlatformInviteView[] }> {
  const bootstrap = [...platformAdminEmails(env)];
  const [bootstrapUsers, granted, invites] = await Promise.all([
    bootstrap.length > 0
      ? db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(inArray(user.email, bootstrap))
      : Promise.resolve([]),
    db
      .select({
        userId: platformAdmins.userId,
        grantedBy: platformAdmins.grantedBy,
        createdAt: platformAdmins.createdAt,
        email: user.email,
        name: user.name,
      })
      .from(platformAdmins)
      .innerJoin(user, eq(platformAdmins.userId, user.id))
      .orderBy(asc(user.email)),
    db
      .select({ email: pendingInvites.email, invitedBy: pendingInvites.invitedBy, createdAt: pendingInvites.createdAt })
      .from(pendingInvites)
      .where(eq(pendingInvites.platformAdmin, true))
      .orderBy(asc(pendingInvites.email)),
  ]);
  const usersByEmail = new Map(bootstrapUsers.map((row) => [row.email.toLowerCase(), row]));
  const admins: PlatformAdminView[] = bootstrap.map((email) => {
    const known = usersByEmail.get(email);
    return {
      email,
      userId: known?.id ?? null,
      name: known?.name ?? null,
      source: "bootstrap",
      grantedBy: null,
      createdAt: null,
    };
  });
  for (const row of granted) {
    if (!bootstrap.includes(row.email.toLowerCase())) {
      admins.push({
        email: row.email,
        userId: row.userId,
        name: row.name,
        source: "granted",
        grantedBy: row.grantedBy,
        createdAt: row.createdAt,
      });
    }
  }
  return { admins, invites };
}

export type InvitePlatformAdminResult =
  | { kind: "invalid"; error: string }
  | { kind: "already-admin" }
  // An existing user, promoted at once.
  | { kind: "granted"; email: string }
  // No account yet: a pending platform-admin invite.
  | { kind: "invited"; email: string };

export async function invitePlatformAdmin(
  db: Db,
  env: AdminEnv,
  inviterId: string,
  body: unknown,
): Promise<InvitePlatformAdminResult> {
  const email = normalizeEmail(isRecord(body) ? body.email : undefined);
  if (email === null) {
    return { kind: "invalid", error: "A valid email is required" };
  }
  if (platformAdminEmails(env).has(email)) {
    return { kind: "already-admin" };
  }
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existing[0]) {
    const inserted = await db
      .insert(platformAdmins)
      .values({ userId: existing[0].id, grantedBy: inviterId, createdAt: Date.now() })
      .onConflictDoNothing()
      .returning({ userId: platformAdmins.userId });
    return inserted.length > 0 ? { kind: "granted", email } : { kind: "already-admin" };
  }
  // One pending platform-admin invite per email (platform_invite_unique); a
  // repeat invite keeps the first one.
  await db
    .insert(pendingInvites)
    .values({
      id: crypto.randomUUID(),
      email,
      platformAdmin: true,
      invitedBy: inviterId,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  return { kind: "invited", email };
}

// userId: the admin whose access was revoked, or null when a pending invite
// was withdrawn.
export type RevokePlatformAdminResult = { kind: "invalid"; error: string } | { kind: "revoked"; userId: string | null };

// Body {userId} revokes a promoted admin; {email} withdraws a pending
// platform-admin invite. Platform admins remove other platform admins, never
// themselves, and never a bootstrap admin (that list lives in the secret).
export async function revokePlatformAdmin(
  db: Db,
  env: AdminEnv,
  actorUserId: string,
  body: unknown,
): Promise<RevokePlatformAdminResult> {
  const fields = isRecord(body) ? body : {};
  const targetUserId = typeof fields.userId === "string" ? fields.userId : "";
  const targetEmail = typeof fields.email === "string" ? fields.email.trim().toLowerCase() : "";

  if (targetUserId.length > 0) {
    if (targetUserId === actorUserId) {
      return { kind: "invalid", error: "You cannot remove your own platform admin access" };
    }
    const target = await db.select({ email: user.email }).from(user).where(eq(user.id, targetUserId)).limit(1);
    if (target[0] && platformAdminEmails(env).has(target[0].email.toLowerCase())) {
      return {
        kind: "invalid",
        error: "This admin comes from the PLATFORM_ADMIN_EMAILS Worker secret. Change the secret to remove them.",
      };
    }
    const removed = await db
      .delete(platformAdmins)
      .where(eq(platformAdmins.userId, targetUserId))
      .returning({ userId: platformAdmins.userId });
    return removed.length > 0 ? { kind: "revoked", userId: targetUserId } : { kind: "invalid", error: "No such platform admin" };
  }

  if (targetEmail.length > 0) {
    await db
      .delete(pendingInvites)
      .where(and(eq(pendingInvites.email, targetEmail), eq(pendingInvites.platformAdmin, true)));
    return { kind: "revoked", userId: null };
  }

  return { kind: "invalid", error: "userId or email is required" };
}
