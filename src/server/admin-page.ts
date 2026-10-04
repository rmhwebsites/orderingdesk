// What the platform admin screen (/admin on the hub) shows: every
// workspace, the platform admins with their pending invites, and every
// user with their workspaces. The page has already checked that the viewer
// is a platform admin.

import { asc, count } from "drizzle-orm";
import type { Db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";
import { listPlatformAdmins, type PlatformAdminView, type PlatformInviteView } from "./platform-admins";
import { listPlatformUsers, type PlatformUserView } from "./platform-users";

type AdminEnv = { PLATFORM_ADMIN_EMAILS?: string };

export type AdminWorkspaceView = {
  id: string;
  name: string;
  slug: string;
  customDomain: string | null;
  customDomainStatus: "pending" | "active" | "error" | null;
  // Members (manual and Shopify), platform admins not counted.
  members: number;
};

export type AdminPageData = {
  viewerUserId: string;
  workspaces: AdminWorkspaceView[];
  admins: { admins: PlatformAdminView[]; invites: PlatformInviteView[] };
  users: PlatformUserView[];
};

export async function loadAdminPage(db: Db, env: AdminEnv, viewerUserId: string): Promise<AdminPageData> {
  const [rows, counts, admins, users] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        customDomain: workspaces.customDomain,
        customDomainStatus: workspaces.customDomainStatus,
      })
      .from(workspaces)
      .orderBy(asc(workspaces.name), asc(workspaces.id)),
    db
      .select({ workspaceId: workspaceMembers.workspaceId, members: count() })
      .from(workspaceMembers)
      .groupBy(workspaceMembers.workspaceId),
    listPlatformAdmins(db, env),
    listPlatformUsers(db, env),
  ]);
  const byWorkspace = new Map(counts.map((row) => [row.workspaceId, Number(row.members)]));
  return {
    viewerUserId,
    workspaces: rows.map((row) => ({ ...row, members: byWorkspace.get(row.id) ?? 0 })),
    admins,
    users,
  };
}
