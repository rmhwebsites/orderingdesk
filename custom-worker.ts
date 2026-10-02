// @ts-ignore .open-next/worker.js is generated at build time; the import only
// resolves after the first opennextjs-cloudflare build, so ts-expect-error
// would flip between used and unused across builds.
import handler from "./.open-next/worker.js";
export { WorkspaceRoom } from "./src/realtime/room";
import { getDbFromEnv } from "./src/db";
import { LIVE_PATH, handleLiveRequest } from "./src/realtime/live";
import { gateRequest } from "./src/server/host";
import { runScheduledSync } from "./src/server/sync/cron";

export default {
  async fetch(request, env, ctx) {
    // Host gate first (src/server/host.ts): an unknown host, or a client
    // domain that is not active yet, gets a plain 404 and never reaches the
    // app; x-forwarded-host is pinned to the routed host.
    const gated = await gateRequest(request, env, getDbFromEnv(env));
    if (gated.kind === "respond") {
      return gated.response;
    }
    // The realtime socket is answered here, before OpenNext: a Next.js route
    // handler cannot reliably hand back a WebSocket upgrade. Everything else
    // is the Next.js app.
    if (new URL(request.url).pathname === LIVE_PATH) {
      return handleLiveRequest(request, env);
    }
    return handler.fetch(gated.request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
} satisfies ExportedHandler<CloudflareEnv>;
