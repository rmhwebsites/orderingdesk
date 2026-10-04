import { describe, it, expect } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { changeMemberRole, inviteMember, listMembers, removeMember } from "./members";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";

const WS = "ws_impact";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, "ws_other");
  await seedUser(db, "u_lead", "lead@example.com", "Lead Person");
  await seedUser(db, "u_crew", "crew@example.com", "Crew Person");
  await seedUser(db, "u_tagged", "tagged@example.com", "Tagged Person");
  await seedUser(db, "u_free", "free@example.com", "Free Person");
  await seedMember(db, WS, "u_lead", "manager");
  await seedMember(db, WS, "u_crew", "staff");
  await seedMember(db, WS, "u_tagged", "staff", "shopify");
  return db;
}

function membersOf(db: Db, workspaceId = WS) {
  return db
    .select({
      userId: schema.workspaceMembers.userId,
      role: schema.workspaceMembers.role,
      source: schema.workspaceMembers.source,
    })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(schema.workspaceMembers.userId));
}

function invitesOf(db: Db) {
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

describe("listMembers", () => {
  it("lists members with role, source, email and name, and pending invites when asked", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values([
      { id: "i1", email: "soon@example.com", workspaceId: WS, role: "staff", invitedBy: "u_lead", createdAt: 5 },
      { id: "i2", email: "elsewhere@example.com", workspaceId: "ws_other", role: "staff", invitedBy: "u_x", createdAt: 5 },
      { id: "i3", email: "admin.soon@example.com", platformAdmin: true, invitedBy: "u_x", createdAt: 5 },
    ]);

    const withInvites = await listMembers(db, WS, { includeInvites: true });
    expect(withInvites.members).toEqual([
      { userId: "u_crew", role: "staff", source: "manual", email: "crew@example.com", name: "Crew Person" },
      { userId: "u_lead", role: "manager", source: "manual", email: "lead@example.com", name: "Lead Person" },
      { userId: "u_tagged", role: "staff", source: "shopify", email: "tagged@example.com", name: "Tagged Person" },
    ]);
    expect(withInvites.invites).toEqual([{ email: "soon@example.com", role: "staff", createdAt: 5 }]);

    const plain = await listMembers(db, WS, { includeInvites: false });
    expect(plain.members).toHaveLength(3);
    expect(plain.invites).toBeUndefined();
  });
});

describe("inviteMember", () => {
  it("refuses a bad email or a role other than manager or staff", async () => {
    const db = await setup();
    const ctx = { workspaceId: WS, inviterId: "u_lead" };
    for (const body of [
      null,
      { email: "not-an-email", role: "staff" },
      { email: "x@example.com" },
      { email: "x@example.com", role: "admin" },
      { email: "x@example.com", role: "member" },
      { email: "x@example.com", role: "owner" },
      { email: "x@example.com", role: "platform" },
    ]) {
      expect((await inviteMember(db, ctx, body)).kind, JSON.stringify(body)).toBe("invalid");
    }
    expect(await invitesOf(db)).toEqual([]);
  });

  it("adds an existing user straight away as a manual membership", async () => {
    const db = await setup();
    const result = await inviteMember(db, { workspaceId: WS, inviterId: "u_lead" }, {
      email: " FREE@example.com ",
      role: "manager",
    });
    expect(result).toEqual({ kind: "added", email: "free@example.com", workspaceName: "Workspace ws_impact" });
    expect(await membersOf(db)).toContainEqual({ userId: "u_free", role: "manager", source: "manual" });
  });

  it("changes nothing for someone who is already a member", async () => {
    const db = await setup();
    const before = await membersOf(db);
    const result = await inviteMember(db, { workspaceId: WS, inviterId: "u_lead" }, {
      email: "crew@example.com",
      role: "manager",
    });
    expect(result).toEqual({ kind: "already-member" });
    expect(await membersOf(db)).toEqual(before);
  });

  it("stores a pending workspace invite for someone with no account, refreshed on a re-invite", async () => {
    const db = await setup();
    const ctx = { workspaceId: WS, inviterId: "u_lead" };
    expect(await inviteMember(db, ctx, { email: "new@example.com", role: "staff" })).toEqual({
      kind: "invited",
      email: "new@example.com",
      workspaceName: "Workspace ws_impact",
    });
    await inviteMember(db, { workspaceId: WS, inviterId: "u_admin" }, { email: "new@example.com", role: "manager" });
    expect(await invitesOf(db)).toEqual([
      { email: "new@example.com", workspaceId: WS, role: "manager", platformAdmin: false, invitedBy: "u_admin" },
    ]);
  });
});

