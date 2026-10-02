import { NextResponse } from "next/server";
import { clearCustomDomain, setCustomDomain } from "@/server/domains";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY, every method (404 for anyone else, 401 signed out).
// The workspace's client host, such as orders.impactrentals.store. Attach
// it to the Worker in Cloudflare first (docs/HANDOFF.md), then save it here
// and POST .../domain/check.

// Body {domain}: a host name (no scheme, path or port; at least one dot;
// not the hub host; not used by another workspace). Saved lowercased with
// status pending; a different domain clears the sender verification. 200
// {domain, status}; 400 {error}; 409 {error} when another workspace uses it.
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env } = await requireMember(id, "platform");
    const body = (await request.json().catch(() => null)) as unknown;
    const result = await setCustomDomain(db, env, id, body);
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "taken":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "saved":
        return NextResponse.json(result.domain);
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Clears the domain (and the sender verification that depended on it).
// 200 {ok}.
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const result = await clearCustomDomain(db, id);
    if (result.kind === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
