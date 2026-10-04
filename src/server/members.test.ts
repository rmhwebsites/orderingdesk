import { describe, it, expect } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import {
  INVITE_SEND_LIMIT,
  INVITE_SEND_WINDOW_MS,
  changeMemberRole,
  inviteMember,
  listMembers,
  removeMember,
} from "./members";
import { openTestDb, seedMember, seedRosterEntry, seedUser, seedWorkspace } from "./desk/test-helpers";
import { claimAccessOnSignIn } from "./invites";

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

async function rosterRow(db: Db, id: string) {
  const rows = await db
    .select({
      approvedRole: schema.shopifyRoster.approvedRole,
      approvedAt: schema.shopifyRoster.approvedAt,
      approvedBy: schema.shopifyRoster.approvedBy,
      deniedAt: schema.shopifyRoster.deniedAt,
    })
    .from(schema.shopifyRoster)
    .where(eq(schema.shopifyRoster.id, id));
  return rows[0];
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

  it("lists this workspace's Shopify tag requests that wait for approval and those denied, when asked", async () => {
    const db = await setup();
    await seedRosterEntry(db, { id: "r_asks", workspaceId: WS, email: "asks@example.com", role: "manager" });
    await seedRosterEntry(db, { id: "r_ok", workspaceId: WS, email: "ok@example.com", role: "staff", state: "approved" });
    await seedRosterEntry(db, { id: "r_no", workspaceId: WS, email: "no@example.com", role: "staff", state: "denied" });
    await seedRosterEntry(db, { workspaceId: "ws_other", email: "elsewhere@example.com", role: "staff" });
    // Approved as staff, now tagged manager: the raise waits.
    await seedRosterEntry(db, { id: "r_raise", workspaceId: WS, email: "raise@example.com", role: "staff", state: "approved" });
    await db
      .update(schema.shopifyRoster)
      .set({ role: "manager", updatedAt: 4 })
      .where(eq(schema.shopifyRoster.id, "r_raise"));

    const view = await listMembers(db, WS, { includeInvites: true });
    expect(view.requests).toEqual({
      waiting: [
        { id: "r_asks", email: "asks@example.com", role: "manager", currentRole: null, since: 1, deniedAt: null },
        { id: "r_raise", email: "raise@example.com", role: "manager", currentRole: "staff", since: 4, deniedAt: null },
      ],
      denied: [{ id: "r_no", email: "no@example.com", role: "staff", currentRole: null, since: 1, deniedAt: 3 }],
      // Approved, and nobody with the email belongs here yet.
      approved: [{ id: "r_ok", email: "ok@example.com", role: "staff", currentRole: "staff", since: 2, deniedAt: null }],
    });
    expect((await listMembers(db, WS, { includeInvites: false })).requests).toBeUndefined();
  });

  // Approving adds nobody (src/server/roster.ts): until the person signs in
  // or opens "/", the request is listed as approved, the same whether or
  // not the email has an account, and no name comes with it.
  it("lists approved requests nobody has claimed yet, the same with or without an account", async () => {
    const db = await setup();
    await seedRosterEntry(db, { id: "r_free", workspaceId: WS, email: "free@example.com", role: "manager", state: "approved" });
    await seedRosterEntry(db, { id: "r_ghost", workspaceId: WS, email: "ghost@example.com", role: "manager", state: "approved" });
    // Claimed: the membership is listed instead.
    await seedRosterEntry(db, { id: "r_tagged", workspaceId: WS, email: "tagged@example.com", role: "staff", state: "approved" });
    const view = await listMembers(db, WS, { includeInvites: true });
    expect(view.members.map((member) => member.userId)).toEqual(["u_crew", "u_lead", "u_tagged"]);
    expect(view.requests?.approved).toEqual([
      { id: "r_free", email: "free@example.com", role: "manager", currentRole: "manager", since: 2, deniedAt: null },
      { id: "r_ghost", email: "ghost@example.com", role: "manager", currentRole: "manager", since: 2, deniedAt: null },
    ]);
    expect(JSON.stringify(view)).not.toContain("Free Person");
  });

  // A manual membership always wins over a tag, so an approved tag request
  // for the same email changes nothing visible. Managers see it next to the
  // member, since removing the member denies it (see removeMember).
  it("shows managers the approved tag request a manual member also has, and staff nothing of it", async () => {
    const db = await setup();
    await seedRosterEntry(db, { id: "r_crew", workspaceId: WS, email: "crew@example.com", role: "manager", state: "approved" });
    await seedRosterEntry(db, { id: "r_lead", workspaceId: WS, email: "lead@example.com", role: "staff" });
    const view = await listMembers(db, WS, { includeInvites: true });
    expect(view.members).toEqual([
      { userId: "u_crew", role: "staff", source: "manual", email: "crew@example.com", name: "Crew Person", tagRole: "manager" },
      { userId: "u_lead", role: "manager", source: "manual", email: "lead@example.com", name: "Lead Person" },
      { userId: "u_tagged", role: "staff", source: "shopify", email: "tagged@example.com", name: "Tagged Person" },
    ]);
    // Theirs already, so not an approved request waiting for a sign-in.
    expect(view.requests?.approved).toEqual([]);
    const plain = await listMembers(db, WS, { includeInvites: false });
    expect(plain.members.find((member) => member.userId === "u_crew")).not.toHaveProperty("tagRole");
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

  // An existing account is never added directly: that would tell any
  // manager which emails have an account anywhere on the platform (and
  // their name), and add the person without them doing anything. Everyone
  // gets the same pending invite, claimed when they next sign in or open
  // the app.
  it("treats an existing user exactly like a new email: a pending invite, no membership, the same answer", async () => {
    const db = await setup();
    const ctx = { workspaceId: WS, inviterId: "u_lead" };
    const before = await membersOf(db);
    const existing = await inviteMember(db, ctx, { email: " FREE@example.com ", role: "manager" });
    const unknown = await inviteMember(db, ctx, { email: "nobody@example.com", role: "manager" });
    expect(existing).toEqual({ kind: "invited", email: "free@example.com", workspaceName: "Workspace ws_impact" });
    expect(unknown).toEqual({ kind: "invited", email: "nobody@example.com", workspaceName: "Workspace ws_impact" });
    expect(await membersOf(db)).toEqual(before);
    expect(await invitesOf(db)).toEqual([
      { email: "free@example.com", workspaceId: WS, role: "manager", platformAdmin: false, invitedBy: "u_lead" },
      { email: "nobody@example.com", workspaceId: WS, role: "manager", platformAdmin: false, invitedBy: "u_lead" },
    ]);
  });

  it("limits how many invite emails a workspace sends in an hour, withdrawn ones included", async () => {
    const db = await setup();
    const ctx = { workspaceId: WS, inviterId: "u_lead" };
    const start = 1_000_000;
    for (let i = 0; i < INVITE_SEND_LIMIT; i++) {
      const result = await inviteMember(db, ctx, { email: `person${i}@example.com`, role: "staff" }, { now: start + i });
      expect(result.kind).toBe("invited");
    }
    // Withdrawing an invite does not give its send back.
    await removeMember(db, { workspaceId: WS, actorUserId: "u_lead" }, { email: "person0@example.com" });
    const limited = await inviteMember(db, ctx, { email: "person0@example.com", role: "staff" }, { now: start + 100 });
    expect(limited).toEqual({ kind: "limited", error: expect.stringContaining("Try again") });
    expect((await invitesOf(db)).map((row) => row.email)).not.toContain("person0@example.com");
    // Someone already here is answered without a send, limit or not.
    expect(await inviteMember(db, ctx, { email: "crew@example.com", role: "staff" }, { now: start + 100 })).toEqual({
      kind: "already-member",
    });
    // Another workspace has its own allowance.
    const other = await inviteMember(db, { workspaceId: "ws_other", inviterId: "u_x" }, { email: "a@example.com", role: "staff" }, { now: start + 100 });
    expect(other.kind).toBe("invited");
    // An hour after the first sends, there is room again.
    const later = await inviteMember(db, ctx, { email: "person0@example.com", role: "staff" }, { now: start + INVITE_SEND_WINDOW_MS + 1 });
    expect(later.kind).toBe("invited");
    expect(INVITE_SEND_LIMIT).toBe(30);
    expect(INVITE_SEND_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  // Two managers (or one fast script) inviting at once must not get past
  // the limit: each send is reserved in one statement that counts and
  // inserts together.
  it("lets exactly the hourly allowance through when many invites arrive at once", async () => {
    const db = await setup();
    const ctx = { workspaceId: WS, inviterId: "u_lead" };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        inviteMember(db, ctx, { email: `rush${i}@example.com`, role: "staff" }, { now: 2_000_000 + i }),
      ),
    );
    expect(results.filter((result) => result.kind === "invited")).toHaveLength(INVITE_SEND_LIMIT);
    expect(results.filter((result) => result.kind === "limited")).toHaveLength(50 - INVITE_SEND_LIMIT);
    expect(await db.select().from(schema.inviteSends)).toHaveLength(INVITE_SEND_LIMIT);
    expect(await invitesOf(db)).toHaveLength(INVITE_SEND_LIMIT);
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

  // The probe: a manual staff member whose email also carries an approved
  // manager tag. Removing them used to leave the approval in place, so the
  // next "/" load brought them back through the tag, as a manager, and as a
  // Shopify member that Remove refuses. Removal denies that request in the
  // same step, a raise waiting for approval included.
  it("denies the removed member's approved tag request here too, so they do not come back", async () => {
    for (const state of ["approved", "raise"] as const) {
      const db = await setup();
      await seedRosterEntry(db, {
        id: "r_crew",
        workspaceId: WS,
        email: "crew@example.com",
        role: state === "raise" ? "staff" : "manager",
        state: "approved",
      });
      if (state === "raise") {
        await db.update(schema.shopifyRoster).set({ role: "manager" }).where(eq(schema.shopifyRoster.id, "r_crew"));
      }
      await seedRosterEntry(db, { id: "r_crew_other", workspaceId: "ws_other", email: "crew@example.com", role: "staff", state: "approved" });

      expect(await removeMember(db, ctx, { userId: "u_crew" }, { now: 77 }), state).toEqual({ kind: "removed", userId: "u_crew" });
      expect(await rosterRow(db, "r_crew"), state).toEqual({ approvedRole: null, approvedAt: null, approvedBy: null, deniedAt: 77 });
      // Another workspace's approval is that workspace's business.
      expect(await rosterRow(db, "r_crew_other"), state).toMatchObject({ approvedRole: "staff", deniedAt: null });

      await claimAccessOnSignIn(db, "u_crew", "crew@example.com");
      expect((await membersOf(db)).map((member) => member.userId), state).toEqual(["u_lead", "u_tagged"]);
      expect(await membersOf(db, "ws_other"), state).toEqual([{ userId: "u_crew", role: "staff", source: "shopify" }]);
      // Listed as denied, where a manager can approve it again on purpose.
      expect((await listMembers(db, WS, { includeInvites: true })).requests?.denied.map((entry) => entry.id), state).toEqual([
        "r_crew",
      ]);
    }
  });

  it("leaves a tag request nobody approved as it is when removing a member: it grants nothing", async () => {
    const db = await setup();
    await seedRosterEntry(db, { id: "r_crew", workspaceId: WS, email: "crew@example.com", role: "manager" });
    expect(await removeMember(db, ctx, { userId: "u_crew" }, { now: 77 })).toEqual({ kind: "removed", userId: "u_crew" });
    expect(await rosterRow(db, "r_crew")).toEqual({ approvedRole: null, approvedAt: null, approvedBy: null, deniedAt: null });
    await claimAccessOnSignIn(db, "u_crew", "crew@example.com");
    expect((await membersOf(db)).map((member) => member.userId)).toEqual(["u_lead", "u_tagged"]);
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