describe("removeMember", () => {
  const ctx = { workspaceId: WS, actorUserId: "u_lead" };

  it("removes a manually added member", async () => {
    const db = await setup();
    // The removed member's id, so the route can close their open sockets.
    expect(await removeMember(db, ctx, { userId: "u_crew" })).toEqual({ kind: "removed", userId: "u_crew" });
    expect((await membersOf(db)).map((m) => m.userId)).toEqual(["u_lead", "u_tagged"]);
  });

  it("lets a manager remove another manager", async () => {
    const db = await setup();
    await seedMember(db, WS, "u_free", "manager");
    expect(await removeMember(db, ctx, { userId: "u_free" })).toEqual({ kind: "removed", userId: "u_free" });
  });

  it("refuses to remove the person asking", async () => {
    const db = await setup();
    expect(await removeMember(db, ctx, { userId: "u_lead" })).toEqual({
      kind: "invalid",
      error: "You cannot remove yourself",
    });
    expect(await membersOf(db)).toHaveLength(3);
  });

  it("refuses to remove a member whose access comes from a Shopify tag", async () => {
    const db = await setup();
    const result = await removeMember(db, ctx, { userId: "u_tagged" });
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" ? result.error : "").toContain("Shopify");
    expect(await membersOf(db)).toHaveLength(3);
  });

  it("answers an unknown member, or a member of another workspace, as no such member", async () => {
    const db = await setup();
    await seedMember(db, "ws_other", "u_free", "staff");
    for (const userId of ["u_missing", "u_free"]) {
      expect(await removeMember(db, ctx, { userId })).toEqual({ kind: "invalid", error: "No such member" });
    }
    expect(await membersOf(db, "ws_other")).toHaveLength(1);
  });

  it("revokes this workspace's pending invite by email and nothing else", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values([
      { id: "i1", email: "soon@example.com", workspaceId: WS, role: "staff", invitedBy: "u_lead", createdAt: 1 },
      { id: "i2", email: "soon@example.com", workspaceId: "ws_other", role: "staff", invitedBy: "u_x", createdAt: 1 },
      { id: "i3", email: "soon@example.com", platformAdmin: true, invitedBy: "u_x", createdAt: 1 },
    ]);
    expect(await removeMember(db, ctx, { email: " SOON@example.com" })).toEqual({ kind: "removed", userId: null });
    const left = await db
      .select({ id: schema.pendingInvites.id })
      .from(schema.pendingInvites)
      .where(and(eq(schema.pendingInvites.email, "soon@example.com")))
      .orderBy(asc(schema.pendingInvites.id));
    expect(left.map((row) => row.id)).toEqual(["i2", "i3"]);
  });

  it("needs a userId or an email", async () => {
    const db = await setup();
    expect(await removeMember(db, ctx, {})).toEqual({ kind: "invalid", error: "userId or email is required" });
  });
});

describe("changeMemberRole", () => {
  const ctx = { workspaceId: WS, actorUserId: "u_lead" };

  it("changes a manual member's role both ways", async () => {
    const db = await setup();
    expect(await changeMemberRole(db, ctx, { userId: "u_crew", role: "manager" })).toEqual({ kind: "changed" });
    expect((await membersOf(db)).find((m) => m.userId === "u_crew")?.role).toBe("manager");
    expect(await changeMemberRole(db, ctx, { userId: "u_crew", role: "staff" })).toEqual({ kind: "changed" });
    expect((await membersOf(db)).find((m) => m.userId === "u_crew")?.role).toBe("staff");
  });

  it("refuses a role controlled by a Shopify tag, saying where to change it", async () => {
    const db = await setup();
    const result = await changeMemberRole(db, ctx, { userId: "u_tagged", role: "manager" });
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" ? result.error : "").toContain("Shopify");
    expect((await membersOf(db)).find((m) => m.userId === "u_tagged")?.role).toBe("staff");
  });

  it("refuses changing your own role, a bad role, and someone who is not a member here", async () => {
    const db = await setup();
    await seedMember(db, "ws_other", "u_free", "staff");
    expect(await changeMemberRole(db, ctx, { userId: "u_lead", role: "staff" })).toEqual({
      kind: "invalid",
      error: "You cannot change your own role",
    });
    for (const body of [{ userId: "u_crew", role: "owner" }, { userId: "u_crew" }, { role: "staff" }, null]) {
      expect((await changeMemberRole(db, ctx, body)).kind, JSON.stringify(body)).toBe("invalid");
    }
    for (const userId of ["u_missing", "u_free"]) {
      expect(await changeMemberRole(db, ctx, { userId, role: "manager" })).toEqual({ kind: "invalid", error: "No such member" });
    }
    expect((await membersOf(db, "ws_other"))[0].role).toBe("staff");
    expect((await membersOf(db)).map((m) => [m.userId, m.role])).toEqual([
      ["u_crew", "staff"],
      ["u_lead", "manager"],
      ["u_tagged", "staff"],
    ]);
  });
});
