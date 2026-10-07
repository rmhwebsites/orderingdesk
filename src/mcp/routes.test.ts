import { describe, it, expect } from "vitest";
import { HUB, fakeCtx, memoryKv, testEnv } from "./test-helpers";
import { handleMcpRoute, isMcpRoute } from "./routes";

describe("MCP routes", () => {
  it("are exactly the MCP endpoint, its metadata and the OAuth paths", () => {
    for (const path of ["/mcp", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/oauth/authorize", "/oauth/token", "/oauth/register"]) {
      expect(isMcpRoute(path), path).toBe(true);
    }
    for (const path of ["/", "/mcp/", "/mcpx", "/api/mcp", "/.well-known/openid-configuration", "/oauth", "/w/x"]) {
      expect(isMcpRoute(path), path).toBe(false);
    }
  });

  it("serve each host with its own provider, and nothing on an unknown host", async () => {
    const env = testEnv({ OAUTH_KV: memoryKv() } as Partial<CloudflareEnv>);
    const hub = await handleMcpRoute(new Request(`https://${HUB}/.well-known/oauth-authorization-server`), env, fakeCtx(), { kind: "hub" });
    expect(((await hub.json()) as { issuer: string }).issuer).toBe(`https://${HUB}`);
    const unknown = await handleMcpRoute(new Request("https://stray.example.com/mcp"), env, fakeCtx(), { kind: "unknown" });
    expect(unknown.status).toBe(404);
  });
});
