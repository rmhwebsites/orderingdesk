// Tagged Shopify customers as workspace members (platform amendment
// section 2). The Shopify stage fills shopify_roster from customer webhooks
// and the periodic sync, and adds or removes source = shopify memberships as
// tags change (src/server/shopify/roster-sync.ts). This module holds the
// shared rules: the tag names, the approval step, and turning roster
// entries into memberships when the person signs in.
//
// Tag, then approve once. A customer tag is not proof of anything: any
// storefront visitor can create a customer with tags through the Online
// Store newsletter form (contact[tags]). So a tag only REQUESTS access, and
// a manager (or platform admin) of the workspace approves each (workspace,
// email, role) once:
// - A new roster row waits (approved_role null) and grants nothing: no
//   sign-in email, no account, no membership.
// - Approving sets approved_role to the row's role; the row then grants
//   that role the way an invite does: the person claims the membership at
//   their next sign-in or "/" load (claimAccessOnSignIn), whether or not
//   they already have an account. Approving never adds anyone itself: that
//   would show the manager which emails have an account (and their names,
//   in the Team list), and add a person who did nothing. Until it is
//   claimed, Settings > Team lists the request as approved, the same either
//   way. Only someone already a shopify member here sees an approval at
//   once (an approved raise takes their membership up).
// - A raised tag (staff to manager) keeps the staff approval, so the
//   membership stays staff while the raise waits for its own approval. A
//   lowered tag lowers approved_role and the membership at once.
// - Denying grants nothing and takes away any shopify membership for the
//   email in the workspace. A denied row stays denied whatever the tag
//   does, until the tag is removed (the row is deleted) and added again.
// - Removing the tag, deleting the customer or changing its email deletes
//   the row, so tagging again later is a fresh request.

// Relative imports on purpose: the cron roster sync
// (src/server/shopify/roster-sync.ts) bundles this into the custom worker.

import { and, asc, eq, exists, isNotNull, isNull, not, notExists, or, ne, sql } from "drizzle-orm";
import type { Db } from "../db";
import { applyBatch, rowsAffected } from "../db/batch";
import { shopifyRoster, user, workspaceMembers, workspaces, type RosterTags } from "../db/schema";
import { isWorkspaceRole, roleLabel, type WorkspaceRole } from "../lib/roles";
import { isRecord } from "./desk/shapes";

export const DEFAULT_ROSTER_TAGS: RosterTags = {
  manager: "Ordering Desk Manager",
  staff: "Ordering Desk Staff",
};

// The workspace's tag names: workspaces.roster_tags when set, each missing
// or blank tag falling back to its default.
export function resolveRosterTags(stored: unknown): RosterTags {
  const tags = isRecord(stored) ? stored : {};
  const pick = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  return {
    manager: pick(tags.manager, DEFAULT_ROSTER_TAGS.manager),
    staff: pick(tags.staff, DEFAULT_ROSTER_TAGS.staff),
  };
}

export const ROSTER_TAG_MAX = 40;

export type SetRosterTagsResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "saved"; tags: RosterTags };

// Platform admins (the route checks). Body {manager, staff}: the Shopify
// customer tags that grant each role here, or null for the defaults. Each
// is 1 to ROSTER_TAG_MAX characters with no comma (Shopify separates tags
// with commas), and the two must differ. The cron roster sync applies a
// change at its next run (grants the new tags, revokes the old ones).
export async function setRosterTags(db: Db, workspaceId: string, body: unknown): Promise<SetRosterTagsResult> {
  let next: RosterTags | null = null;
  if (body !== null) {
    if (!isRecord(body)) {
      return { kind: "invalid", error: "Send the manager and staff tags, or null for the defaults" };
    }
    const tags: Partial<RosterTags> = {};
    for (const role of ["manager", "staff"] as const) {
      const raw = body[role];
      const value = typeof raw === "string" ? raw.trim() : "";
      const label = role === "manager" ? "The manager tag" : "The staff tag";
      if (value.length === 0 || value.length > ROSTER_TAG_MAX) {
        return { kind: "invalid", error: `${label} must be 1 to ${ROSTER_TAG_MAX} characters` };
      }
      if (value.includes(",")) {
        return { kind: "invalid", error: `${label} cannot contain a comma: Shopify would read it as two tags` };
      }
      tags[role] = value;
    }
    if (tags.manager!.toLowerCase() === tags.staff!.toLowerCase()) {
      return { kind: "invalid", error: "The manager and staff tags must be different" };
    }
    next = { manager: tags.manager!, staff: tags.staff! };
  }
  const updated = await db
    .update(workspaces)
    .set({ rosterTags: next })
    .where(eq(workspaces.id, workspaceId))
    .returning({ id: workspaces.id });
  if (updated.length === 0) {
    return { kind: "not-found" };
  }
  return { kind: "saved", tags: resolveRosterTags(next) };
}

