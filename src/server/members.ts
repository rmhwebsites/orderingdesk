// Workspace team management behind /api/workspaces/[id]/members. Managers
// invite and remove staff and managers in their own workspace; platform
// admins can do the same in any workspace (the route's guard decides who
// gets here). Memberships that come from here are source = manual.

import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsAffected } from "@/db/batch";
import { inviteSends, pendingInvites, user, workspaceMembers, workspaces } from "@/db/schema";
import { isWorkspaceRole, type WorkspaceRole } from "@/lib/roles";
import { isRecord } from "./desk/shapes";
import { listRosterRequests, type RosterRequests } from "./roster";
import { normalizeEmail } from "./desk/validate";

export type MemberView = {
  userId: string;
  role: WorkspaceRole;
  source: "manual" | "shopify";
  email: string | null;
  name: string | null;
};

export type PendingInviteView = { email: string; role: WorkspaceRole; createdAt: number };

// Members by email, plus, when asked (the route asks for managers and
// platform admins only), this workspace's pending invites and the Shopify
// tag requests waiting for approval or denied.
export async function listMembers(
  db: Db,
  workspaceId: string,
  opts: { includeInvites: boolean },
): Promise<{ members: MemberView[]; invites?: PendingInviteView[]; requests?: RosterRequests }> {
  const members = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      source: workspaceMembers.source,
      email: user.email,
      name: user.name,
    })
    .from(workspaceMembers)
    .leftJoin(user, eq(workspaceMembers.userId, user.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(user.email), asc(workspaceMembers.userId));
  if (!opts.includeInvites) {
    return { members };
  }
  const rows = await db
    .select({ email: pendingInvites.email, role: pendingInvites.role, createdAt: pendingInvites.createdAt })
    .from(pendingInvites)
    .where(and(eq(pendingInvites.workspaceId, workspaceId), eq(pendingInvites.platformAdmin, false)))
    .orderBy(asc(pendingInvites.email));
  const invites = rows.flatMap((row) => (row.role ? [{ email: row.email, role: row.role, createdAt: row.createdAt }] : []));
  return { members, invites, requests: await listRosterRequests(db, workspaceId) };
}

export type InviteMemberResult =
  | { kind: "invalid"; error: string }
  // Already a member of this workspace: nothing changed, nothing to send.
  | { kind: "already-member" }
  // The workspace sent INVITE_SEND_LIMIT invites in the last window.
  | { kind: "limited"; error: string }
  // A pending invite (new or refreshed), claimed when the person next
  // signs in or opens the app (src/server/invites.ts).
  | { kind: "invited"; email: string; workspaceName: string };

// Invite emails per workspace per rolling window.
export const INVITE_SEND_LIMIT = 30;
export const INVITE_SEND_WINDOW_MS = 60 * 60 * 1000;

// Every invite is a pending invite, whether or not the email already has an
// account somewhere on the platform: adding an existing account directly
// would tell any manager which emails have one (and their name, through
// the team list), and would add the person without them doing anything.
// The answer is the same either way. Each invite counts toward the
// workspace's INVITE_SEND_LIMIT (the route sends one email per invite);
// someone who is already a member here is answered without a send.
export async function inviteMember(
  db: Db,
  ctx: { workspaceId: string; inviterId: string },
  body: unknown,
  opts?: { now?: number },
): Promise<InviteMemberResult> {
  const fields = isRecord(body) ? body : {};
  const email = normalizeEmail(fields.email);
  if (email === null) {
    return { kind: "invalid", error: "A valid email is required" };
  }
  if (!isWorkspaceRole(fields.role)) {
    return { kind: "invalid", error: "Role must be manager or staff" };
  }
  const role = fields.role;

  const workspaceRows = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1);
  const workspaceName = workspaceRows[0]?.name ?? "a workspace";

  const memberRows = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .innerJoin(user, eq(workspaceMembers.userId, user.id))
    .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(user.email, email)))
    .limit(1);
  if (memberRows.length > 0) {
    return { kind: "already-member" };
  }

  const now = opts?.now ?? Date.now();
  const windowStart = now - INVITE_SEND_WINDOW_MS;
  await db.delete(inviteSends).where(and(eq(inviteSends.workspaceId, ctx.workspaceId), lte(inviteSends.sentAt, windowStart)));
  // Reserve the send in ONE statement that counts the window and inserts
  // only below the limit. A count followed by a separate insert let
  // concurrent invites all see room and all send.
  const reserved = await db.insert(inviteSends).select(
    sql`select ${crypto.randomUUID()}, ${ctx.workspaceId}, ${now} where (select count(*) from ${inviteSends} where ${inviteSends.workspaceId} = ${ctx.workspaceId} and ${inviteSends.sentAt} > ${windowStart}) < ${INVITE_SEND_LIMIT}`,
  );
  if (rowsAffected(reserved, "invites") === 0) {
    return {
      kind: "limited",
      error: `This workspace has sent ${INVITE_SEND_LIMIT} invites in the last hour. Try again later.`,
    };
  }

  await db
    .insert(pendingInvites)
    .values({
      id: crypto.randomUUID(),
      email,
      workspaceId: ctx.workspaceId,
      role,
      invitedBy: ctx.inviterId,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [pendingInvites.email, pendingInvites.workspaceId],
      set: { role, invitedBy: ctx.inviterId, createdAt: now },
    });
  return { kind: "invited", email, workspaceName };
}

