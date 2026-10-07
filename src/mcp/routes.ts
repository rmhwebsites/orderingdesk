// The MCP server's routes in custom-worker.ts (comprehensive desk design
// section 4), after the host gate: /mcp, its protected resource metadata,
// the authorization server metadata and /oauth/*. Each resolved host's
// origin has its own OAuth provider (src/mcp/oauth/provider.ts); the
// provider serves its own endpoints, hands /mcp with a valid token to the
// MCP handler and everything else to the authorize page. Relative imports
// only: custom-worker.ts bundles this.

import { getDbFromEnv } from "../db";
import { sendSignInCodeEmail } from "../server/email/sign-in-code";
import { loadMailWorkspace } from "../server/email/workspace";
import { hostOrigin, type HostResolution } from "../server/host";
import { AUTH_SERVER_METADATA_PATH, AUTHORIZE_PATH, MCP_PATH, OAUTH_PREFIX, PROTECTED_RESOURCE_PATH } from "./constants";
import { mcpApiHandler } from "./handler";
import { authorize, type AuthorizeHelpers } from "./oauth/authorize";
import { providerFor, type ProviderHandlers } from "./oauth/provider";

export function isMcpRoute(pathname: string): boolean {
  return (
    pathname === MCP_PATH ||
    pathname === PROTECTED_RESOURCE_PATH ||
    pathname === AUTH_SERVER_METADATA_PATH ||
    (pathname.startsWith(OAUTH_PREFIX) && pathname.length > OAUTH_PREFIX.length)
  );
}

// The provider's defaultHandler: the authorize page, and 404 for anything
// else under the provider (env.OAUTH_PROVIDER is the library's helpers).
const authorizePage = {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== AUTHORIZE_PATH) {
      return new Response("Not found", { status: 404 });
    }
    const db = getDbFromEnv(env);
    return authorize(request, {
      db,
      env,
      helpers: (env as CloudflareEnv & { OAUTH_PROVIDER: AuthorizeHelpers }).OAUTH_PROVIDER,
      now: Date.now,
      background: (work) => ctx.waitUntil(work),
      sendCode: async (message) =>
        sendSignInCodeEmail(env, {
          to: message.to,
          code: message.code,
          clientLabel: message.clientLabel,
          workspace: message.workspaceId ? await loadMailWorkspace(db, message.workspaceId) : null,
        }),
    });
  },
};

const HANDLERS: ProviderHandlers = { api: mcpApiHandler, ui: authorizePage };

export async function handleMcpRoute(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext,
  resolution: HostResolution,
): Promise<Response> {
  const origin = hostOrigin(env, resolution);
  if (origin === null) {
    return new Response("Not found", { status: 404 });
  }
  return providerFor(origin, HANDLERS).fetch(request, env, ctx);
}
