// Settings > AI connections (comprehensive desk design section 4): each
// person sees and revokes their own AI connections; managers see and revoke
// everyone's and set the daily limits; platform admins (on the hub) switch
// team AI connections on or off and revoke them all. Platform admins on the
// hub also see, and only they revoke, the connections platform admins made
// for every workspace (owner decision 3, Oct 7: workspace_id null), since
// each can act in this workspace; Revoke all ends those too. Every revoke is
// a D1 update: the next MCP call is refused (src/mcp/principal.ts), and the
// cron then revokes the OAuth grant in KV (src/mcp/prune.ts). This module is
// Next.js code and never loads the OAuth library (ground rule 11).

import { and, desc, eq, gt, isNull, or, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { aiGrants, user, workspaceSettings, workspaces } from "@/db/schema";
import { roleAtLeast, type Role } from "@/lib/roles";
import { aiClientLabel } from "@/lib/via";
import { MCP_PATH, SCOPE_WRITE } from "@/mcp/constants";
import { revokeGrants } from "@/mcp/grants";
import { isRecord, personName } from "./desk/shapes";
import { workspaceOrigin } from "./host";

export type AiConnectionView = {
  id: string;
  person: string;
  mine: boolean;
  // A platform admin's hub connection for every workspace with AI on.
  everyWorkspace: boolean;
  app: string;
  clientDomain: string | null;
  redirectHost: string;
  access: "change" | "read";
  host: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
};

export type AiLimits = { readsPerDay: number; staffChangesPerDay: number; managerChangesPerDay: number };

export type AiSettingsView = {
  // The MCP address to add in Claude or ChatGPT.
  mcpUrl: string;
  teamAccess: boolean;
  limits: AiLimits;
  connections: AiConnectionView[];
  canManage: boolean;
  canSwitch: boolean;
};

const LIMITS: { field: keyof AiLimits; label: string; min: number; max: number }[] = [
  { field: "readsPerDay", label: "Lookups a day", min: 50, max: 5000 },
  { field: "staffChangesPerDay", label: "Changes a day for staff", min: 5, max: 500 },
  { field: "managerChangesPerDay", label: "Changes a day for managers", min: 5, max: 500 },
];

export async function loadAiSettings(
  db: Db,
  input: { workspaceId: string; viewerUserId: string; role: Role; mcpUrl: string; now: number },
): Promise<AiSettingsView> {
  const manager = roleAtLeast(input.role, "manager");
  const platform = roleAtLeast(input.role, "platform");
  const scope = platform ? (or(eq(aiGrants.workspaceId, input.workspaceId), isNull(aiGrants.workspaceId)) as SQL) : eq(aiGrants.workspaceId, input.workspaceId);
  const conditions: SQL[] = [scope, isNull(aiGrants.revokedAt), gt(aiGrants.expiresAt, input.now)];
  if (!manager) {
    conditions.push(eq(aiGrants.userId, input.viewerUserId));
  }
  const [settings, rows] = await Promise.all([
    db
      .select({
        aiTeam: workspaceSettings.aiTeam,
        readsPerDay: workspaceSettings.aiReadsPerDay,
        staffChangesPerDay: workspaceSettings.aiStaffChangesPerDay,
        managerChangesPerDay: workspaceSettings.aiManagerChangesPerDay,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, input.workspaceId))
      .limit(1),
    db
      .select({ grant: aiGrants, name: user.name, email: user.email })
      .from(aiGrants)
      .leftJoin(user, eq(user.id, aiGrants.userId))
      .where(and(...conditions))
      .orderBy(desc(aiGrants.createdAt)),
  ]);
  const row = settings[0];
  return {
    mcpUrl: input.mcpUrl,
    // Off without a settings row, as every MCP call reads it (the switch
    // defaults off, owner decision of Oct 7).
    teamAccess: row ? Boolean(row.aiTeam) : false,
    limits: {
      readsPerDay: row?.readsPerDay ?? 1000,
      staffChangesPerDay: row?.staffChangesPerDay ?? 50,
      managerChangesPerDay: row?.managerChangesPerDay ?? 100,
    },
    connections: rows.map(({ grant, name, email }) => ({
      id: grant.id,
      person: personName(name, email) ?? "Former member",
      mine: grant.userId === input.viewerUserId,
      everyWorkspace: grant.workspaceId === null,
      app: grant.client === "other" ? "Other AI app" : aiClientLabel(grant.client),
      clientDomain: grant.clientDomain,
      redirectHost: grant.redirectHost,
      access: grant.scopes.includes(SCOPE_WRITE) ? "change" : "read",
      host: grant.host,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
      expiresAt: grant.expiresAt,
    })),
    canManage: manager,
    canSwitch: platform,
  };
}

// The view for a route or the Settings loader: the MCP address is the
// workspace's own host when it has an active one, else the hub.
export async function aiSettingsFor(
  db: Db,
  env: CloudflareEnv,
  input: { workspaceId: string; userId: string; role: Role },
): Promise<AiSettingsView> {
  const rows = await db
    .select({ customDomain: workspaces.customDomain, customDomainStatus: workspaces.customDomainStatus })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  const origin = workspaceOrigin(env, rows[0] ?? { customDomain: null, customDomainStatus: null });
  return loadAiSettings(db, { workspaceId: input.workspaceId, viewerUserId: input.userId, role: input.role, mcpUrl: `${origin}${MCP_PATH}`, now: Date.now() });
}

export async function revokeConnection(
  db: Db,
  input: { workspaceId: string; grantId: string; viewerUserId: string; role: Role },
  now: number,
): Promise<{ kind: "revoked" } | { kind: "not-found" }> {
  const rows = await db
    .select({ userId: aiGrants.userId, workspaceId: aiGrants.workspaceId })
    .from(aiGrants)
    .where(
      and(
        eq(aiGrants.id, input.grantId),
        or(eq(aiGrants.workspaceId, input.workspaceId), isNull(aiGrants.workspaceId)),
        isNull(aiGrants.revokedAt),
      ),
    )
    .limit(1);
  const grant = rows[0];
  const mine = grant?.userId === input.viewerUserId;
  const everyWorkspace = grant?.workspaceId === null;
  // A connection for every workspace is a platform admin's: only platform
  // admins (on the hub) see and revoke it.
  if (!grant || (everyWorkspace && !roleAtLeast(input.role, "platform")) || (!mine && !roleAtLeast(input.role, "manager"))) {
    return { kind: "not-found" };
  }
  const revoked = await revokeGrants(
    db,
    { workspaceId: grant.workspaceId, grantId: input.grantId },
    { userId: input.viewerUserId, reason: mine ? "person" : everyWorkspace ? "platform_admin" : "manager" },
    now,
  );
  return revoked.length > 0 ? { kind: "revoked" } : { kind: "not-found" };
}

// Every connection that can act in the workspace: its own, and every
// platform admin's connection for every workspace.
export async function revokeAllConnections(db: Db, input: { workspaceId: string; viewerUserId: string }, now: number): Promise<number> {
  return (
    await revokeGrants(db, { workspaceId: input.workspaceId, everyWorkspaceToo: true }, { userId: input.viewerUserId, reason: "platform_admin" }, now)
  ).length;
}

export async function updateAiSettings(
  db: Db,
  input: { workspaceId: string; role: Role },
  body: unknown,
): Promise<{ kind: "saved" } | { kind: "invalid"; error: string }> {
  if (!isRecord(body)) {
    return { kind: "invalid", error: "Send the settings as JSON." };
  }
  const set: { aiTeam?: boolean; aiReadsPerDay?: number; aiStaffChangesPerDay?: number; aiManagerChangesPerDay?: number } = {};
  const columns = { readsPerDay: "aiReadsPerDay", staffChangesPerDay: "aiStaffChangesPerDay", managerChangesPerDay: "aiManagerChangesPerDay" } as const;
  for (const limit of LIMITS) {
    const value = body[limit.field];
    if (value === undefined) {
      continue;
    }
    if (!roleAtLeast(input.role, "manager")) {
      return { kind: "invalid", error: "Only a manager can change the daily limits." };
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < limit.min || value > limit.max) {
      return { kind: "invalid", error: `${limit.label} must be a whole number from ${limit.min} to ${limit.max}.` };
    }
    set[columns[limit.field]] = value;
  }
  if (body.teamAccess !== undefined) {
    if (!roleAtLeast(input.role, "platform")) {
      return { kind: "invalid", error: "Only a platform admin can turn AI connections on or off, on Ordering Desk." };
    }
    if (typeof body.teamAccess !== "boolean") {
      return { kind: "invalid", error: "teamAccess must be true or false." };
    }
    set.aiTeam = body.teamAccess;
  }
  if (Object.keys(set).length === 0) {
    return { kind: "invalid", error: "Nothing to change." };
  }
  await db.update(workspaceSettings).set(set).where(eq(workspaceSettings.workspaceId, input.workspaceId));
  return { kind: "saved" };
}
