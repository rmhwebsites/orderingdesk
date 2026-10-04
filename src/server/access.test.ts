import { describe, it, expect } from "vitest";
import * as schema from "@/db/schema";
import type { Db } from "@/db";
import {
  canCreateAccount,
  hasAccountRoute,
  isPlatformAdmin,
  platformAdminEmails,
} from "./access";
import { openTestDb, seedRosterEntry, seedUser, seedWorkspace } from "./desk/test-helpers";

const ENV = { PLATFORM_ADMIN_EMAILS: " Boss@Example.com ,second@example.com,, " };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  return db;
}

// Counts the queries a call makes, so a test can pin "answered without a
// database read".
function countingDb(db: Db): { db: Db; reads: () => number } {
  let count = 0;
  const proxy = new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "select") {
        return (...args: unknown[]) => {
          count++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Db;
  return { db: proxy, reads: () => count };
}

describe("platformAdminEmails", () => {
  it("splits on commas, trims, lowercases and drops blanks", () => {
    expect([...platformAdminEmails(ENV)]).toEqual(["boss@example.com", "second@example.com"]);
  });

  it("is empty when the secret is missing or blank", () => {
    expect(platformAdminEmails({}).size).toBe(0);
    expect(platformAdminEmails({ PLATFORM_ADMIN_EMAILS: "  ,  " }).size).toBe(0);
  });
});

describe("isPlatformAdmin", () => {
  it("accepts an email on the bootstrap list, in any case, without a database read", async () => {
    const counted = countingDb(await setup());
    expect(await isPlatformAdmin(counted.db, ENV, "u_boss", "BOSS@example.COM")).toBe(true);
    expect(counted.reads()).toBe(0);
  });

  it("accepts a user promoted in the app", async () => {
    const db = await setup();
    await seedUser(db, "u_promoted", "promoted@example.com");
    await db.insert(schema.platformAdmins).values({ userId: "u_promoted", grantedBy: "u_boss", createdAt: 1 });
    expect(await isPlatformAdmin(db, ENV, "u_promoted", "promoted@example.com")).toBe(true);
  });

  it("refuses everyone else, managers included", async () => {
    const db = await setup();
    await seedUser(db, "u_manager", "manager@example.com");
    await db
      .insert(schema.workspaceMembers)
      .values({ id: "m1", workspaceId: "ws_impact", userId: "u_manager", role: "manager" });
    expect(await isPlatformAdmin(db, ENV, "u_manager", "manager@example.com")).toBe(false);
    expect(await isPlatformAdmin(db, {}, "u_manager", "manager@example.com")).toBe(false);
  });
});

describe("canCreateAccount", () => {
  it("allows a bootstrap platform admin", async () => {
    expect(await canCreateAccount(await setup(), ENV, "second@example.com")).toBe(true);
  });

  it("allows an email with a pending workspace invite or platform-admin invite", async () => {
    const db = await setup();
    await db.insert(schema.pendingInvites).values([
      { id: "i1", email: "crew@example.com", workspaceId: "ws_impact", role: "staff", invitedBy: "u", createdAt: 1 },
      { id: "i2", email: "admin2@example.com", platformAdmin: true, invitedBy: "u", createdAt: 1 },
    ]);
    expect(await canCreateAccount(db, {}, "Crew@Example.com")).toBe(true);
    expect(await canCreateAccount(db, {}, "admin2@example.com")).toBe(true);
  });

  it("allows a tagged Shopify customer once a manager approved the roster entry", async () => {
    const db = await setup();
    await seedRosterEntry(db, { workspaceId: "ws_impact", email: "buyer@example.com", role: "staff", state: "approved" });
    expect(await canCreateAccount(db, {}, " buyer@example.com ")).toBe(true);
  });

  // Any storefront visitor can create a customer with tags (the newsletter
  // form's contact[tags]), so a tag alone is never an access grant.
  it("refuses a roster entry that is waiting for approval or was denied", async () => {
    const db = await setup();
    await seedRosterEntry(db, { workspaceId: "ws_impact", email: "stranger@example.com", role: "manager" });
    await seedRosterEntry(db, { workspaceId: "ws_impact", email: "denied@example.com", role: "staff", state: "denied" });
    expect(await canCreateAccount(db, {}, "stranger@example.com")).toBe(false);
    expect(await canCreateAccount(db, {}, "denied@example.com")).toBe(false);
    expect(await hasAccountRoute(db, {}, "stranger@example.com")).toBe(false);
    expect(await hasAccountRoute(db, {}, "denied@example.com")).toBe(false);
  });

  it("refuses anyone with no route to an account", async () => {
    const db = await setup();
    expect(await canCreateAccount(db, ENV, "stranger@example.com")).toBe(false);
    expect(await canCreateAccount(db, ENV, "")).toBe(false);
  });
});

describe("hasAccountRoute", () => {
  it("always lets an existing user sign in", async () => {
    const db = await setup();
    await seedUser(db, "u_old", "old@example.com");
    expect(await hasAccountRoute(db, {}, "OLD@example.com")).toBe(true);
  });

  it("follows canCreateAccount for an email with no account", async () => {
    const db = await setup();
    expect(await hasAccountRoute(db, ENV, "boss@example.com")).toBe(true);
    expect(await hasAccountRoute(db, ENV, "stranger@example.com")).toBe(false);
  });
});
