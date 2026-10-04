import { describe, it, expect } from "vitest";
import { asc } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { invitePlatformAdmin, listPlatformAdmins, revokePlatformAdmin } from "./platform-admins";
import { openTestDb, seedUser, seedWorkspace } from "./desk/test-helpers";

const ENV = { PLATFORM_ADMIN_EMAILS: "boss@example.com" };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_boss", "boss@example.com", "Boss");
  await seedUser(db, "u_helper", "helper@example.com", "Helper");
  await seedUser(db, "u_client", "client@example.com", "Client");
  await db.insert(schema.platformAdmins).values({ userId: "u_helper", grantedBy: "u_boss", createdAt: 10 });
  return db;
}

function grants(db: Db) {
  return db
    .select({ userId: schema.platformAdmins.userId, grantedBy: schema.platformAdmins.grantedBy })
    .from(schema.platformAdmins)
    .orderBy(asc(schema.platformAdmins.userId));
}

function platformInvites(db: Db) {
  return db
    .select({
      email: schema.pendingInvites.email,
      workspaceId: schema.pendingInvites.workspaceId,
      role: schema.pendingInvites.role,
      platformAdmin: schema.pendingInvites.platformAdmin,
      invitedBy: schema.pendingInvites.invitedBy,
    })
    .from(schema.pendingInvites)
    .orderBy(asc(schema.pendingInvites.email));
}

describe("listPlatformAdmins", () => {
  it("lists bootstrap admins, promoted admins and pending platform-admin invites", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values([
      { id: "pa", email: "next@example.com", platformAdmin: true, invitedBy: "u_boss", createdAt: 20 },
      { id: "ws", email: "crew@example.com", workspaceId: "ws_impact", role: "staff", invitedBy: "u_boss", createdAt: 21 },
    ]);
    expect(await listPlatformAdmins(db, ENV)).toEqual({
      admins: [
        { email: "boss@example.com", userId: "u_boss", name: "Boss", source: "bootstrap", grantedBy: null, createdAt: null },
        { email: "helper@example.com", userId: "u_helper", name: "Helper", source: "granted", grantedBy: "u_boss", createdAt: 10 },
      ],
      invites: [{ email: "next@example.com", invitedBy: "u_boss", createdAt: 20 }],
    });
  });

  it("lists a bootstrap admin who has not signed in yet, once", async () => {
    const { db } = openTestDb();
    const listed = await listPlatformAdmins(db, { PLATFORM_ADMIN_EMAILS: "first@example.com, FIRST@example.com" });
    expect(listed.admins).toEqual([
      { email: "first@example.com", userId: null, name: null, source: "bootstrap", grantedBy: null, createdAt: null },
    ]);
  });
});

describe("invitePlatformAdmin", () => {
  it("promotes an existing user at once", async () => {
    const db = await setup();
    expect(await invitePlatformAdmin(db, ENV, "u_boss", { email: "Client@example.com" })).toEqual({
      kind: "granted",
      email: "client@example.com",
    });
    expect(await grants(db)).toEqual([
      { userId: "u_client", grantedBy: "u_boss" },
      { userId: "u_helper", grantedBy: "u_boss" },
    ]);
  });

  it("stores a platform-admin invite for someone with no account", async () => {
    const db = await setup();
    expect(await invitePlatformAdmin(db, ENV, "u_helper", { email: "next@example.com" })).toEqual({
      kind: "invited",
      email: "next@example.com",
    });
    // A second invite for the same email is a no-op, not an error.
    expect((await invitePlatformAdmin(db, ENV, "u_boss", { email: "next@example.com" })).kind).toBe("invited");
    expect(await platformInvites(db)).toEqual([
      { email: "next@example.com", workspaceId: null, role: null, platformAdmin: true, invitedBy: "u_helper" },
    ]);
  });

  it("says so when the person is already a platform admin", async () => {
    const db = await setup();
    for (const email of ["boss@example.com", "helper@example.com"]) {
      expect(await invitePlatformAdmin(db, ENV, "u_boss", { email })).toEqual({ kind: "already-admin" });
    }
    expect(await grants(db)).toHaveLength(1);
  });

  it("refuses a bad email", async () => {
    const db = await setup();
    for (const body of [null, {}, { email: "nope" }]) {
      expect((await invitePlatformAdmin(db, ENV, "u_boss", body)).kind).toBe("invalid");
    }
  });
});

describe("revokePlatformAdmin", () => {
  it("revokes a promoted admin", async () => {
    const db = await setup();
    // The revoked admin's id, so the route can close their open sockets.
    expect(await revokePlatformAdmin(db, ENV, "u_boss", { userId: "u_helper" })).toEqual({ kind: "revoked", userId: "u_helper" });
    expect(await grants(db)).toEqual([]);
  });

  it("refuses to revoke yourself", async () => {
    const db = await setup();
    expect(await revokePlatformAdmin(db, ENV, "u_helper", { userId: "u_helper" })).toEqual({
      kind: "invalid",
      error: "You cannot remove your own platform admin access",
    });
    expect(await grants(db)).toHaveLength(1);
  });

  it("refuses to revoke a bootstrap admin, whose access comes from the Worker secret", async () => {
    const db = await setup();
    const result = await revokePlatformAdmin(db, ENV, "u_helper", { userId: "u_boss" });
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" ? result.error : "").toContain("PLATFORM_ADMIN_EMAILS");
  });

  it("answers an unknown user as no such platform admin", async () => {
    const db = await setup();
    expect(await revokePlatformAdmin(db, ENV, "u_boss", { userId: "u_client" })).toEqual({
      kind: "invalid",
      error: "No such platform admin",
    });
  });

  it("withdraws a pending platform-admin invite by email, leaving workspace invites alone", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values([
      { id: "pa", email: "next@example.com", platformAdmin: true, invitedBy: "u_boss", createdAt: 1 },
      { id: "ws", email: "next@example.com", workspaceId: "ws_impact", role: "staff", invitedBy: "u_boss", createdAt: 1 },
    ]);
    expect(await revokePlatformAdmin(db, ENV, "u_boss", { email: "NEXT@example.com" })).toEqual({ kind: "revoked", userId: null });
    expect(await platformInvites(db)).toEqual([
      { email: "next@example.com", workspaceId: "ws_impact", role: "staff", platformAdmin: false, invitedBy: "u_boss" },
    ]);
  });

  it("needs a userId or an email", async () => {
    const db = await setup();
    expect(await revokePlatformAdmin(db, ENV, "u_boss", {})).toEqual({
      kind: "invalid",
      error: "userId or email is required",
    });
  });
});