// The roster rows that grant access: approved for a role and not denied.
// src/server/access.ts spells out the same condition (it stays free of
// this module for the realtime bundle).
export function rosterGrants() {
  return and(isNotNull(shopifyRoster.approvedRole), isNull(shopifyRoster.deniedAt));
}

// One statement: userId's source = shopify membership in the workspace,
// with the role the roster row for email grants (its approved role), and
// only while that row grants. A manual membership is never touched (a
// manager's invite outranks a tag), and nothing is written when the
// membership already has that role. Conflict safe: concurrent runs end with
// one membership. Reading the row inside the statement means a denial or a
// removed tag that lands first leaves nothing to grant. Only for the
// person's own sign-in (materializeRoster): it adds a membership.
export function grantMembershipFromRoster(db: Db, workspaceId: string, email: string, userId: string) {
  return db
    .insert(workspaceMembers)
    .select((qb) =>
      qb
        .select({
          id: sql<string>`${crypto.randomUUID()}`.as("id"),
          workspaceId: shopifyRoster.workspaceId,
          userId: sql<string>`${userId}`.as("user_id"),
          role: sql<WorkspaceRole>`${shopifyRoster.approvedRole}`.as("role"),
          source: sql<"shopify">`'shopify'`.as("source"),
          lastSeenAt: sql<number>`0`.as("last_seen_at"),
        })
        .from(shopifyRoster)
        .where(and(eq(shopifyRoster.workspaceId, workspaceId), eq(shopifyRoster.email, email), rosterGrants())),
    )
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: sql`excluded.role` },
      setWhere: sql`${workspaceMembers.source} = 'shopify' and ${workspaceMembers.role} <> excluded.role`,
    });
}

// One statement: userId's EXISTING source = shopify membership in the
// workspace takes the role the roster row for email grants. Never adds a
// membership (only claimAccessOnSignIn does, through materializeRoster),
// never touches a manual one, and writes nothing when the row grants
// nothing (the comparison with no row is null) or the role already matches.
// For approvals and roster writes: a lowered tag lowers the membership at
// once, an approved raise takes it up.
export function alignMembershipWithRoster(db: Db, workspaceId: string, email: string, userId: string) {
  const granted = sql`(select ${shopifyRoster.approvedRole} from ${shopifyRoster} where ${shopifyRoster.workspaceId} = ${workspaceId} and ${shopifyRoster.email} = ${email} and ${shopifyRoster.approvedRole} is not null and ${shopifyRoster.deniedAt} is null)`;
  return db
    .update(workspaceMembers)
    .set({ role: sql`${granted}` })
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.source, "shopify"),
        sql`${workspaceMembers.role} <> ${granted}`,
      ),
    );
}

// One statement: removes userId's shopify membership in the workspace
// unless the roster row for email still grants. For a row that stopped
// granting (it started over on another customer).
export function revokeUngrantedMembership(db: Db, workspaceId: string, email: string, userId: string) {
  return db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.source, "shopify"),
        notExists(
          db
            .select({ id: shopifyRoster.id })
            .from(shopifyRoster)
            .where(and(eq(shopifyRoster.workspaceId, workspaceId), eq(shopifyRoster.email, email), rosterGrants())),
        ),
      ),
    );
}

