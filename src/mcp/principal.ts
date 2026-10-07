// Who an MCP call acts for (comprehensive desk design section 4; Wave 2
// plan, Decisions 6 to 9). Resolved from D1 on every call, after the OAuth
// library validated the bearer token: the token only carries ids (props).
// Refused (null, and the handler answers 401 invalid_token) unless:
// - the grant mirror row is active and unexpired, and matches the token's
//   workspace, person and the host the call arrived on;
// - the workspace exists, its AI switch is on, and a client host is still
//   its active custom domain;
// - the person still has a role there (re-read now, never from the token).
// The daily limits come from workspace_settings: platform admins use the
// manager limit. A platform admin's hub connection for every workspace
// (props.workspaceId null) is never a Principal here: resolveEveryWorkspace
// (Task 30A) serves it, and each tool call names its workspace. Relative
// imports only.

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { user, workspaceSettings, workspaces } from "../db/schema";
import { roleAtLeast } from "../lib/roles";
import { isAiClient } from "../lib/via";
import { hubHostname } from "../server/host";
import { roleViewerFor, workspaceRoleOf } from "../server/workspace-role";
import { loadActiveGrant, touchGrant } from "./grants";
import type { EveryWorkspaceConnection, Principal } from "./types";

// workspaceId null: a platform admin's hub connection for every workspace
// (owner decision 3, Oct 7), served by resolveEveryWorkspace (Task 30A).
export type GrantProps = { v: 1; kind: "member"; grantId: string; workspaceId: string | null; userId: string };

export function grantPropsOf(value: unknown): GrantProps | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const props = value as Record<string, unknown>;
  return props.v === 1 &&
    props.kind === "member" &&
    typeof props.grantId === "string" &&
    (typeof props.workspaceId === "string" || props.workspaceId === null) &&
    typeof props.userId === "string"
    ? { v: 1, kind: "member", grantId: props.grantId, workspaceId: props.workspaceId, userId: props.userId }
    : null;
}

export async function resolvePrincipal(
  db: Db,
  env: CloudflareEnv,
  input: { props: unknown; hostname: string },
  now: number,
): Promise<Principal | null> {
  const props = grantPropsOf(input.props);
  if (!props || props.workspaceId === null) {
    return null;
  }
  const workspaceId = props.workspaceId;
  const hostname = input.hostname.toLowerCase();
  const grant = await loadActiveGrant(db, props.grantId, now);
  if (!grant || grant.workspaceId !== workspaceId || grant.userId !== props.userId || grant.host !== hostname) {
    return null;
  }
  const rows = await db
    .select({
      name: workspaces.name,
      customDomain: workspaces.customDomain,
      customDomainStatus: workspaces.customDomainStatus,
      aiTeam: workspaceSettings.aiTeam,
      reads: workspaceSettings.aiReadsPerDay,
      staffChanges: workspaceSettings.aiStaffChangesPerDay,
      managerChanges: workspaceSettings.aiManagerChangesPerDay,
    })
    .from(workspaces)
    .innerJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const workspace = rows[0];
  if (!workspace || !workspace.aiTeam) {
    return null;
  }
  const onHub = hostname === hubHostname(env);
  if (!onHub && !(workspace.customDomain === hostname && workspace.customDomainStatus === "active")) {
    return null;
  }
  const people = await db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(eq(user.id, grant.userId)).limit(1);
  const person = people[0];
  if (!person) {
    return null;
  }
  const role = await workspaceRoleOf(db, await roleViewerFor(db, env, person, onHub), workspaceId, true);
  if (!role) {
    return null;
  }
  try {
    await touchGrant(db, grant.id, now);
  } catch {
    // last_used_at is a convenience; the call goes on.
  }
  return {
    workspaceId,
    workspaceName: workspace.name,
    userId: person.id,
    personName: person.name?.trim() || person.email,
    role,
    grantId: grant.id,
    client: isAiClient(grant.client) ? grant.client : "other",
    scopes: grant.scopes,
    host: hostname,
    limits: { reads: workspace.reads, changes: roleAtLeast(role, "manager") ? workspace.managerChanges : workspace.staffChanges },
    grantExpiresAt: grant.expiresAt,
  };
}

// A platform admin's hub connection for every workspace (owner decision 3,
// Oct 7; Wave 2 plan, Decision 4). Refused (null, and the handler answers
// 401 invalid_token) unless the props carry no workspace, the call arrived
// on the hub, the mirror row is active, unexpired, for this person, on the
// hub and itself for every workspace, and the person is still a platform
// admin (re-read now). No workspace is checked here: each tool call names
// one (src/mcp/every-workspace.ts).
export async function resolveEveryWorkspace(
  db: Db,
  env: CloudflareEnv,
  input: { props: unknown; hostname: string },
  now: number,
): Promise<EveryWorkspaceConnection | null> {
  const props = grantPropsOf(input.props);
  const hostname = input.hostname.toLowerCase();
  if (!props || props.workspaceId !== null || hostname !== hubHostname(env)) {
    return null;
  }
  const grant = await loadActiveGrant(db, props.grantId, now);
  if (!grant || grant.workspaceId !== null || grant.userId !== props.userId || grant.host !== hostname) {
    return null;
  }
  const people = await db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(eq(user.id, grant.userId)).limit(1);
  const person = people[0];
  if (!person || !(await roleViewerFor(db, env, person, true)).platformAdmin) {
    return null;
  }
  try {
    await touchGrant(db, grant.id, now);
  } catch {
    // last_used_at is a convenience; the call goes on.
  }
  return {
    userId: person.id,
    personName: person.name?.trim() || person.email,
    grantId: grant.id,
    client: isAiClient(grant.client) ? grant.client : "other",
    scopes: grant.scopes,
    host: hostname,
    grantExpiresAt: grant.expiresAt,
  };
}
