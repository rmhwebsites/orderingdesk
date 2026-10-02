import { getCloudflareContext } from "@opennextjs/cloudflare";
import { serveBrandFile } from "@/server/branding/assets";

type RouteContext = { params: Promise<{ workspaceId: string; file: string }> };

// PUBLIC, no session: mail clients and the signed-out client host sign-in
// page load workspace logos from here. Only branding file names, only under
// that workspace's branding/ prefix in R2; immutable caching, nosniff,
// inline, and a sandboxing CSP (see serveBrandFile).
export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId, file } = await context.params;
  const { env } = getCloudflareContext();
  try {
    return await serveBrandFile(env.PO_BUCKET, workspaceId, file);
  } catch (e) {
    console.error("[branding] " + JSON.stringify({ error: e instanceof Error ? e.name : "failed" }));
    return new Response("Not available", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
