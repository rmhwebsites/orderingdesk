// A person's effective role in a workspace from the database alone, for code
// that runs without a Next.js request: the MCP server in custom-worker.ts
// (src/mcp/). src/server/guard.ts builds its 404 rules on it, so the rule
// lives once:
// - a platform admin gets "platform" on the hub (ranked above manager) and
//   "manager" on a client host, in every workspace that exists;
// - anyone else has their membership role, or null.
// Relative imports only: custom-worker.ts bundles this.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { workspaceMembers, workspaces } from "../db/schema";
import type { Role } from "../lib/roles";
import { isPlatformAdmin } from "./access";

export type RoleViewer = { userId: string; platformAdmin: boolean; platformAdminOnClientHost?: boolean };

export async function workspaceRoleOf(
  db: Db,
  viewer: RoleViewer,
  workspaceId: string,
  knownToExist = false,
): Promise<Role | null> {
  if (viewer.platformAdmin || viewer.platformAdminOnClientHost) {
    if (!knownToExist) {
      const rows = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      if (rows.length === 0) {
        return null;
      }
    }
    return viewer.platformAdmin ? "platform" : "manager";
  }
  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, viewer.userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

// The viewer flags for a person on the hub or on a client host: the same rule
// as requireSession in src/server/guard.ts.
export async function roleViewerFor(
  db: Db,
  env: { PLATFORM_ADMIN_EMAILS?: string },
  user: { id: string; email: string },
  onHub: boolean,
): Promise<RoleViewer> {
  const admin = await isPlatformAdmin(db, env, user.id, user.email);
  return { userId: user.id, platformAdmin: admin && onHub, platformAdminOnClientHost: admin && !onHub };
}
