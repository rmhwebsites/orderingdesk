import { describe, it, expect } from "vitest";
import { clientOf, consentAllowed, isAllowedRedirect, isLoopbackHost, registrationRefusal } from "./client-policy";

describe("which AI apps may connect", () => {
  it("accepts Claude's and ChatGPT's callbacks and loopback apps, nothing else", () => {
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc123",
      "http://localhost:6274/oauth/callback",
      "http://127.0.0.1:33418/callback",
    ]) {
      expect(isAllowedRedirect(uri), uri).toBe(true);
    }
    for (const uri of [
      "https://evil.example.com/cb",
      "https://claude.ai.evil.example.com/cb",
      "http://claude.ai/api/mcp/auth_callback",
      "http://orders.example.com/cb",
      // Only the apps' own callback paths: any other page on their hosts
      // (an open redirect there would leak the code) is refused.
      "https://claude.ai/artifact/abc",
      "https://claude.ai/api/mcp/auth_callback?next=https://evil.example.com",
      "https://chatgpt.com/connector/oauth/abc/next",
      "https://chatgpt.com/share/abc",
      "javascript:alert(1)",
      "com.example.app:/callback",
      "not a url",
    ]) {
      expect(isAllowedRedirect(uri), uri).toBe(false);
    }
    expect(isLoopbackHost("127.0.0.9")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("orders.example.localhost")).toBe(false);
  });

  it("names the app from its verified domain or redirect host, never its own name", () => {
    expect(clientOf({ redirectHost: "claude.ai", redirectIsLoopback: false, clientDomain: "claude.ai" })).toBe("claude");
    expect(clientOf({ redirectHost: "claude.com", redirectIsLoopback: false })).toBe("claude");
    expect(clientOf({ redirectHost: "chatgpt.com", redirectIsLoopback: false, clientDomain: "chatgpt.com" })).toBe("chatgpt");
    expect(clientOf({ redirectHost: "localhost", redirectIsLoopback: true, clientDomain: "claude.ai" })).toBe("claude-code");
    expect(clientOf({ redirectHost: "localhost", redirectIsLoopback: true })).toBe("other");
    expect(clientOf({ redirectHost: "127.0.0.1", redirectIsLoopback: true, clientDomain: "inspector.example.com" })).toBe("other");
  });

  it("allows consent only for those apps", () => {
    expect(consentAllowed({ clientDomain: "claude.ai", redirectUri: "https://claude.ai/api/mcp/auth_callback", redirectIsLoopback: false })).toBe(true);
    expect(consentAllowed({ redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect", redirectIsLoopback: false })).toBe(true);
    expect(consentAllowed({ clientDomain: "evil.example.com", redirectUri: "https://claude.ai/api/mcp/auth_callback", redirectIsLoopback: false })).toBe(false);
    expect(consentAllowed({ redirectUri: "https://evil.example.com/cb", redirectIsLoopback: false })).toBe(false);
    expect(consentAllowed({ clientDomain: "inspector.example.com", redirectUri: "http://localhost:6274/oauth/callback", redirectIsLoopback: true })).toBe(true);
  });

  it("refuses dynamic registration unless every redirect URI is allowed", () => {
    expect(registrationRefusal({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).toBeUndefined();
    expect(registrationRefusal({ redirect_uris: ["http://localhost:6274/oauth/callback", "http://127.0.0.1:6274/oauth/callback"] })).toBeUndefined();
    for (const metadata of [
      { redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example.com/cb"] },
      { redirect_uris: [] },
      { redirect_uris: "https://claude.ai/api/mcp/auth_callback" },
      {},
    ]) {
      expect(registrationRefusal(metadata)).toEqual({
        code: "invalid_redirect_uri",
        description: "Ordering Desk connects to Claude, ChatGPT and apps on this computer only.",
        status: 400,
      });
    }
  });
});
