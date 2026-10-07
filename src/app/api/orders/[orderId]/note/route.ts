import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { followNote } from "@/server/desk/follow";
import { addOrderNote } from "@/server/desk/mutations";
import { guardResponse, requireMemberByOrder } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// Body {text}: trimmed, 1 to 4000 characters. 200 {event}.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await addOrderNote(db, { workspaceId, orderId, userId, role }, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "added": {
        // After the response: open drawers on this order append the note,
        // and members who opted into all activity get a push (best effort,
        // never fails the request).
        const { env, ctx } = getCloudflareContext();
        ctx.waitUntil(followNote(db, env, workspaceId, result.event));
        return NextResponse.json({ event: result.event });
      }
    }
  } catch (e) {
    return guardResponse(e);
  }
}
