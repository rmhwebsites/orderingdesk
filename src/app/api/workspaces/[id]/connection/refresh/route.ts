import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { refreshConnection } from "@/server/desk/connection-refresh";
import { guardResponse, requireMember } from "@/server/guard";

type RouteContext = { params: Promise<{ id: string }> };

// PLATFORM ADMINS ONLY (404 for anyone else, and on a client host), like
// PUT .../connection: re-reads the store's granted scopes with a freshly
// minted token after a new version of the Shopify app was approved, saves
// them, and registers the webhooks for them (the draft order topics once
// the draft scopes are granted). No body. 200 {connection:
// ConnectionSettingsView, warning?} where warning names missing required
// scopes or says the webhooks were not registered (the store stays
// connected); 409 {error} with no connected store or rejected credentials;
// 502 {error} when Shopify cannot be reached. Never returns or logs a
// credential or token.
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { db } = await requireMember(id, "platform");
    const { env } = getCloudflareContext();
    const result = await refreshConnection(db, {
      workspaceId: id,
      encryptionKey: env.ENCRYPTION_KEY,
      appUrl: env.APP_URL,
    });
    switch (result.kind) {
      case "no-connection":
      case "rejected":
        return NextResponse.json({ error: result.error }, { status: 409 });
      case "unreachable":
        return NextResponse.json({ error: result.error }, { status: 502 });
      case "refreshed":
        return NextResponse.json({
          connection: result.connection,
          ...(result.warning ? { warning: result.warning } : {}),
        });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
