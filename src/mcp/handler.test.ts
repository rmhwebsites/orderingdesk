import { describe, it, expect } from "vitest";
import * as schema from "@/db/schema";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Db } from "@/db";
import { serveMcp } from "./handler";
import { GRANT, HOST, MANAGER, NOW, ORIGIN, STAFF, WS, seedGrant, setupMcp, testEnv } from "./test-helpers";

const props = (overrides: Record<string, unknown> = {}) => ({ v: 1, kind: "member", grantId: GRANT, workspaceId: WS, userId: MANAGER, ...overrides });

async function connect(db: Db, grantProps: Record<string, unknown>) {
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", HOST);
    return serveMcp(new Request(input, { ...init, headers }), {
      db,
      env: testEnv(),
      props: grantProps,
      now: () => NOW,
      background: (work) => {
        void work.catch(() => undefined);
      },
    });
  };
  const client = new Client({ name: "ordering-desk-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: fetchImpl }));
  return client;
}

describe("the MCP endpoint", () => {
  it("answers 401 invalid_token, pointing at this host's metadata, when the connection no longer works", async () => {
    const db = await setupMcp();
    await seedGrant(db, { revokedAt: NOW - 1 });
    const response = await serveMcp(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: "{}" }),
      { db, env: testEnv(), props: props(), now: () => NOW, background: () => undefined },
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("serves the tools of the person's role to a real MCP client, as JSON with structured content", async () => {
    const db = await setupMcp();
    await seedGrant(db);
    const client = await connect(db, props());
    const listed = await client.listTools();
    const access = listed.tools.find((tool) => tool.name === "get_my_access");
    expect(access?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    const result = await client.callTool({ name: "get_my_access", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workspace: "Example Rentals",
      role: "Manager",
      access: "look up and change (each change previewed, then confirmed)",
      app: "Claude",
      today: { lookups_used: 1, lookups_limit: 1000, changes_used: 0, changes_limit: 100 },
    });
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(result.structuredContent);
    expect((await db.select().from(schema.auditLog)).map((row) => row.tool)).toContain("get_my_access");
  });

  it("refuses arguments a tool does not take", async () => {
    const db = await setupMcp();
    await seedGrant(db, { id: "g_riley", userId: STAFF });
    const client = await connect(db, props({ grantId: "g_riley", userId: STAFF }));
    const result = await client.callTool({ name: "get_my_access", arguments: { workspaceId: "ws_other" } }).catch((e: Error) => ({ isError: true, message: e.message }));
    expect(result.isError).toBe(true);
  });
});
