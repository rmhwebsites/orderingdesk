import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { kickUsers } from "@/server/broadcast";
import { deleteConnection, saveConnection } from "@/server/desk/connection";
import { guardResponse, requireMember } from "@/server/guard";
import { syncLocations } from "@/server/sync/locations";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY, both methods (404 for anyone else): this route
// carries Shopify credentials.
// Never log the request body or echo a credential. Errors thrown by
// saveConnection are already redacted (no secret, token or ciphertext, no
// cause chain), so guardResponse may log them.

// Body {shopDomain, clientId, clientSecret} for a Dev Dashboard app (client
// credentials), or {shopDomain, token} for a legacy Admin API token. The
// credentials are verified with Shopify before anything is stored; a client
// credentials save also registers the webhooks. 200 {connection:
// {shopDomain, status, lastSyncAt, lastError, shopName, authMode,
// webhooksRegisteredAt}, warning?} where warning says the webhooks could not
// be registered (the connection is saved and the cron sync runs); 400
// {error} for bad input or no store at the address; 409 {error} when the
// workspace already has orders and the domain names another store; 422
// {error} when Shopify rejects the credentials or a required permission is
// missing (each one named); 502 {error} when Shopify cannot be reached or
// errors. A save or refresh also starts the company location sync after the
// response (src/server/sync/locations.ts).
export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const body = (await request.json().catch(() => null)) as unknown;
    const { env, ctx } = getCloudflareContext();
    const result = await saveConnection(
      db,
      { workspaceId: id, encryptionKey: env.ENCRYPTION_KEY, appUrl: env.APP_URL },
      body,
    );
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "rejected":
        return NextResponse.json({ error: result.error }, { status: 422 });
      case "store-change":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "unreachable":
        return NextResponse.json({ error: result.error }, { status: 502 });
      case "saved":
        // The store's company locations, after the response (never throws).
        ctx.waitUntil(syncLocations(db, env, id));
        return NextResponse.json({
          connection: result.connection,
          ...(result.warning ? { warning: result.warning } : {}),
        });
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Disconnects the store: the connection row stays, disabled, with every
// stored secret cleared, so the one-store-per-workspace rule survives (see
// deleteConnection). Orders stay. Every access a Shopify tag gave here goes
// too, and those people's open sockets are closed.
export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db, env } = await requireMember(id, "platform");
    const { revokedUserIds } = await deleteConnection(db, id);
    await kickUsers(env, id, revokedUserIds);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return guardResponse(e);
  }
}