// userId: the member removed (their open sockets get closed), or null
// when a pending invite was withdrawn.
export type RemoveMemberResult = { kind: "invalid"; error: string } | { kind: "removed"; userId: string | null };

const SHOPIFY_MEMBER =
  "This person has access through a Shopify customer tag. Remove the tag from their customer in Shopify to remove their access.";

// Body {userId} removes a member; {email} withdraws a pending invite.
// Refused: removing yourself, and removing a member whose access comes from
// a Shopify tag (sign-in and the Shopify sync would only grant it again).
export async function removeMember(
  db: Db,
  ctx: { workspaceId: string; actorUserId: string },
  body: unknown,
): Promise<RemoveMemberResult> {
  const fields = isRecord(body) ? body : {};
  const targetUserId = typeof fields.userId === "string" ? fields.userId : "";
  const targetEmail = typeof fields.email === "string" ? fields.email.trim().toLowerCase() : "";

  if (targetUserId.length > 0) {
    if (targetUserId === ctx.actorUserId) {
      return { kind: "invalid", error: "You cannot remove yourself" };
    }
    const rows = await db
      .select({ id: workspaceMembers.id, source: workspaceMembers.source })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .limit(1);
    const target = rows[0];
    if (!target) {
      return { kind: "invalid", error: "No such member" };
    }
    if (target.source === "shopify") {
      return { kind: "invalid", error: SHOPIFY_MEMBER };
    }
    await db.delete(workspaceMembers).where(eq(workspaceMembers.id, target.id));
    return { kind: "removed", userId: targetUserId };
  }

  if (targetEmail.length > 0) {
    await db
      .delete(pendingInvites)
      .where(and(eq(pendingInvites.workspaceId, ctx.workspaceId), eq(pendingInvites.email, targetEmail)));
    return { kind: "removed", userId: null };
  }

  return { kind: "invalid", error: "userId or email is required" };
}

export type ChangeRoleResult = { kind: "invalid"; error: string } | { kind: "changed" };

const SHOPIFY_ROLE =
  "This person's role comes from their Shopify customer tag. Change the tag in Shopify to change their role.";

// Body {userId, role: manager | staff} sets a manual member's role.
// Refused: your own role (a manager could otherwise lock themselves out of
// the team settings), and a member whose role comes from a Shopify tag.
export async function changeMemberRole(
  db: Db,
  ctx: { workspaceId: string; actorUserId: string },
  body: unknown,
): Promise<ChangeRoleResult> {
  const fields = isRecord(body) ? body : {};
  const targetUserId = typeof fields.userId === "string" ? fields.userId : "";
  if (targetUserId.length === 0) {
    return { kind: "invalid", error: "userId is required" };
  }
  if (!isWorkspaceRole(fields.role)) {
    return { kind: "invalid", error: "Role must be manager or staff" };
  }
  if (targetUserId === ctx.actorUserId) {
    return { kind: "invalid", error: "You cannot change your own role" };
  }
  const rows = await db
    .select({ id: workspaceMembers.id, source: workspaceMembers.source })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1);
  const target = rows[0];
  if (!target) {
    return { kind: "invalid", error: "No such member" };
  }
  if (target.source === "shopify") {
    return { kind: "invalid", error: SHOPIFY_ROLE };
  }
  await db.update(workspaceMembers).set({ role: fields.role }).where(eq(workspaceMembers.id, target.id));
  return { kind: "changed" };
}
