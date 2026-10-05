import { getCloudflareContext } from "@opennextjs/cloudflare";
import { renderIcon } from "@/server/pwa/icon";
import { appIdentity, iconVariant, loadSymbol } from "@/server/pwa/manifest";
import { requestHost } from "@/server/request-host";

// Per host: the routed host decides what it is.
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ file: string }> };

// This host's app icon as a PNG (src/server/pwa/manifest.ts): 192.png,
// 512.png, maskable-512.png (manifest), apple-180.png (iPhone home screen).
// The workspace symbol when it has a usable one (not for the maskable
// shape, which needs its safe zone), else the generated letter icon.
// PUBLIC, like the manifest. 404 for any other file or host.
export async function GET(_request: Request, context: RouteContext) {
  const { file } = await context.params;
  const variant = iconVariant(file);
  const identity = variant ? appIdentity(await requestHost()) : null;
  if (!variant || !identity) {
    return new Response("Not found", { status: 404 });
  }
  const headers = {
    "content-type": "image/png",
    "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    "x-content-type-options": "nosniff",
  };
  if (variant.symbol) {
    const { env } = getCloudflareContext();
    const symbol = await loadSymbol(env.PO_BUCKET, identity, true);
    if (symbol?.bytes) {
      return new Response(symbol.bytes as BodyInit, { headers });
    }
  }
  const png = await renderIcon({ size: variant.size, shape: variant.shape, ...identity.letter });
  return new Response(png as BodyInit, { headers });
}
