// Who may connect an AI app, and to which workspace (Wave 2 plan, Decisions
// 4 and 6): a person with a live role in the workspace (a member, or a
// platform admin: platform on the hub, manager on a client host, the same
// rule as the app's guard), while the workspace's AI switch is on (it
// defaults off: owner decision, Oct 7). A client host offers its own
// workspace only; the hub offers a member's workspaces, and a platform admin
// one connection for every workspace with AI on (owner decision 3, Oct 7:
// connectsToEveryWorkspace). Closed sign-up is unchanged: only existing
// accounts can connect. Relative imports only.

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { user, workspaceMembers, workspaceSettings, workspaces } from "../../db/schema";
import type { Role } from "../../lib/roles";
import type { HostResolution } from "../../server/host";
import { roleViewerFor, workspaceRoleOf } from "../../server/workspace-role";

export type ConnectableWorkspace = { id: string; name: string; role: Role };

export async function teamAiOn(db: Db, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ on: workspaceSettings.aiTeam })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return Boolean(rows[0]?.on);
}

export async function connectableWorkspaces(
  db: Db,
  env: { PLATFORM_ADMIN_EMAILS?: string },
  person: { id: string; email: string },
  resolution: HostResolution,
): Promise<ConnectableWorkspace[]> {
  if (resolution.kind === "unknown") {
    return [];
  }
  if (resolution.kind === "workspace") {
    const workspace = resolution.workspace;
    if (!(await teamAiOn(db, workspace.id))) {
      return [];
    }
    const viewer = await roleViewerFor(db, env, person, false);
    const role = await workspaceRoleOf(db, viewer, workspace.id, true);
    return role ? [{ id: workspace.id, name: workspace.name, role }] : [];
  }
  const viewer = await roleViewerFor(db, env, person, true);
  if (viewer.platformAdmin) {
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .innerJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id))
      .where(eq(workspaceSettings.aiTeam, true))
      .orderBy(asc(workspaces.name), asc(workspaces.id));
    return rows.map((row) => ({ ...row, role: "platform" as const }));
  }
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .innerJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, person.id), eq(workspaceSettings.aiTeam, true)))
    .orderBy(asc(workspaces.name), asc(workspaces.id));
  return rows;
}

// True for a platform admin on the hub: their connection is not bound to a
// workspace, and every tool call names one (src/mcp/every-workspace.ts).
export async function connectsToEveryWorkspace(
  db: Db,
  env: { PLATFORM_ADMIN_EMAILS?: string },
  person: { id: string; email: string },
  resolution: HostResolution,
): Promise<boolean> {
  if (resolution.kind !== "hub") {
    return false;
  }
  return (await roleViewerFor(db, env, person, true)).platformAdmin;
}

// The account behind an email, only when it may connect on this host.
export async function connectableUser(
  db: Db,
  env: { PLATFORM_ADMIN_EMAILS?: string },
  email: string,
  resolution: HostResolution,
): Promise<{ id: string; email: string } | null> {
  const rows = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.email, email.trim().toLowerCase())).limit(1);
  const found = rows[0];
  if (!found) {
    return null;
  }
  return (await connectableWorkspaces(db, env, found, resolution)).length > 0 ? found : null;
}
