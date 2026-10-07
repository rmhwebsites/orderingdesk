import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Db } from "@/db";
import { broadcast, broadcastSync } from "@/server/broadcast";
import { EDIT_REFUSALS, editRequest, followEdit, loadRequestEditor } from "@/server/desk/edit-request";
import type { EventView } from "@/server/desk/shapes";
import { guardResponse, requireMemberByOrder, roleAtLeast } from "@/server/guard";
import { notifyActivity } from "@/server/notify";

type RouteContext = { params: Promise<{ orderId: string }> };

// A draft Shopify deleted: open desks show the card as deleted.
function shareDeleted(db: Db, env: CloudflareEnv, workspaceId: string, deleted: { orderId: string; event: EventView }) {
  return (async () => {
    await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [deleted.orderId] });
    await broadcast(env, workspaceId, { kind: "order.activity", event: deleted.event });
    await notifyActivity(db, env, workspaceId, deleted.event);
  })();
}

// The request editor (comprehensive design section 2;
// src/server/desk/edit-request.ts): the draft read fresh from Shopify.
// Managers and platform admins: 404 for outsiders, 403 for staff. 200
// {editor}; 409 or 502 {error} when it cannot be edited now.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: EDIT_REFUSALS.forbidden }, { status: 403 });
    }
    const { env, ctx } = getCloudflareContext();
    const result = await loadRequestEditor(db, { workspaceId, orderId, userId, role }, { env });
    switch (result.kind) {
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused":
        if (result.deleted) {
          ctx.waitUntil(shareDeleted(db, env, workspaceId, result.deleted));
        }
        return NextResponse.json({ error: result.error }, { status: result.status });
      case "editor":
        return NextResponse.json({ editor: result.editor });
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Save an edit. Body {updatedAt, lines: [{uuid, quantity}], locationId}
// (src/lib/request-edit.ts). 200 {kind: "edited", event, warning}, 200
// {kind: "unchanged"}; 400 {error}; 409 {error, editor?} (editor: the fresh
// one, when the request changed meanwhile); 502 {error}. Shopify gets the
// update once; nothing changed unless the answer says so.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: EDIT_REFUSALS.forbidden }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as unknown;
    const { env, ctx } = getCloudflareContext();
    const result = await editRequest(db, { workspaceId, orderId, userId, role }, body, { env });
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused":
        if (result.deleted) {
          ctx.waitUntil(shareDeleted(db, env, workspaceId, result.deleted));
        }
        return NextResponse.json(
          { error: result.error, ...(result.editor ? { editor: result.editor } : {}) },
          { status: result.status },
        );
      case "unchanged":
        return NextResponse.json({ kind: result.kind });
      case "edited":
        ctx.waitUntil(followEdit(db, env, workspaceId, orderId, result, {}));
        return NextResponse.json({ kind: result.kind, event: result.event, warning: result.warning });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
