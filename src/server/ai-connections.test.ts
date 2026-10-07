import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { ADMIN, HUB, MANAGER, NOW, STAFF, WS, seedGrant, setupMcp } from "@/mcp/test-helpers";
import { loadAiSettings, revokeAllConnections, revokeConnection, updateAiSettings } from "./ai-connections";

const MCP_URL = "https://orders.example.com/mcp";

async function setup() {
  const db = await setupMcp();
  await seedGrant(db, { id: "g_casey", userId: MANAGER });
  await seedGrant(db, { id: "g_riley", userId: STAFF, client: "chatgpt", scopes: ["desk.read"] });
  await seedGrant(db, { id: "g_old", userId: STAFF, revokedAt: NOW - 1 });
  // Avery Stone's hub connection for every workspace (owner decision 3).
  await seedGrant(db, { id: "g_avery_every", workspaceId: null, userId: ADMIN, host: HUB });
  return db;
}

describe("AI connections in Settings", () => {
  it("shows staff their own connections, managers everyone's, and who may change what", async () => {
    const db = await setup();
    const staff = await loadAiSettings(db, { workspaceId: WS, viewerUserId: STAFF, role: "staff", mcpUrl: MCP_URL, now: NOW });
    expect(staff).toMatchObject({ mcpUrl: MCP_URL, teamAccess: true, canManage: false, canSwitch: false });
    expect(staff.limits).toEqual({ readsPerDay: 1000, staffChangesPerDay: 50, managerChangesPerDay: 100 });
    expect(staff.connections).toEqual([
      expect.objectContaining({ id: "g_riley", person: "Riley Oakes", mine: true, app: "ChatGPT", access: "read" }),
    ]);
    const manager = await loadAiSettings(db, { workspaceId: WS, viewerUserId: MANAGER, role: "manager", mcpUrl: MCP_URL, now: NOW });
    expect(manager.connections.map((connection) => [connection.id, connection.mine, connection.access]).sort()).toEqual([
      ["g_casey", true, "change"],
      ["g_riley", false, "read"],
    ]);
    expect(manager).toMatchObject({ canManage: true, canSwitch: false });
    // Platform admins on the hub also see every platform admin's connection
    // for every workspace, since each can act here; managers do not.
    const admin = await loadAiSettings(db, { workspaceId: WS, viewerUserId: ADMIN, role: "platform", mcpUrl: MCP_URL, now: NOW });
    expect(admin.canSwitch).toBe(true);
    expect(admin.connections.map((connection) => [connection.id, connection.mine, connection.everyWorkspace]).sort()).toEqual([
      ["g_avery_every", true, true],
      ["g_casey", false, false],
      ["g_riley", false, false],
    ]);
  });

  it("lets a person revoke their own connection and a manager anyone's, nobody else", async () => {
    const db = await setup();
    expect(await revokeConnection(db, { workspaceId: WS, grantId: "g_casey", viewerUserId: STAFF, role: "staff" }, NOW)).toEqual({ kind: "not-found" });
    expect(await revokeConnection(db, { workspaceId: WS, grantId: "g_riley", viewerUserId: STAFF, role: "staff" }, NOW)).toEqual({ kind: "revoked" });
    expect(await revokeConnection(db, { workspaceId: WS, grantId: "g_casey", viewerUserId: ADMIN, role: "manager" }, NOW)).toEqual({ kind: "revoked" });
    const rows = await db.select().from(schema.aiGrants);
    expect(rows.find((row) => row.id === "g_riley")).toMatchObject({ revokedBy: STAFF, revokeReason: "person" });
    expect(rows.find((row) => row.id === "g_casey")).toMatchObject({ revokedBy: ADMIN, revokeReason: "manager" });
    expect(await revokeConnection(db, { workspaceId: WS, grantId: "g_casey", viewerUserId: ADMIN, role: "manager" }, NOW)).toEqual({ kind: "not-found" });
  });

  it("lets only a platform admin revoke a connection for every workspace", async () => {
    const db = await setup();
    expect(await revokeConnection(db, { workspaceId: WS, grantId: "g_avery_every", viewerUserId: MANAGER, role: "manager" }, NOW)).toEqual({ kind: "not-found" });
    expect(await revokeConnection(db, { workspaceId: WS, grantId: "g_avery_every", viewerUserId: ADMIN, role: "platform" }, NOW)).toEqual({ kind: "revoked" });
    expect((await db.select().from(schema.aiGrants).where(eq(schema.aiGrants.id, "g_avery_every")))[0]).toMatchObject({ revokedBy: ADMIN, revokeReason: "person" });
  });

  it("revokes every connection that can act in the workspace for a platform admin, every-workspace ones included", async () => {
    const db = await setup();
    expect(await revokeAllConnections(db, { workspaceId: WS, viewerUserId: ADMIN }, NOW)).toBe(3);
    expect((await db.select().from(schema.aiGrants)).every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("saves daily limits for managers and the switch for platform admins, within bounds", async () => {
    const db = await setup();
    expect(await updateAiSettings(db, { workspaceId: WS, role: "manager" }, { readsPerDay: 500, staffChangesPerDay: 20, managerChangesPerDay: 60 })).toEqual({ kind: "saved" });
    const row = (await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, WS)))[0];
    expect([row.aiReadsPerDay, row.aiStaffChangesPerDay, row.aiManagerChangesPerDay]).toEqual([500, 20, 60]);
    expect(await updateAiSettings(db, { workspaceId: WS, role: "manager" }, { readsPerDay: 10 })).toEqual({
      kind: "invalid",
      error: "Lookups a day must be a whole number from 50 to 5000.",
    });
    expect(await updateAiSettings(db, { workspaceId: WS, role: "manager" }, { teamAccess: false })).toEqual({
      kind: "invalid",
      error: "Only a platform admin can turn AI connections on or off, on Ordering Desk.",
    });
    expect(await updateAiSettings(db, { workspaceId: WS, role: "staff" }, { readsPerDay: 500 })).toMatchObject({ kind: "invalid" });
    expect(await updateAiSettings(db, { workspaceId: WS, role: "platform" }, { teamAccess: false })).toEqual({ kind: "saved" });
    expect(await updateAiSettings(db, { workspaceId: WS, role: "platform" }, {})).toEqual({ kind: "invalid", error: "Nothing to change." });
  });
});
