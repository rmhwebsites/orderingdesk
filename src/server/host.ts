// Which host a request was routed to, and what that host is (platform
// amendment section 1). orderingdesk.com (the APP_URL host) is the hub; a
// workspace's custom domain (orders.<client domain>) opens that workspace,
// but only once a platform admin has checked it (custom_domain_status
// active). Every other host is unknown and gets a plain 404, so a stray
// hostname pointed at the Worker can never pose as the app.
//
// Relative imports only: custom-worker.ts bundles this file (gateRequest).

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { workspaces } from "../db/schema";

type HostEnv = { APP_URL: string };

export type HostWorkspace = typeof workspaces.$inferSelect;

export type HostResolution =
  | { kind: "hub" }
  | { kind: "workspace"; workspace: HostWorkspace }
  | { kind: "unknown" };

// The path that answers on every host, unknown ones included, so the domain
// check (src/server/domains.ts) can reach a host that is still pending.
export const HEALTH_PATH = "/api/health";

// Lowercased and trimmed, without the port or a trailing dot. "" for a
// missing host. An IPv6 literal keeps its brackets.
export function normalizeHost(host: string | null | undefined): string {
  if (typeof host !== "string") {
    return "";
  }
  let value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    value = end === -1 ? value : value.slice(0, end + 1);
  } else {
    const colon = value.indexOf(":");
    value = colon === -1 ? value : value.slice(0, colon);
  }
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function appUrl(env: HostEnv): URL | null {
  try {
    return new URL(env.APP_URL);
  } catch {
    return null;
  }
}

// The hub's hostname, or null when APP_URL is not a URL (then nothing is
// ever the hub).
export function hubHostname(env: HostEnv): string | null {
  const url = appUrl(env);
  return url ? normalizeHost(url.hostname) : null;
}

export async function resolveHost(db: Db, env: HostEnv, host: string | null | undefined): Promise<HostResolution> {
  const name = normalizeHost(host);
  if (name.length === 0) {
    return { kind: "unknown" };
  }
  const hub = hubHostname(env);
  if (hub !== null && name === hub) {
    return { kind: "hub" };
  }
  const rows = await db.select().from(workspaces).where(eq(workspaces.customDomain, name)).limit(1);
  const workspace = rows[0];
  if (!workspace || workspace.customDomainStatus !== "active") {
    return { kind: "unknown" };
  }
  return { kind: "workspace", workspace };
}

// The hub origin, such as https://orderingdesk.com (no trailing slash).
export function appOrigin(env: HostEnv): string {
  const url = appUrl(env);
  if (!url) {
    throw new Error("APP_URL is not a URL");
  }
  return url.origin;
}

// A client host's origin: the stored domain with the hub's scheme and port,
// so production is https://orders.<client domain> and local development
// (APP_URL http://localhost:3000) reaches a client host such as
// http://orders.example.localhost:3000. Built from the database, never from
// a request header.
function clientOrigin(env: HostEnv, domain: string): string {
  const url = appUrl(env);
  if (!url) {
    throw new Error("APP_URL is not a URL");
  }
  return `${url.protocol}//${domain}${url.port ? `:${url.port}` : ""}`;
}

// The origin a resolved host serves on (better-auth's baseURL and its only
// trusted origin), or null for an unknown host, which is refused.
export function hostOrigin(env: HostEnv, resolution: HostResolution): string | null {
  switch (resolution.kind) {
    case "hub":
      return appOrigin(env);
    case "workspace":
      return resolution.workspace.customDomain ? clientOrigin(env, resolution.workspace.customDomain) : null;
    case "unknown":
      return null;
  }
}

// Where links in a workspace's email point: its client host once that is
// active, else the hub.
export function workspaceOrigin(
  env: HostEnv,
  workspace: { customDomain: string | null; customDomainStatus: string | null },
): string {
  if (workspace.customDomain && workspace.customDomainStatus === "active") {
    return clientOrigin(env, workspace.customDomain);
  }
  return appOrigin(env);
}

export type SlugRoute = { kind: "render" } | { kind: "redirect"; to: "/" } | { kind: "not-found" };

// The /w/[slug] pages by host. The hub renders any slug (the guards decide
// access); a client host lives at its own root, so its own slug goes to "/"
// and every other workspace is not found there; an unknown host shows
// nothing.
export function slugRouteForHost(resolution: HostResolution, slug: string): SlugRoute {
  switch (resolution.kind) {
    case "hub":
      return { kind: "render" };
    case "workspace":
      return resolution.workspace.slug === slug ? { kind: "redirect", to: "/" } : { kind: "not-found" };
    case "unknown":
      return { kind: "not-found" };
  }
}

const NOT_FOUND_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title></head><body style="font-family: sans-serif; padding: 48px 16px; text-align: center;"><h1 style="font-size: 20px;">Not found</h1></body></html>';

export type GateResult = { kind: "pass"; request: Request } | { kind: "respond"; response: Response };

// Runs in custom-worker.ts before anything else:
// - an unknown host (including a client domain that is not active yet) gets
//   a plain, unbranded 404 for every path except HEALTH_PATH;
// - OpenNext copies an incoming x-forwarded-host over Host before Next.js
//   sees the request, which would let a client choose the host the app
//   believes it is on. A request that carries one is rebuilt with it pinned
//   to the host Cloudflare actually routed (the request URL's host), so
//   the Host that pages, the auth origin and the health route read is
//   always the routed one.
export async function gateRequest(request: Request, env: HostEnv, db: Db): Promise<GateResult> {
  const url = new URL(request.url);
  if (url.pathname !== HEALTH_PATH) {
    const resolution = await resolveHost(db, env, url.host);
    if (resolution.kind === "unknown") {
      return {
        kind: "respond",
        response: new Response(NOT_FOUND_PAGE, {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        }),
      };
    }
  }
  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded === null || forwarded === url.host) {
    return { kind: "pass", request };
  }
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", url.host);
  return { kind: "pass", request: new Request(request, { headers }) };
}
