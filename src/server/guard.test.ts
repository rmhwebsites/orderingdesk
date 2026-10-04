import { describe, it, expect } from "vitest";
import {
  AuthError,
  assertPlatformAdmin,
  resolveOrderAccess,
  resolveWorkspaceRole,
  roleAtLeast,
  type Viewer,
} from "./guard";
import { openTestDb, seedMember, seedOrder, seedWorkspace } from "./desk/test-helpers";

const staff: Viewer = { userId: "user_staff", email: "staff@example.com", platformAdmin: false };
const manager: Viewer = { userId: "user_manager", email: "manager@example.com", platformAdmin: false };
const outsider: Viewer = { userId: "user_outsider", email: "outsider@example.com", platformAdmin: false };
const admin: Viewer = { userId: "user_admin", email: "admin@example.com", platformAdmin: true };
// A platform admin who is also a staff member of ws_impact.
const adminMember: Viewer = { userId: "user_staff_admin", email: "both@example.com", platformAdmin: true };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_other");
  await seedMember(db, "ws_impact", "user_staff", "staff");
  await seedMember(db, "ws_impact", "user_manager", "manager");
  await seedMember(db, "ws_other", "user_outsider", "manager");
  await seedMember(db, "ws_impact", "user_staff_admin", "staff");
  await seedOrder(db, "ws_impact", { id: "o1" });
  return db;
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

function expectNotFound(failure: unknown) {
  expect(failure).toBeInstanceOf(AuthError);
  expect((failure as AuthError).status).toBe(404);
  expect((failure as AuthError).message).toBe("Not found");
}

describe("roleAtLeast", () => {
  it("ranks staff below manager below platform", () => {
    expect(roleAtLeast("staff", "staff")).toBe(true);
    expect(roleAtLeast("staff", "manager")).toBe(false);
    expect(roleAtLeast("manager", "staff")).toBe(true);
    expect(roleAtLeast("manager", "manager")).toBe(true);
    expect(roleAtLeast("manager", "platform")).toBe(false);
    expect(roleAtLeast("platform", "manager")).toBe(true);
    expect(roleAtLeast("platform", "platform")).toBe(true);
  });
});

describe("assertPlatformAdmin", () => {
  it("lets a platform admin through and answers everyone else with 404", () => {
    expect(() => assertPlatformAdmin(admin)).not.toThrow();
    for (const viewer of [staff, manager, outsider]) {
      let failure: unknown;
      try {
        assertPlatformAdmin(viewer);
      } catch (e) {
        failure = e;
      }
      expectNotFound(failure);
    }
  });
});

describe("resolveWorkspaceRole", () => {
  it("returns a member's own role when it is high enough", async () => {
    const db = await setup();
    expect(await resolveWorkspaceRole(db, staff, "ws_impact", "staff")).toBe("staff");
    expect(await resolveWorkspaceRole(db, manager, "ws_impact", "staff")).toBe("manager");
    expect(await resolveWorkspaceRole(db, manager, "ws_impact", "manager")).toBe("manager");
  });

  it("answers a missing workspace, a non-member and an under-ranked member with the same 404", async () => {
    const db = await setup();
    const failures = [
      await failureOf(resolveWorkspaceRole(db, staff, "ws_missing", "staff")),
      await failureOf(resolveWorkspaceRole(db, outsider, "ws_impact", "staff")),
      await failureOf(resolveWorkspaceRole(db, staff, "ws_impact", "manager")),
      await failureOf(resolveWorkspaceRole(db, manager, "ws_impact", "platform")),
    ];
    failures.forEach(expectNotFound);
  });

  it("lets a platform admin into any workspace as platform, above every required role", async () => {
    const db = await setup();
    for (const required of ["staff", "manager", "platform"] as const) {
      expect(await resolveWorkspaceRole(db, admin, "ws_impact", required)).toBe("platform");
      expect(await resolveWorkspaceRole(db, admin, "ws_other", required)).toBe("platform");
    }
    // A membership does not lower a platform admin's role.
    expect(await resolveWorkspaceRole(db, adminMember, "ws_impact", "manager")).toBe("platform");
  });

  it("still answers 404 to a platform admin for a workspace that does not exist", async () => {
    const db = await setup();
    expectNotFound(await failureOf(resolveWorkspaceRole(db, admin, "ws_missing", "staff")));
  });

  // On a client host requireSession sets platformAdmin false and
  // platformAdminOnClientHost true: the host's workspace (the only one the
  // host allows) as a manager, never as platform.
  it("lets a platform admin on a client host in as a manager only", async () => {
    const db = await setup();
    const offHub: Viewer = { ...admin, platformAdmin: false, platformAdminOnClientHost: true };
    const offHubMember: Viewer = { ...adminMember, platformAdmin: false, platformAdminOnClientHost: true };
    expect(await resolveWorkspaceRole(db, offHub, "ws_impact", "staff")).toBe("manager");
    expect(await resolveWorkspaceRole(db, offHub, "ws_impact", "manager")).toBe("manager");
    // A staff membership is raised to manager, like a non-member admin.
    expect(await resolveWorkspaceRole(db, offHubMember, "ws_impact", "manager")).toBe("manager");
    expectNotFound(await failureOf(resolveWorkspaceRole(db, offHub, "ws_impact", "platform")));
    expectNotFound(await failureOf(resolveWorkspaceRole(db, offHub, "ws_missing", "staff")));
  });
});

// The db-taking core of requireMemberByOrder (which adds only the session).
describe("resolveOrderAccess", () => {
  it("answers a missing order, a non-member and an under-ranked member with the same 404", async () => {
    const db = await setup();
    const failures = [
      await failureOf(resolveOrderAccess(db, "missing", staff, "staff")),
      await failureOf(resolveOrderAccess(db, "o1", outsider, "staff")),
      await failureOf(resolveOrderAccess(db, "o1", staff, "manager")),
      await failureOf(resolveOrderAccess(db, "missing", admin, "staff")),
    ];
    failures.forEach(expectNotFound);
  });

  it("returns the caller's role and the order's workspace", async () => {
    const db = await setup();
    expect(await resolveOrderAccess(db, "o1", staff, "staff")).toEqual({ role: "staff", workspaceId: "ws_impact" });
    expect(await resolveOrderAccess(db, "o1", manager, "manager")).toEqual({
      role: "manager",
      workspaceId: "ws_impact",
    });
    expect(await resolveOrderAccess(db, "o1", admin, "manager")).toEqual({
      role: "platform",
      workspaceId: "ws_impact",
    });
  });
});
