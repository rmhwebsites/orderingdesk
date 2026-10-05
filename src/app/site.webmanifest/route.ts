import { getCloudflareContext } from "@opennextjs/cloudflare";
import { appIdentity, loadSymbol, manifestFor } from "@/server/pwa/manifest";
import { requestHost } from "@/server/request-host";

// Per host: the routed host decides what it is.
export const dynamic = "force-dynamic";

// The web app manifest for this host (src/server/pwa/manifest.ts). PUBLIC:
// browsers fetch manifests without cookies. 404 on a host that is neither
// the hub nor an active client host.
export async function GET() {
  const identity = appIdentity(await requestHost());
  if (!identity) {
    return new Response("Not found", { status: 404 });
  }
  const { env } = getCloudflareContext();
  const symbol = await loadSymbol(env.PO_BUCKET, identity, false);
  return new Response(JSON.stringify(manifestFor(identity, symbol)), {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