// The one place a roster entry becomes a membership (claimAccessOnSignIn:
// every sign-in and "/" load, so the person is the one who acts). Grants
// every APPROVED roster entry for this email as a source = shopify
// membership with its approved role (an entry waiting for approval, or
// denied, grants nothing). A manual membership in the same workspace is
// never touched; an existing shopify membership takes the approved role.
// Removing memberships whose tag is gone is the Shopify stage's job, not
// sign-in's. Idempotent: "/" runs this on every load, and a repeat (or a
// concurrent load) writes nothing. Answers the memberships written.
export async function materializeRoster(db: Db, userId: string, email: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  const entries = await db
    .select({ workspaceId: shopifyRoster.workspaceId })
    .from(shopifyRoster)
    .where(and(eq(shopifyRoster.email, normalized), rosterGrants()));
  const results = await applyBatch(
    db,
    entries.map((entry) => grantMembershipFromRoster(db, entry.workspaceId, normalized, userId)),
  );
  return results.reduce<number>((sum, result) => sum + rowsAffected(result, "roster"), 0);
}

// A request in Settings > Team: the role the tag asks for, the role it
// grants now (a raise waiting for approval keeps the earlier one; null when
// nothing was approved yet) and since when it has looked like this (for an
// approved request, since the approval).
export type RosterRequestView = {
  id: string;
  email: string;
  role: WorkspaceRole;
  currentRole: WorkspaceRole | null;
  since: number;
  deniedAt: number | null;
};

// waiting: nothing approved yet, or a raise. denied. approved: approved for
// the role the tag asks for, and nobody with the email belongs to the
// workspace yet (they join at their next sign-in or "/" load). An approved
// request reads the same whether or not the email has an account.
export type RosterRequests = { waiting: RosterRequestView[]; denied: RosterRequestView[]; approved: RosterRequestView[] };

// This workspace's requests for Settings > Team (see RosterRequests).
// Oldest first. A request someone has claimed is not listed: the member is.
export async function listRosterRequests(db: Db, workspaceId: string): Promise<RosterRequests> {
  const claimed = exists(
    db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .innerJoin(user, eq(workspaceMembers.userId, user.id))
      .where(and(eq(workspaceMembers.workspaceId, shopifyRoster.workspaceId), eq(user.email, shopifyRoster.email))),
  );
  const rows = await db
    .select({
      id: shopifyRoster.id,
      email: shopifyRoster.email,
      role: shopifyRoster.role,
      currentRole: shopifyRoster.approvedRole,
      updatedAt: shopifyRoster.updatedAt,
      approvedAt: shopifyRoster.approvedAt,
      deniedAt: shopifyRoster.deniedAt,
    })
    .from(shopifyRoster)
    .where(
      and(
        eq(shopifyRoster.workspaceId, workspaceId),
        or(
          isNotNull(shopifyRoster.deniedAt),
          isNull(shopifyRoster.approvedRole),
          ne(shopifyRoster.approvedRole, shopifyRoster.role),
          not(claimed),
        ),
      ),
    )
    .orderBy(asc(shopifyRoster.updatedAt), asc(shopifyRoster.email));
  const view = (row: (typeof rows)[number], since: number): RosterRequestView => ({
    id: row.id,
    email: row.email,
    role: row.role,
    currentRole: row.currentRole,
    since,
    deniedAt: row.deniedAt,
  });
  const requests: RosterRequests = { waiting: [], denied: [], approved: [] };
  for (const row of rows) {
    if (row.deniedAt !== null) {
      requests.denied.push(view(row, row.updatedAt));
    } else if (row.currentRole === null || row.currentRole !== row.role) {
      requests.waiting.push(view(row, row.updatedAt));
    } else {
      requests.approved.push(view(row, row.approvedAt ?? row.updatedAt));
    }
  }
  return requests;
}

export type RosterDecisionResult =
  | { kind: "invalid"; error: string }
  // No such entry in this workspace (another workspace's id included).
  | { kind: "not-found" }
  // The tag asks for another role than the one the manager approved.
  | { kind: "changed"; error: string }
  | { kind: "approved"; email: string; role: WorkspaceRole }
  // revokedUserId: whose shopify membership went (their sockets close).
  | { kind: "denied"; revokedUserId: string | null };

