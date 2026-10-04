// Every account on the platform, for the platform admin screen (/admin):
// who has access to what. Platform admins only; the page checks that.

import { asc, eq, notInArray } from "drizzle-orm";
import type { Db } from "@/db";
import { platformAdmins, user, workspaceMembers, workspaces } from "@/db/schema";
import type { WorkspaceRole } from "@/lib/roles";
import { platformAdminEmails } from "./access";

type AdminEnv = { PLATFORM_ADMIN_EMAILS?: string };

export type PlatformUserMembership = {
  workspaceId: string;
  workspaceName: string;
  slug: string;
  role: WorkspaceRole;
  source: "manual" | "shopify";
};

export type PlatformUserView = {
  userId: string;
  email: string;
  name: string | null;
  // On the bootstrap list or promoted in the app.
  platformAdmin: boolean;
  memberships: PlatformUserMembership[];
};

// Every user by email, each with their workspaces by name.
export async function listPlatformUsers(db: Db, env: AdminEnv): Promise<PlatformUserView[]> {
  const [users, granted, memberships] = await Promise.all([
    db.select({ id: user.id, email: user.email, name: user.name }).from(user).orderBy(asc(user.email), asc(user.id)),
    db.select({ userId: platformAdmins.userId }).from(platformAdmins),
    db
      .select({
        userId: workspaceMembers.userId,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        slug: workspaces.slug,
        role: workspaceMembers.role,
        source: workspaceMembers.source,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .orderBy(asc(workspaces.name), asc(workspaces.id)),
  ]);
  const bootstrap = platformAdminEmails(env);
  const promoted = new Set(granted.map((row) => row.userId));
  const byUser = new Map<string, PlatformUserMembership[]>();
  for (const { userId, ...membership } of memberships) {
    const list = byUser.get(userId) ?? [];
    list.push(membership);
    byUser.set(userId, list);
  }
  return users.map((row) => ({
    userId: row.id,
    email: row.email,
    name: row.name.trim().length > 0 ? row.name : null,
    platformAdmin: bootstrap.has(row.email.toLowerCase()) || promoted.has(row.id),
    memberships: byUser.get(row.id) ?? [],
  }));
}

// The workspaces a user reaches only through platform admin access (not a
// member there): where their open sockets close when that access is
// revoked.
export async function workspacesWithoutMember(db: Db, userId: string): Promise<string[]> {
  const member = db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(notInArray(workspaces.id, member))
    .orderBy(asc(workspaces.id));
  return rows.map((row) => row.id);
}
