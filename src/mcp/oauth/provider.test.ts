import { describe, it, expect, vi } from "vitest";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { HUB, ORIGIN, fakeCtx, memoryKv, testEnv } from "../test-helpers";
import { oauthHelpers, providerOptions } from "./provider";

function setup(origin = ORIGIN) {
  const api = { fetch: vi.fn(async () => new Response("api")) };
  const ui = { fetch: vi.fn(async () => new Response("ui")) };
  const provider = new OAuthProvider(providerOptions(origin, { api, ui }));
  const env = testEnv({ OAUTH_KV: memoryKv() } as Partial<CloudflareEnv>);
  return { provider, api, ui, env };
}

describe("per-host OAuth providers (the real library)", () => {
  it("publishes this host as its own issuer, with its endpoints and S256 only", async () => {
    const { provider, env } = setup();
    const response = await provider.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env, fakeCtx());
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining(["desk.read", "desk.write", "offline_access"]));
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    // Claude uses its Client ID Metadata Document only when "none" is listed
    // here too (its CIMD client is public); otherwise it registers.
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(["none"]));
  });

  it("publishes /mcp as the protected resource, authorized by this host", async () => {
    const { provider, env } = setup();
    const response = await provider.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), env, fakeCtx());
    expect(await response.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  });

  it("challenges a call without a token with this host's metadata and never reaches the MCP handler", async () => {
    const { provider, api, env } = setup();
    const response = await provider.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }), env, fakeCtx());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("hands the authorize path to the app's page", async () => {
    const { provider, ui, env } = setup();
    const response = await provider.fetch(new Request(`${ORIGIN}/oauth/authorize?client_id=x`), env, fakeCtx());
    expect(await response.text()).toBe("ui");
    expect(ui.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses dynamic registration for redirect hosts that are not AI apps", async () => {
    const { provider, env } = setup();
    const response = await provider.fetch(
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Lookalike", redirect_uris: ["https://evil.example.com/cb"], token_endpoint_auth_method: "none" }),
      }),
      env,
      fakeCtx(),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });

  it("keeps a connection 90 days, fixed, with 30 minute access tokens", () => {
    const options = providerOptions(ORIGIN, { api: { fetch: async () => new Response("api") }, ui: { fetch: async () => new Response("ui") } });
    expect(options.refreshTokenTTL).toBe(90 * 24 * 60 * 60);
    expect(options.accessTokenTTL).toBe(30 * 60);
  });

  it("keeps the hub a separate issuer", async () => {
    const { provider, env } = setup(`https://${HUB}`);
    const response = await provider.fetch(new Request(`https://${HUB}/.well-known/oauth-authorization-server`), env, fakeCtx());
    expect(((await response.json()) as { issuer: string }).issuer).toBe(`https://${HUB}`);
  });

  it("gives the app OAuth helpers for revoking", () => {
    const helpers = oauthHelpers(testEnv({ OAUTH_KV: memoryKv() } as Partial<CloudflareEnv>));
    expect(typeof helpers.listUserGrants).toBe("function");
    expect(typeof helpers.revokeGrant).toBe("function");
  });
});