async function findEntry(db: Db, workspaceId: string, rosterId: string) {
  const rows = await db
    .select({ email: shopifyRoster.email, role: shopifyRoster.role })
    .from(shopifyRoster)
    .where(and(eq(shopifyRoster.id, rosterId), eq(shopifyRoster.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ?? null;
}

async function userIdFor(db: Db, email: string): Promise<string | null> {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  return rows[0]?.id ?? null;
}

const changedError = (role: WorkspaceRole) =>
  `This request changed in Shopify: the tag now asks for ${roleLabel(role)}. Check it again before approving.`;

// Managers and platform admins of the workspace (the route checks). Approves
// the entry for the role its tag asks for now; body {role} optionally names
// the role the manager saw, and a different one answers "changed" instead
// of approving more than they saw. A denied entry is approved the same way.
// Adds nobody: the person claims the membership at their next sign-in or
// "/" load, so the answer and the Team list are the same whether or not the
// email has an account. Someone already a shopify member here takes the
// approved role at once (nobody is kicked: access only grows).
export async function approveRosterEntry(
  db: Db,
  ctx: { workspaceId: string; rosterId: string; approverId: string },
  body: unknown,
  opts?: { now?: number },
): Promise<RosterDecisionResult> {
  const expected = isRecord(body) ? body.role : undefined;
  if (expected !== undefined && !isWorkspaceRole(expected)) {
    return { kind: "invalid", error: "Role must be manager or staff" };
  }
  const entry = await findEntry(db, ctx.workspaceId, ctx.rosterId);
  if (!entry) {
    return { kind: "not-found" };
  }
  if (expected !== undefined && expected !== entry.role) {
    return { kind: "changed", error: changedError(entry.role) };
  }
  const userId = await userIdFor(db, entry.email);
  const now = opts?.now ?? Date.now();
  const statements: PromiseLike<unknown>[] = [
    db
      .update(shopifyRoster)
      .set({ approvedRole: entry.role, approvedAt: now, approvedBy: ctx.approverId, deniedAt: null })
      .where(
        and(
          eq(shopifyRoster.id, ctx.rosterId),
          eq(shopifyRoster.workspaceId, ctx.workspaceId),
          eq(shopifyRoster.role, entry.role),
        ),
      ),
  ];
  if (userId) {
    statements.push(alignMembershipWithRoster(db, ctx.workspaceId, entry.email, userId));
  }
  const results = await applyBatch(db, statements);
  if (rowsAffected(results[0], "roster") === 0) {
    // The tag went (row deleted) or changed role since it was read.
    const again = await findEntry(db, ctx.workspaceId, ctx.rosterId);
    return again ? { kind: "changed", error: changedError(again.role) } : { kind: "not-found" };
  }
  return { kind: "approved", email: entry.email, role: entry.role };
}

// Managers and platform admins of the workspace (the route checks). Denies
// the entry and takes away any source = shopify membership for its email in
// this workspace (a raise waiting for approval loses the earlier role too);
// a manual membership stays.
export async function denyRosterEntry(
  db: Db,
  ctx: { workspaceId: string; rosterId: string },
  opts?: { now?: number },
): Promise<RosterDecisionResult> {
  const entry = await findEntry(db, ctx.workspaceId, ctx.rosterId);
  if (!entry) {
    return { kind: "not-found" };
  }
  const userId = await userIdFor(db, entry.email);
  const now = opts?.now ?? Date.now();
  const statements: PromiseLike<unknown>[] = [
    db
      .update(shopifyRoster)
      .set({
        approvedRole: null,
        approvedAt: null,
        approvedBy: null,
        deniedAt: sql`coalesce(${shopifyRoster.deniedAt}, ${now})`,
      })
      .where(and(eq(shopifyRoster.id, ctx.rosterId), eq(shopifyRoster.workspaceId, ctx.workspaceId))),
  ];
  if (userId) {
    statements.push(
      db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, ctx.workspaceId),
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.source, "shopify"),
          ),
        ),
    );
  }
  const results = await applyBatch(db, statements);
  if (rowsAffected(results[0], "roster") === 0) {
    return { kind: "not-found" };
  }
  return { kind: "denied", revokedUserId: userId && rowsAffected(results[1], "roster") > 0 ? userId : null };
}
