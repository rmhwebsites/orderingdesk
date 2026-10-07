import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { seedWorkspace } from "@/server/desk/test-helpers";
import { principalInWorkspace } from "./every-workspace";
import { serveMcp } from "./handler";
import { resolveEveryWorkspace } from "./principal";
import { ALL_TOOLS } from "./tools";
import { ADMIN, HOST, HUB, MANAGER, NOW, WS, seedGrant, setupMcp, testEnv } from "./test-helpers";
import type { EveryWorkspaceConnection } from "./types";

const GRANT_EVERY = "g_every";
const props = (overrides: Record<string, unknown> = {}) => ({ v: 1, kind: "member", grantId: GRANT_EVERY, workspaceId: null, userId: ADMIN, ...overrides });

// Example Rentals (AI on, with its cards), Another Co (AI on), Closed Co (AI
// off), and Avery Stone's hub connection for every workspace. The AI switch
// defaults off (owner decision, Oct 7), so Another Co is turned on here.
async function setup(): Promise<Db> {
  const db = await setupMcp();
  await seedWorkspace(db, "ws_other");
  await db.update(schema.workspaces).set({ name: "Another Co" }).where(eq(schema.workspaces.id, "ws_other"));
  await db.update(schema.workspaceSettings).set({ aiTeam: true }).where(eq(schema.workspaceSettings.workspaceId, "ws_other"));
  await seedWorkspace(db, "ws_off");
  await db.update(schema.workspaces).set({ name: "Closed Co" }).where(eq(schema.workspaces.id, "ws_off"));
  await db.update(schema.workspaceSettings).set({ aiTeam: false }).where(eq(schema.workspaceSettings.workspaceId, "ws_off"));
  await seedGrant(db, { id: GRANT_EVERY, workspaceId: null, userId: ADMIN, host: HUB });
  return db;
}

const connection: EveryWorkspaceConnection = {
  userId: ADMIN,
  personName: "Avery Stone",
  grantId: GRANT_EVERY,
  client: "claude",
  scopes: ["desk.read", "desk.write", "offline_access"],
  host: HUB,
  grantExpiresAt: NOW + 86400000,
};

