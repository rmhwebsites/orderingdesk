import { describe, it, expect } from "vitest";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";
import { roleViewerFor, workspaceRoleOf } from "./workspace-role";

const WS = "ws_impact";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedUser(db, "u_casey", "casey.lin@example.com", "Casey Lin");
  await seedUser(db, "u_riley", "riley.oakes@example.com", "Riley Oakes");
  await seedUser(db, "u_avery", "avery.stone@example.com", "Avery Stone");
  await seedMember(db, WS, "u_casey", "manager");
  await seedMember(db, WS, "u_riley", "staff");
  return db;
}

describe("workspaceRoleOf", () => {
  it("is the membership role, platform for a platform admin on the hub, manager on a client host, else null", async () => {
    const db = await setup();
    expect(await workspaceRoleOf(db, { userId: "u_casey", platformAdmin: false }, WS)).toBe("manager");
    expect(await workspaceRoleOf(db, { userId: "u_riley", platformAdmin: false }, WS)).toBe("staff");
    expect(await workspaceRoleOf(db, { userId: "u_avery", platformAdmin: false }, WS)).toBeNull();
    expect(await workspaceRoleOf(db, { userId: "u_avery", platformAdmin: true }, WS)).toBe("platform");
    expect(await workspaceRoleOf(db, { userId: "u_avery", platformAdmin: false, platformAdminOnClientHost: true }, WS)).toBe("manager");
    expect(await workspaceRoleOf(db, { userId: "u_avery", platformAdmin: true }, "ws_missing")).toBeNull();
  });
});

describe("roleViewerFor", () => {
  it("reads platform admins from the bootstrap list, like the session guard", async () => {
    const db = await setup();
    const env = { PLATFORM_ADMIN_EMAILS: "Avery.Stone@example.com" };
    expect(await roleViewerFor(db, env, { id: "u_avery", email: "avery.stone@example.com" }, true)).toEqual({
      userId: "u_avery",
      platformAdmin: true,
      platformAdminOnClientHost: false,
    });
    expect(await roleViewerFor(db, env, { id: "u_avery", email: "avery.stone@example.com" }, false)).toEqual({
      userId: "u_avery",
      platformAdmin: false,
      platformAdminOnClientHost: true,
    });
    expect(await roleViewerFor(db, env, { id: "u_casey", email: "casey.lin@example.com" }, true)).toEqual({
      userId: "u_casey",
      platformAdmin: false,
      platformAdminOnClientHost: false,
    });
  });
});
