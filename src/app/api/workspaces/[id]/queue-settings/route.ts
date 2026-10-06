import { NextResponse } from "next/server";
import { updateQueueSettings } from "@/server/desk/queue-settings";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// Managers and platform admins (401 signed out, 404 for staff and
// outsiders). Body {ageAmberDays, ageRedDays, priceDisplay: auto | show |
// hide}, the whole setting. 200 {queue}; 400 {error}.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await updateQueueSettings(db, id, body);
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ queue: result.queue });
  } catch (e) {
    return guardResponse(e);
  }
}
