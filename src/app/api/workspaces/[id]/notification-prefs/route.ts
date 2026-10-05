import { NextResponse } from "next/server";
import { guardResponse, requireMember } from "@/server/guard";
import { getNotificationPrefs, saveNotificationPrefs } from "@/server/notification-prefs";

type RouteContext = { params: Promise<{ id: string }> };

// The signed-in person's own notification choices in this workspace:
// {member, prefs: {pushNewOrders, emailNewOrders, pushAllActivity}}.
// member is false for a platform admin who is not a member (nothing here
// notifies them).
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId } = await requireMember(id, "staff");
    return NextResponse.json(await getNotificationPrefs(db, id, userId));
  } catch (e) {
    return guardResponse(e);
  }
}

// Body: any of pushNewOrders, emailNewOrders, pushAllActivity (booleans).
// 200 {prefs}; 400 {error}; 404 for anyone who is not a member.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, userId } = await requireMember(id, "staff");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await saveNotificationPrefs(db, id, userId, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-member":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "saved":
        return NextResponse.json({ prefs: result.prefs });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
