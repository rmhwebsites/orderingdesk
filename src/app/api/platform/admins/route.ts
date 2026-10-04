import { NextResponse } from "next/server";
import { kickUsers } from "@/server/broadcast";
import { sendPlatformAdminInviteEmail } from "@/server/email/invite";
import { guardResponse, requirePlatformAdmin } from "@/server/guard";
import { invitePlatformAdmin, listPlatformAdmins, revokePlatformAdmin } from "@/server/platform-admins";
import { workspacesWithoutMember } from "@/server/platform-users";

// Every method: platform admins only (404 for anyone else, 401 signed out).

// {admins: [{email, userId, name, source: bootstrap | granted, grantedBy,
// createdAt}], invites: [{email, invitedBy, createdAt}]}
export async function GET() {
  try {
    const { db, env } = await requirePlatformAdmin();
    return NextResponse.json(await listPlatformAdmins(db, env));
  } catch (e) {
    return guardResponse(e);
  }
}

// Body {email}. 201 {ok} when promoted or invited (an email goes out); 200
// {ok, alreadyAdmin}; 400 {error}.
export async function POST(request: Request) {
  try {
    const { db, env, userId } = await requirePlatformAdmin();
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await invitePlatformAdmin(db, env, userId, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "already-admin":
        return NextResponse.json({ ok: true, alreadyAdmin: true });
      case "granted":
      case "invited":
        await sendPlatformAdminInviteEmail(env, result.email);
        return NextResponse.json({ ok: true }, { status: 201 });
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Body {userId} revokes a promoted admin (never yourself, never a bootstrap
// admin), closing their open sockets in every workspace they reached only
// as an admin, or {email} withdraws a pending invite. 200 {ok}; 400
// {error}.
export async function DELETE(request: Request) {
  try {
    const { db, env, userId } = await requirePlatformAdmin();
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await revokePlatformAdmin(db, env, userId, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    if (result.userId) {
      const revoked = result.userId;
      for (const workspaceId of await workspacesWithoutMember(db, revoked)) {
        await kickUsers(env, workspaceId, [revoked]);
      }
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