async function connectHub(db: Db) {
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", HUB);
    return serveMcp(new Request(input, { ...init, headers }), {
      db,
      env: testEnv(),
      props: props(),
      now: () => NOW,
      background: (work) => {
        void work.catch(() => undefined);
      },
    });
  };
  const client = new Client({ name: "ordering-desk-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://${HUB}/mcp`), { fetch: fetchImpl }));
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  // eslint-free any: tests read nested fields freely.
  return { isError: Boolean(result.isError), data: result.structuredContent as Record<string, any> };
}

describe("resolveEveryWorkspace", () => {
  it("serves a platform admin's hub connection, re-reading that they are still a platform admin", async () => {
    const db = await setup();
    expect(await resolveEveryWorkspace(db, testEnv(), { props: props(), hostname: HUB }, NOW)).toEqual(connection);
    expect(await resolveEveryWorkspace(db, testEnv({ PLATFORM_ADMIN_EMAILS: "" }), { props: props(), hostname: HUB }, NOW)).toBeNull();
    expect(await resolveEveryWorkspace(db, testEnv(), { props: props(), hostname: HOST }, NOW)).toBeNull();
    expect(await resolveEveryWorkspace(db, testEnv(), { props: props({ workspaceId: WS }), hostname: HUB }, NOW)).toBeNull();
    await seedGrant(db, { id: "g_casey_hub", userId: MANAGER, host: HUB });
    expect(await resolveEveryWorkspace(db, testEnv(), { props: props({ grantId: "g_casey_hub", userId: MANAGER }), hostname: HUB }, NOW)).toBeNull();
    await db.update(schema.aiGrants).set({ revokedAt: NOW - 1 }).where(eq(schema.aiGrants.id, GRANT_EVERY));
    expect(await resolveEveryWorkspace(db, testEnv(), { props: props(), hostname: HUB }, NOW)).toBeNull();
  });
});

describe("principalInWorkspace", () => {
  it("turns the workspace a call names, by id or name, into the per-workspace principal", async () => {
    const db = await setup();
    expect(await principalInWorkspace(db, connection, WS)).toEqual({
      ok: true,
      principal: {
        workspaceId: WS,
        workspaceName: "Example Rentals",
        userId: ADMIN,
        personName: "Avery Stone",
        role: "platform",
        grantId: GRANT_EVERY,
        client: "claude",
        scopes: ["desk.read", "desk.write", "offline_access"],
        host: HUB,
        limits: { reads: 1000, changes: 100 },
        grantExpiresAt: NOW + 86400000,
        everyWorkspace: true,
      },
    });
    expect(await principalInWorkspace(db, connection, "  another co ")).toMatchObject({ ok: true, principal: { workspaceId: "ws_other", workspaceName: "Another Co" } });
  });

  it("refuses a workspace with AI off, one that does not exist, and a name two workspaces share", async () => {
    const db = await setup();
    expect(await principalInWorkspace(db, connection, "ws_off")).toMatchObject({ ok: false, code: "forbidden", workspaceId: "ws_off" });
    expect(await principalInWorkspace(db, connection, "Nowhere Inc")).toMatchObject({ ok: false, code: "not_found", workspaceId: null });
    await seedWorkspace(db, "ws_twin");
    await db.update(schema.workspaces).set({ name: "Another Co" }).where(eq(schema.workspaces.id, "ws_twin"));
    expect(await principalInWorkspace(db, connection, "Another Co")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await principalInWorkspace(db, connection, "ws_other")).toMatchObject({ ok: true });
  });
});

describe("a platform admin's hub connection, through a real MCP client", () => {
  it("lists list_workspaces and every tool, each tool with a required workspace argument", async () => {
    const db = await setup();
    const client = await connectHub(db);
    const { tools } = await client.listTools();
    expect(tools.map((entry) => entry.name)).toEqual(["list_workspaces", ...ALL_TOOLS.map((entry) => entry.name)]);
    expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    for (const entry of tools.slice(1)) {
      expect(entry.inputSchema.required ?? [], entry.name).toContain("workspace");
    }
    const listed = await tool(client, "list_workspaces", {});
    expect(listed.data).toEqual({
      workspaces: [
        { id: "ws_other", name: "Another Co" },
        { id: WS, name: "Example Rentals" },
      ],
    });
  });

  it("answers in the workspace each call names, refuses one with AI off or unknown, and audits every call", async () => {
    const db = await setup();
    const client = await connectHub(db);
    const access = await tool(client, "get_my_access", { workspace: "Example Rentals" });
    expect(access.isError).toBe(false);
    expect(access.data).toMatchObject({ workspace: "Example Rentals", role: "Platform admin", connection_covers: expect.stringContaining("every workspace") });
    const off = await tool(client, "get_my_access", { workspace: "Closed Co" });
    expect(off.isError).toBe(true);
    expect(off.data.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("AI connections are off for Closed Co") });
    expect((await tool(client, "search_orders", { workspace: "Nowhere Inc" })).data.error).toMatchObject({ code: "not_found" });
    const audit = await db.select().from(schema.auditLog);
    expect(audit.map((row) => [row.workspaceId, row.tool, row.outcome])).toEqual(
      expect.arrayContaining([
        [WS, "get_my_access", "ok"],
        ["ws_off", "get_my_access", "forbidden"],
        [null, "search_orders", "not_found"],
      ]),
    );
    const usage = await db.select().from(schema.aiUsage);
    expect(usage.map((row) => [row.workspaceId, row.kind, row.count])).toEqual([[WS, "mcp_read", 1]]);
  });

  it("keeps a confirmation in the workspace it was prepared in", async () => {
    const db = await setup();
    const client = await connectHub(db);
    const note = "Checked from the hub.";
    const prepared = await tool(client, "prepare_add_note", { workspace: WS, order: "#D12", note });
    expect(prepared.data.confirm_with).toMatchObject({ tool: "confirm_add_note", workspace: WS, order: "#D12" });
    const elsewhere = await tool(client, "confirm_add_note", { workspace: "ws_other", confirmation_id: prepared.data.confirmation_id, order: "#D12", note });
    expect(elsewhere.data.error).toMatchObject({ code: "not_found" });
    const done = await tool(client, "confirm_add_note", { workspace: WS, confirmation_id: prepared.data.confirmation_id, order: "#D12", note });
    expect(done.data).toMatchObject({ done: true });
    const notes = await db.select().from(schema.events).where(and(eq(schema.events.orderId, "d1"), eq(schema.events.type, "note")));
    expect(notes.map((entry) => [entry.text, entry.source, entry.actorId])).toEqual([[note, "ai", ADMIN]]);
  });

  it("refuses the whole connection once the person is no longer a platform admin", async () => {
    const db = await setup();
    const response = await serveMcp(
      new Request(`https://${HUB}/mcp`, { method: "POST", headers: { host: HUB, "content-type": "application/json" }, body: "{}" }),
      { db, env: testEnv({ PLATFORM_ADMIN_EMAILS: "" }), props: props(), now: () => NOW, background: () => undefined },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"');
  });
});

describe("the tool catalog on an every-workspace connection", () => {
  it("has strict object inputs without a workspace field, so one can be added to each", () => {
    for (const entry of ALL_TOOLS) {
      expect(entry.input, entry.name).toBeInstanceOf(z.ZodObject);
      expect(Object.keys((entry.input as z.ZodObject).shape), entry.name).not.toContain("workspace");
    }
  });
});
