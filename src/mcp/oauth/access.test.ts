import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { seedMember, seedWorkspace } from "@/server/desk/test-helpers";
import type { HostResolution } from "@/server/host";
import { ADMIN, MANAGER, STAFF, WS, setupMcp, testEnv } from "../test-helpers";
import { connectableUser, connectableWorkspaces, connectsToEveryWorkspace, teamAiOn } from "./access";

const env = testEnv();
const hub: HostResolution = { kind: "hub" };

async function hostOf(db: Awaited<ReturnType<typeof setupMcp>>): Promise<HostResolution> {
  const rows = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, WS));
  return { kind: "workspace", workspace: rows[0] };
}

const user = (id: string, email: string) => ({ id, email });

describe("who may connect", () => {
  it("on a client host: that workspace, with the person's live role", async () => {
    const db = await setupMcp();
    const host = await hostOf(db);
    expect(await connectableWorkspaces(db, env, user(MANAGER, "casey.lin@example.com"), host)).toEqual([{ id: WS, name: "Example Rentals", role: "manager" }]);
    expect(await connectableWorkspaces(db, env, user(STAFF, "riley.oakes@example.com"), host)).toEqual([{ id: WS, name: "Example Rentals", role: "staff" }]);
    expect(await connectableWorkspaces(db, env, user(ADMIN, "avery.stone@example.com"), host)).toEqual([{ id: WS, name: "Example Rentals", role: "manager" }]);
    expect(await connectableWorkspaces(db, env, user("u_nobody", "nobody@example.com"), host)).toEqual([]);
  });

  it("on the hub: a member's workspaces, or every workspace for a platform admin", async () => {
    const db = await setupMcp();
    await seedWorkspace(db, "ws_other");
    await db.update(schema.workspaces).set({ name: "Another Co" }).where(eq(schema.workspaces.id, "ws_other"));
    // The AI switch defaults off (owner decision, Oct 7): a platform admin
    // turned it on for this workspace too.
    await db.update(schema.workspaceSettings).set({ aiTeam: true }).where(eq(schema.workspaceSettings.workspaceId, "ws_other"));
    expect(await connectableWorkspaces(db, env, user(MANAGER, "casey.lin@example.com"), hub)).toEqual([{ id: WS, name: "Example Rentals", role: "manager" }]);
    await seedMember(db, "ws_other", MANAGER, "staff");
    expect((await connectableWorkspaces(db, env, user(MANAGER, "casey.lin@example.com"), hub)).map((entry) => [entry.id, entry.role])).toEqual([
      ["ws_other", "staff"],
      [WS, "manager"],
    ]);
    expect((await connectableWorkspaces(db, env, user(ADMIN, "avery.stone@example.com"), hub)).map((entry) => [entry.name, entry.role])).toEqual([
      ["Another Co", "platform"],
      ["Example Rentals", "platform"],
    ]);
  });

  it("leaves out workspaces whose AI switch is off", async () => {
    const db = await setupMcp();
    await db.update(schema.workspaceSettings).set({ aiTeam: false }).where(eq(schema.workspaceSettings.workspaceId, WS));
    expect(await teamAiOn(db, WS)).toBe(false);
    expect(await connectableWorkspaces(db, env, user(MANAGER, "casey.lin@example.com"), await hostOf(db))).toEqual([]);
    expect(await connectableWorkspaces(db, env, user(ADMIN, "avery.stone@example.com"), hub)).toEqual([]);
  });

  it("leaves out a new workspace until a platform admin turns its AI switch on", async () => {
    const db = await setupMcp();
    await seedWorkspace(db, "ws_new");
    await seedMember(db, "ws_new", MANAGER, "manager");
    expect(await teamAiOn(db, "ws_new")).toBe(false);
    expect((await connectableWorkspaces(db, env, user(MANAGER, "casey.lin@example.com"), hub)).map((entry) => entry.id)).toEqual([WS]);
    expect((await connectableWorkspaces(db, env, user(ADMIN, "avery.stone@example.com"), hub)).map((entry) => entry.id)).toEqual([WS]);
  });

  it("finds the account for an email only when it may connect here", async () => {
    const db = await setupMcp();
    const host = await hostOf(db);
    expect(await connectableUser(db, env, "casey.lin@example.com", host)).toEqual({ id: MANAGER, email: "casey.lin@example.com" });
    expect(await connectableUser(db, env, "stranger@example.com", host)).toBeNull();
    expect(await connectableUser(db, env, "casey.lin@example.com", { kind: "unknown" })).toBeNull();
  });

  // Owner decision 3 (Oct 7): a platform admin on the hub connects once for
  // every workspace with AI on; members, and platform admins on a client
  // host, connect to one workspace.
  it("connects a platform admin on the hub to every workspace, and nobody else", async () => {
    const db = await setupMcp();
    expect(await connectsToEveryWorkspace(db, env, user(ADMIN, "avery.stone@example.com"), hub)).toBe(true);
    expect(await connectsToEveryWorkspace(db, env, user(ADMIN, "avery.stone@example.com"), await hostOf(db))).toBe(false);
    expect(await connectsToEveryWorkspace(db, env, user(MANAGER, "casey.lin@example.com"), hub)).toBe(false);
  });
});
