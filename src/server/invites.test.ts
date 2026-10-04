import { describe, it, expect } from "vitest";
import { asc } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { claimAccessOnSignIn, claimPendingInvites } from "./invites";
import { DEFAULT_ROSTER_TAGS, materializeRoster, resolveRosterTags } from "./roster";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_a");
  await seedWorkspace(db, "ws_b");
  await seedUser(db, "u_new", "new.person@example.com");
  return db;
}

function members(db: Db) {
  return db
    .select({
      workspaceId: schema.workspaceMembers.workspaceId,
      userId: schema.workspaceMembers.userId,
      role: schema.workspaceMembers.role,
      source: schema.workspaceMembers.source,
    })
    .from(schema.workspaceMembers)
    .orderBy(asc(schema.workspaceMembers.workspaceId), asc(schema.workspaceMembers.userId));
}

function invites(db: Db) {
  return db.select().from(schema.pendingInvites).orderBy(asc(schema.pendingInvites.id));
}

// Roster rows a manager approved (the only kind that grants anything);
// approvedRole defaults to the row's role.
async function roster(
  db: Db,
  rows: Array<{
    workspaceId: string;
    email: string;
    role: "manager" | "staff";
    approvedRole?: "manager" | "staff" | null;
    deniedAt?: number | null;
  }>,
) {
  await db.insert(schema.shopifyRoster).values(
    rows.map((row, i) => ({
      id: `r${i}`,
      shopifyCustomerId: `c${i}`,
      updatedAt: 1,
      approvedAt: row.approvedRole === null ? null : 2,
      approvedBy: row.approvedRole === null ? null : "u_approver",
      ...row,
      approvedRole: row.approvedRole === undefined ? row.role : row.approvedRole,
    })),
  );
}

describe("claimPendingInvites", () => {
  it("turns workspace invites into manual memberships with the invited role, and removes them", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values([
      { id: "i1", email: "new.person@example.com", workspaceId: "ws_a", role: "manager", invitedBy: "u_x", createdAt: 1 },
      { id: "i2", email: "new.person@example.com", workspaceId: "ws_b", role: "staff", invitedBy: "u_x", createdAt: 1 },
      { id: "i3", email: "someone.else@example.com", workspaceId: "ws_a", role: "staff", invitedBy: "u_x", createdAt: 1 },
    ]);

    await claimPendingInvites(db, "u_new", "New.Person@Example.com");

    expect(await members(db)).toEqual([
      { workspaceId: "ws_a", userId: "u_new", role: "manager", source: "manual" },
      { workspaceId: "ws_b", userId: "u_new", role: "staff", source: "manual" },
    ]);
    expect((await invites(db)).map((invite) => invite.id)).toEqual(["i3"]);
  });

  it("turns a platform-admin invite into a platform_admins row granted by the inviter", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values({
      id: "pa",
      email: "new.person@example.com",
      platformAdmin: true,
      invitedBy: "u_boss",
      createdAt: 1,
    });

    await claimPendingInvites(db, "u_new");

    const admins = await db.select().from(schema.platformAdmins);
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({ userId: "u_new", grantedBy: "u_boss" });
    expect(await invites(db)).toEqual([]);
    expect(await members(db)).toEqual([]);
  });

  it("keeps an existing membership as it is and still removes the invite", async () => {
    const db = await setup();
    await seedMember(db, "ws_a", "u_new", "staff");
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "new.person@example.com",
      workspaceId: "ws_a",
      role: "manager",
      invitedBy: "u_x",
      createdAt: 1,
    });

    await claimPendingInvites(db, "u_new");

    expect(await members(db)).toEqual([{ workspaceId: "ws_a", userId: "u_new", role: "staff", source: "manual" }]);
    expect(await invites(db)).toEqual([]);
  });

  it("does nothing for an unknown user id", async () => {
    const db = await setup();
    await claimPendingInvites(db, "u_missing");
    expect(await members(db)).toEqual([]);
  });
});

