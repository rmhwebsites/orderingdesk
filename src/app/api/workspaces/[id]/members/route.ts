import { NextResponse } from "next/server";
import { roleAtLeast } from "@/lib/roles";
import { kickUsers } from "@/server/broadcast";
import { sendWorkspaceInviteEmail } from "@/server/email/invite";
import { loadMailWorkspace } from "@/server/email/workspace";
import { guardResponse, requireMember } from "@/server/guard";
import { changeMemberRole, inviteMember, listMembers, removeMember } from "@/server/members";

type RouteContext = { params: Promise<{ id: string }> };

// Any member: {members: [{userId, role, source, email, name}]}. Managers and
// platform admins also get {invites: [{email, role, createdAt}]}.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, role } = await requireMember(id, "staff");
    return NextResponse.json(await listMembers(db, id, { includeInvites: roleAtLeast(role, "manager") }));
  } catch (e) {
    return guardResponse(e);
  }
}

// Managers and platform admins. Body {email, role: manager | staff}. 201
// {ok} when the invite is stored (an email goes out; the same answer
// whether or not the email has an account, see inviteMember); 200 {ok,
// alreadyMember} when they already belong here (nothing changes, nothing
// is sent); 429 {error} when the workspace has used its hourly invite
// allowance; 400 {error}.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId, env } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await inviteMember(db, { workspaceId: id, inviterId: userId }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "already-member":
        return NextResponse.json({ ok: true, alreadyMember: true });
      case "limited":
        return NextResponse.json({ error: result.error }, { status: 429 });
      case "invited": {
        // The invite carries the workspace's branding and sender.
        const workspace = await loadMailWorkspace(db, id);
        if (workspace) {
          await sendWorkspaceInviteEmail(env, result.email, workspace);
        }
        return NextResponse.json({ ok: true }, { status: 201 });
      }
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Managers and platform admins. Body {userId, role: manager | staff}
// changes a manual member's role (never your own, never a Shopify-tagged
// member, whose role follows the tag). 200 {ok}; 400 {error}.
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await changeMemberRole(db, { workspaceId: id, actorUserId: userId }, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}

// Managers and platform admins. Body {userId} removes a member (never
// yourself, never a Shopify-tagged member) and closes their open sockets,
// or {email} withdraws a pending invite. 200 {ok}; 400 {error}.
export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId, env } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await removeMember(db, { workspaceId: id, actorUserId: userId }, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (result.userId) {
      await kickUsers(env, id, [result.userId]);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
