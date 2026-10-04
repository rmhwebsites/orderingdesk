import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { listPlatformUsers, workspacesWithoutMember } from "./platform-users";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";

const ENV = { PLATFORM_ADMIN_EMAILS: "boss@example.com" };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_beta");
  await db.update(schema.workspaces).set({ name: "Impact Rentals" }).where(sqlId("ws_impact"));
  await db.update(schema.workspaces).set({ name: "Beta Supply" }).where(sqlId("ws_beta"));
  await seedUser(db, "u_boss", "boss@example.com", "Boss");
  await seedUser(db, "u_helper", "helper@example.com", "Helper");
  await seedUser(db, "u_crew", "crew@example.com", "Crew");
  await seedUser(db, "u_none", "none@example.com", "");
  await db.insert(schema.platformAdmins).values({ userId: "u_helper", grantedBy: "u_boss", createdAt: 10 });
  await seedMember(db, "ws_impact", "u_crew", "staff", "shopify");
  await seedMember(db, "ws_beta", "u_crew", "manager");
  await seedMember(db, "ws_impact", "u_boss", "manager");
  return db;
}

function sqlId(id: string) {
  return eq(schema.workspaces.id, id);
}

describe("listPlatformUsers", () => {
  it("lists every user by email with platform admin access and their workspaces by name", async () => {
    const db = await setup();
    const users = await listPlatformUsers(db, ENV);
    expect(users).toEqual([
      {
        userId: "u_boss",
        email: "boss@example.com",
        name: "Boss",
        platformAdmin: true,
        memberships: [{ workspaceId: "ws_impact", workspaceName: "Impact Rentals", slug: "ws_impact", role: "manager", source: "manual" }],
      },
      {
        userId: "u_crew",
        email: "crew@example.com",
        name: "Crew",
        platformAdmin: false,
        memberships: [
          { workspaceId: "ws_beta", workspaceName: "Beta Supply", slug: "ws_beta", role: "manager", source: "manual" },
          { workspaceId: "ws_impact", workspaceName: "Impact Rentals", slug: "ws_impact", role: "staff", source: "shopify" },
        ],
      },
      { userId: "u_helper", email: "helper@example.com", name: "Helper", platformAdmin: true, memberships: [] },
      { userId: "u_none", email: "none@example.com", name: null, platformAdmin: false, memberships: [] },
    ]);
  });
});

describe("workspacesWithoutMember", () => {
  it("names the workspaces a user reaches only as a platform admin", async () => {
    const db = await setup();
    expect(await workspacesWithoutMember(db, "u_boss")).toEqual(["ws_beta"]);
    expect(await workspacesWithoutMember(db, "u_helper")).toEqual(["ws_beta", "ws_impact"]);
    expect(await workspacesWithoutMember(db, "u_crew")).toEqual([]);
  });
});