describe("materializeRoster", () => {
  it("grants each roster entry for the email as a shopify membership with its role", async () => {
    const db = await setup();
    await roster(db, [
      { workspaceId: "ws_a", email: "new.person@example.com", role: "manager" },
      { workspaceId: "ws_b", email: "new.person@example.com", role: "staff" },
      { workspaceId: "ws_a", email: "other@example.com", role: "staff" },
    ]);

    await materializeRoster(db, "u_new", "NEW.person@example.com");

    expect(await members(db)).toEqual([
      { workspaceId: "ws_a", userId: "u_new", role: "manager", source: "shopify" },
      { workspaceId: "ws_b", userId: "u_new", role: "staff", source: "shopify" },
    ]);
  });

  it("never changes a manual membership", async () => {
    const db = await setup();
    await seedMember(db, "ws_a", "u_new", "staff", "manual");
    await roster(db, [{ workspaceId: "ws_a", email: "new.person@example.com", role: "manager" }]);

    await materializeRoster(db, "u_new", "new.person@example.com");

    expect(await members(db)).toEqual([{ workspaceId: "ws_a", userId: "u_new", role: "staff", source: "manual" }]);
  });

  it("brings an existing shopify membership's role in line with the roster", async () => {
    const db = await setup();
    await seedMember(db, "ws_a", "u_new", "staff", "shopify");
    await roster(db, [{ workspaceId: "ws_a", email: "new.person@example.com", role: "manager" }]);

    await materializeRoster(db, "u_new", "new.person@example.com");

    expect(await members(db)).toEqual([{ workspaceId: "ws_a", userId: "u_new", role: "manager", source: "shopify" }]);
  });

  // A Shopify tag only asks for access (storefront forms can set tags): an
  // entry nobody approved, or one a manager denied, grants nothing.
  it("grants nothing for an entry waiting for approval or denied", async () => {
    const db = await setup();
    await roster(db, [
      { workspaceId: "ws_a", email: "new.person@example.com", role: "manager", approvedRole: null },
      { workspaceId: "ws_b", email: "new.person@example.com", role: "staff", approvedRole: null, deniedAt: 5 },
    ]);

    expect(await materializeRoster(db, "u_new", "new.person@example.com")).toBe(0);

    expect(await members(db)).toEqual([]);
  });

  it("grants the approved role while a raised role waits for its own approval", async () => {
    const db = await setup();
    await roster(db, [{ workspaceId: "ws_a", email: "new.person@example.com", role: "manager", approvedRole: "staff" }]);

    await materializeRoster(db, "u_new", "new.person@example.com");

    expect(await members(db)).toEqual([{ workspaceId: "ws_a", userId: "u_new", role: "staff", source: "shopify" }]);
  });

  // "/" claims access on every load, so concurrent loads run this side by
  // side: each upsert is conflict safe and a repeat writes nothing.
  it("is idempotent: a repeat run writes nothing and concurrent runs leave one membership", async () => {
    const db = await setup();
    await roster(db, [{ workspaceId: "ws_a", email: "new.person@example.com", role: "staff" }]);

    const counts = await Promise.all(
      Array.from({ length: 5 }, () => materializeRoster(db, "u_new", "new.person@example.com")),
    );

    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(await materializeRoster(db, "u_new", "new.person@example.com")).toBe(0);
    expect(await members(db)).toEqual([{ workspaceId: "ws_a", userId: "u_new", role: "staff", source: "shopify" }]);
  });
});

describe("claimAccessOnSignIn", () => {
  it("claims invites before the roster, so a manual invite wins in the same workspace", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values({
      id: "i1",
      email: "new.person@example.com",
      workspaceId: "ws_a",
      role: "staff",
      invitedBy: "u_x",
      createdAt: 1,
    });
    await roster(db, [
      { workspaceId: "ws_a", email: "new.person@example.com", role: "manager" },
      { workspaceId: "ws_b", email: "new.person@example.com", role: "staff" },
    ]);

    await claimAccessOnSignIn(db, "u_new");

    expect(await members(db)).toEqual([
      { workspaceId: "ws_a", userId: "u_new", role: "staff", source: "manual" },
      { workspaceId: "ws_b", userId: "u_new", role: "staff", source: "shopify" },
    ]);
  });
});

describe("resolveRosterTags", () => {
  it("uses the defaults when nothing is stored", () => {
    expect(DEFAULT_ROSTER_TAGS).toEqual({ manager: "Ordering Desk Manager", staff: "Ordering Desk Staff" });
    expect(resolveRosterTags(null)).toEqual(DEFAULT_ROSTER_TAGS);
    expect(resolveRosterTags(undefined)).toEqual(DEFAULT_ROSTER_TAGS);
  });

  it("uses stored tags, falling back per tag when one is missing or blank", () => {
    expect(resolveRosterTags({ manager: "Desk Lead", staff: "Desk Crew" })).toEqual({
      manager: "Desk Lead",
      staff: "Desk Crew",
    });
    expect(resolveRosterTags({ manager: "  ", staff: "Desk Crew" })).toEqual({
      manager: "Ordering Desk Manager",
      staff: "Desk Crew",
    });
    expect(resolveRosterTags({ staff: 7 })).toEqual(DEFAULT_ROSTER_TAGS);
  });
});
