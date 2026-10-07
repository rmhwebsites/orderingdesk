// @ts-ignore .open-next/worker.js is generated at build time; the import only
// resolves after the first opennextjs-cloudflare build, so ts-expect-error
// would flip between used and unused across builds.
import handler from "./.open-next/worker.js";
export { WorkspaceRoom } from "./src/realtime/room";
import { getDbFromEnv } from "./src/db";
import { handleMcpRoute, isMcpRoute } from "./src/mcp/routes";
import { LIVE_PATH, handleLiveRequest } from "./src/realtime/live";
import { gateRequest } from "./src/server/host";
import { runScheduledSync } from "./src/server/sync/cron";

export default {
  async fetch(request, env, ctx) {
    // Host gate first (src/server/host.ts): an unknown host, or a client
    // domain that is not active yet, gets a plain 404 and never reaches the
    // app; x-forwarded-host is pinned to the routed host.
    const db = getDbFromEnv(env);
    const gated = await gateRequest(request, env, db);
    if (gated.kind === "respond") {
      return gated.response;
    }
    // The realtime socket is answered here, before OpenNext: a Next.js route
    // handler cannot reliably hand back a WebSocket upgrade.
    const pathname = new URL(request.url).pathname;
    if (pathname === LIVE_PATH) {
      return handleLiveRequest(request, env, db);
    }
    // The MCP server and its OAuth endpoints (src/mcp/routes.ts): answered
    // here, before OpenNext, with the host the gate resolved.
    if (isMcpRoute(pathname) && gated.resolution !== null) {
      return handleMcpRoute(gated.request, env, ctx, gated.resolution);
    }
    // Everything else is the Next.js app.
    return handler.fetch(gated.request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
