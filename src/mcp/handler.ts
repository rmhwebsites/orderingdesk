// The MCP endpoint behind the OAuth library (comprehensive desk design
// section 4): the library has validated the bearer token for this host's
// /mcp resource and hands over its props; the principal is then resolved
// from D1 (src/mcp/principal.ts) and a stateless Agents SDK handler serves
// the call with a server built for that principal. A refused principal
// gets 401 invalid_token with this host's resource metadata, so the chat
// app asks the person to connect again. Relative imports only:
// custom-worker.ts bundles this.

import { createMcpHandler } from "agents/mcp/server";
import { getDbFromEnv, type Db } from "../db";
import type { AiRunner } from "../server/search/ai";
import { MCP_PATH, PROTECTED_RESOURCE_PATH } from "./constants";
import { resolvePrincipal } from "./principal";
import { buildServer } from "./server";
import type { ToolDeps } from "./tools/define";

export type ServeOptions = {
  db: Db;
  env: CloudflareEnv;
  props: unknown;
  now: () => number;
  background: (work: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function invalidToken(origin: string): Response {
  return new Response(
    JSON.stringify({ error: "invalid_token", error_description: "This connection was revoked or no longer has access. Connect again." }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": `Bearer realm="OAuth", error="invalid_token", error_description="The connection was revoked or no longer has access", resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}"`,
      },
    },
  );
}

export async function serveMcp(request: Request, opts: ServeOptions): Promise<Response> {
  const url = new URL(request.url);
  const principal = await resolvePrincipal(opts.db, opts.env, { props: opts.props, hostname: url.hostname }, opts.now());
  if (!principal) {
    console.log("[mcp] " + JSON.stringify({ host: url.hostname, refused: "no_access" }));
    return invalidToken(url.origin);
  }
  const deps: ToolDeps = {
    db: opts.db,
    env: opts.env,
    principal,
    now: opts.now,
    after: (work) => opts.background(work()),
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    ai: (opts.env as { AI?: unknown }).AI as AiRunner | undefined,
  };
  const handler = createMcpHandler(() => buildServer(deps), { route: MCP_PATH, allowedHostnames: [url.hostname] });
  return handler.fetch(request);
}

// The OAuth library's apiHandler: ctx.props is what the authorize page
// stored with the grant.
export const mcpApiHandler = {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    return serveMcp(request, {
      db: getDbFromEnv(env),
      env,
      props: (ctx as ExecutionContext & { props?: unknown }).props,
      now: Date.now,
      background: (work) => ctx.waitUntil(work),
    });
  },
};
