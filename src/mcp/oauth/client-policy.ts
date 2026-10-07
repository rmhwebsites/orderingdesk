// Which AI apps may connect (comprehensive desk design section 4; Wave 2
// plan, Decision 2): Claude and ChatGPT by their own documented callback
// URLs (host and path, no query), and apps on the person's computer
// (Claude Code, the MCP Inspector) on a loopback redirect, which the
// consent page warns about. Pinning the path matters: any other page on
// those hosts that redirects onward would hand the code to someone else.
// Dynamic registration stays for apps without a metadata document, but
// only with those redirect URIs. The app's kind for "via Claude" comes from
// its verified domain or redirect host, never from the name it gives
// itself. Pure. Relative imports only.

import type { AiClient } from "../../lib/via";

export const AI_APP_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com"] as const;
// Claude's hosted apps (web, desktop, mobile) use one fixed callback;
// ChatGPT uses a stable one when the server returns iss (this library
// always does) and a per-connector one otherwise.
const CLAUDE_CALLBACK = "/api/mcp/auth_callback";
const CHATGPT_CALLBACK = "/connector_platform_oauth_redirect";
const CHATGPT_CONNECTOR_CALLBACK = /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;
const CLAUDE_DOMAINS = ["claude.ai", "claude.com", "anthropic.com"];
const OPENAI_DOMAINS = ["chatgpt.com", "openai.com"];
const REFUSAL = "Ordering Desk connects to Claude, ChatGPT and apps on this computer only.";

export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === "localhost" || name === "::1" || name === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

function within(host: string | null | undefined, domains: readonly string[]): boolean {
  if (!host) {
    return false;
  }
  const name = host.toLowerCase();
  return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

export function isAllowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:") {
    return isLoopbackHost(host);
  }
  if (url.protocol !== "https:" || url.port !== "" || url.search !== "" || !(AI_APP_REDIRECT_HOSTS as readonly string[]).includes(host)) {
    return false;
  }
  if (host === "chatgpt.com") {
    return url.pathname === CHATGPT_CALLBACK || CHATGPT_CONNECTOR_CALLBACK.test(url.pathname);
  }
  return url.pathname === CLAUDE_CALLBACK;
}

export function clientOf(facts: { clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean }): AiClient {
  if (facts.redirectIsLoopback) {
    return within(facts.clientDomain, CLAUDE_DOMAINS) ? "claude-code" : "other";
  }
  if (within(facts.redirectHost, CLAUDE_DOMAINS)) {
    return "claude";
  }
  if (within(facts.redirectHost, OPENAI_DOMAINS)) {
    return "chatgpt";
  }
  return "other";
}

export function consentAllowed(facts: { clientDomain?: string; redirectUri: string; redirectIsLoopback: boolean }): boolean {
  if (!isAllowedRedirect(facts.redirectUri)) {
    return false;
  }
  if (facts.redirectIsLoopback) {
    return true;
  }
  return facts.clientDomain ? within(facts.clientDomain, [...CLAUDE_DOMAINS, ...OPENAI_DOMAINS]) : true;
}

// The dynamic registration callback: undefined allows, an object refuses.
export function registrationRefusal(metadata: Record<string, unknown>): { code: string; description: string; status: number } | undefined {
  const uris = metadata.redirect_uris;
  const ok = Array.isArray(uris) && uris.length > 0 && uris.every((uri) => typeof uri === "string" && isAllowedRedirect(uri));
  return ok ? undefined : { code: "invalid_redirect_uri", description: REFUSAL, status: 400 };
}
