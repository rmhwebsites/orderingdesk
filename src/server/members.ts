// Workspace team management behind /api/workspaces/[id]/members. Managers
// invite and remove staff and managers in their own workspace; platform
// admins can do the same in any workspace (the route's guard decides who
// gets here). Memberships added here are source = manual.

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { pendingInvites, user, workspaceMembers, workspaces } from "@/db/schema";
import { isWorkspaceRole, type WorkspaceRole } from "@/lib/roles";
import { isRecord } from "./desk/shapes";
import { normalizeEmail } from "./desk/validate";

export type MemberView = {
  userId: string;
  role: WorkspaceRole;
  source: "manual" | "shopify";
  email: string | null;
  name: string | null;
};

export type PendingInviteView = { email: string; role: WorkspaceRole; createdAt: number };

// Members by email, plus this workspace's pending invites when asked (the
// route asks for managers and platform admins only).
export async function listMembers(
  db: Db,
  workspaceId: string,
  opts: { includeInvites: boolean },
): Promise<{ members: MemberView[]; invites?: PendingInviteView[] }> {
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
  return { members, invites };
}

export type InviteMemberResult =
  | { kind: "invalid"; error: string }
  // Already a member: nothing changed, nothing to send.
  | { kind: "already-member" }
  // An existing user, added at once.
  | { kind: "added"; email: string; workspaceName: string }
  // No account yet: a pending invite, claimed at their first sign-in.
  | { kind: "invited"; email: string; workspaceName: string };

export async function inviteMember(
  db: Db,
  ctx: { workspaceId: string; inviterId: string },
  body: unknown,
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

  const existingUser = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existingUser[0]) {
    const inserted = await db
      .insert(workspaceMembers)
      .values({
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        userId: existingUser[0].id,
        role,
        source: "manual",
      })
      .onConflictDoNothing()
      .returning({ id: workspaceMembers.id });
    return inserted.length > 0 ? { kind: "added", email, workspaceName } : { kind: "already-member" };
  }

  const now = Date.now();
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
