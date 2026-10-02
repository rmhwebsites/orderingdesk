import { cache } from "react";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { resolveHost, type HostResolution } from "./host";

// What the current request's host is (src/server/host.ts), for pages, route
// handlers and the auth instance. Host is the header the platform routed:
// custom-worker.ts (gateRequest) pins x-forwarded-host to the routed host
// before OpenNext copies it over Host, so a client cannot choose it.
// cache() dedupes the lookup across the server components of one request.
export const requestHost = cache(async (): Promise<HostResolution> => {
  const { env } = getCloudflareContext();
  const host = (await headers()).get("host");
  return resolveHost(getDb(), env, host);
});
