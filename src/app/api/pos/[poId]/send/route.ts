import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { broadcast } from "@/server/broadcast";
import { guardResponse, requireMemberByPo } from "@/server/guard";
import { notifyPoSent } from "@/server/notify";
import { sendPurchaseOrder } from "@/server/po/send";

type RouteContext = { params: Promise<{ poId: string }> };

// Sends the PO to its vendor (managers and platform admins; 404 for staff).
// Body {requestId, confirm: true, recipients: {to, cc}, contentVersion,
// resend?, timeZone?}: confirm must be true, recipients exactly who it
// would go to now and contentVersion the PoView.contentVersion of the PO
// the review step showed, or nothing is sent (src/server/po/send.ts).
// timeZone (the sender's) dates the PDF and the email.
// - 200 {po}: sent. 200 {po, unchanged: "already-sent" | "replayed"}:
//   nothing sent by this request (po says how the PO stands).
// - 400 {error} bad input; 400 {error, recipients, contentVersion, po} no
//   confirmation; 409 {error, recipients, contentVersion, po} the
//   recipients or the content changed since the review (po is what would
//   go out now: show it and confirm again); 409 {error, po} another send
//   holds it; 502 {error, po} the send failed (the PO is marked failed with
//   the reason; retry with a new requestId).
// After a send: the po_sent event reaches open desks and, on a first send,
// the team is notified (push and email; addresses already on the vendor
// email are skipped).
export async function POST(request: Request, context: RouteContext) {
  try {
    const { poId } = await context.params;
    const { db, env, userId, workspaceId } = await requireMemberByPo(poId, "manager");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await sendPurchaseOrder(db, { env, bucket: env.PO_BUCKET }, { workspaceId, poId, userId }, body);
    const { ctx } = getCloudflareContext();
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "confirm-required":
      case "recipients-changed":
      case "content-changed":
        return NextResponse.json(
          { error: result.error, recipients: result.recipients, contentVersion: result.po.contentVersion, po: result.po },
          { status: result.kind === "confirm-required" ? 400 : 409 },
        );
      case "busy":
        return NextResponse.json({ error: result.error, po: result.po }, { status: 409 });
      case "unchanged":
        return NextResponse.json({ po: result.po, unchanged: result.reason });
      case "failed":
        ctx.waitUntil(broadcast(env, workspaceId, { kind: "order.activity", event: result.event }));
        return NextResponse.json({ error: result.error, po: result.po }, { status: 502 });
      case "sent":
        ctx.waitUntil(
          (async () => {
            await broadcast(env, workspaceId, { kind: "order.activity", event: result.event });
            if (result.first) {
              await notifyPoSent(db, env, workspaceId, result.notice, { alreadyEmailed: result.emailed });
            }
          })(),
        );
        return NextResponse.json({ po: result.po });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
