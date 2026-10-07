import { describe, it, expect } from "vitest";
import { OAuthProvider, getOAuthApi, AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "agents/mcp/server";
import * as z from "zod";

// The MCP server's packages load in the test runtime with the APIs this
// wave was written against (Wave 2 plan, Decisions 1).
describe("MCP and OAuth packages", () => {
  it("load with the pinned APIs", () => {
    expect(typeof OAuthProvider).toBe("function");
    expect(typeof getOAuthApi).toBe("function");
    expect(typeof AuthorizationError).toBe("function");
    expect(typeof McpServer).toBe("function");
    expect(typeof Client).toBe("function");
    expect(typeof StreamableHTTPClientTransport).toBe("function");
    expect(typeof createMcpHandler).toBe("function");
    expect(z.object({ order: z.string() }).strict().parse({ order: "#D12" })).toEqual({ order: "#D12" });
  });
});
