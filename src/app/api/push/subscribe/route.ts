import { NextResponse } from "next/server";
import { guardResponse, requireSession } from "@/server/guard";
import { hubHostname, type HostResolution } from "@/server/host";
import { removeSubscription, saveSubscription } from "@/server/push";

// The host the browser is on, from the routed host (never a header the
// client chose): the hub's name or the client host's domain.
function subscribedHost(env: CloudflareEnv, host: HostResolution): string | null {
  if (host.kind === "workspace") {
    return host.workspace.customDomain;
  }
  return host.kind === "hub" ? hubHostname(env) : null;
}

// This browser's push subscription for the signed-in person. Body: the
// PushSubscription's toJSON() ({endpoint, keys: {p256dh, auth}}). 200 {ok};
// 400 {error} for anything else; 401 signed out.
export async function POST(request: Request) {
  try {
    const { db, env, host, userId } = await requireSession();
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await saveSubscription(
      db,
      { userId, host: subscribedHost(env, host), userAgent: request.headers.get("user-agent") },
      body,
    );
    if (result.kind === "invalid") {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}

// Body {endpoint}: stops push to this browser. 200 {ok}; 404 when the
// signed-in person has no subscription with that endpoint; 400 without one.
export async function DELETE(request: Request) {
  try {
    const { db, userId } = await requireSession();
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await removeSubscription(db, userId, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "removed":
        return NextResponse.json({ ok: true });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
