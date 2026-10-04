import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { loadSettingsPage } from "./settings-page";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "./desk/test-helpers";

const WS = "ws_impact";
const env = { APP_URL: "https://orderingdesk.test", EMAIL_FROM: "Ordering Desk <orders@orderingdesk.test>" } as unknown as CloudflareEnv;

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db
    .update(schema.workspaces)
    .set({ customDomain: "orders.impactrentals.store", customDomainStatus: "pending", rosterTags: { manager: "Lead", staff: "Crew" } })
    .where(eq(schema.workspaces.id, WS));
  await seedUser(db, "u_lead", "lead@example.com", "Lead");
  await seedUser(db, "u_crew", "crew@example.com", "Crew");
  await seedMember(db, WS, "u_lead", "manager");
  await seedMember(db, WS, "u_crew", "staff");
  await db.insert(schema.pendingInvites).values({
    id: "i1",
    email: "soon@example.com",
    workspaceId: WS,
    role: "staff",
    invitedBy: "u_lead",
    createdAt: 5,
  });
  await db.insert(schema.vendors).values({ id: "v1", workspaceId: WS, name: "Hard Hat Supply", email: "orders@hats.example" });
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: "v1.secret-ciphertext",
    status: "ok",
  });
  const [workspace] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, WS));
  return { db, workspace };
}

describe("loadSettingsPage", () => {
  it("reads only the store status and vendors for staff", async () => {
    const { db, workspace } = await setup();
    const page = await loadSettingsPage(db, env, { workspace, role: "staff", userId: "u_crew", basePath: "/w/ws_impact" });
    expect(page.access.sections).toEqual(["store", "vendors"]);
    expect(page.connection?.shopDomain).toBe("impact-rentals.myshopify.com");
    expect(page.vendors.map((vendor) => vendor.name)).toEqual(["Hard Hat Supply"]);
    expect(page.team).toBeNull();
    expect(page.statuses).toBeNull();
    expect(page.notifications).toBeNull();
    expect(page.sender).toBeNull();
    expect(page.domain).toBeNull();
    expect(page.branding).toBeNull();
    expect(JSON.stringify(page)).not.toContain("secret-ciphertext");
  });

  it("adds the team, statuses and notification settings for a manager", async () => {
    const { db, workspace } = await setup();
    const page = await loadSettingsPage(db, env, { workspace, role: "manager", userId: "u_lead", basePath: "/w/ws_impact" });
    expect(page.team?.members.map((member) => member.email)).toEqual(["crew@example.com", "lead@example.com"]);
    expect(page.team?.invites).toEqual([{ email: "soon@example.com", role: "staff", createdAt: 5 }]);
    expect(page.team?.rosterTags).toEqual({ manager: "Lead", staff: "Crew" });
    expect(page.statuses?.map((status) => status.key)).toEqual(["new", "processing", "approved", "shipped"]);
    expect(page.notifications).toEqual({ notificationEmails: [], poPrefix: "PO", replyTo: null, fromName: null });
    expect(page.sender).toBeNull();
    expect(page.domain).toBeNull();
    expect(page.branding).toBeNull();
  });

  it("adds the sender, domain and branding for a platform admin", async () => {
    const { db, workspace } = await setup();
    const page = await loadSettingsPage(db, env, { workspace, role: "platform", userId: "u_boss", basePath: "" });
    expect(page.domain).toEqual({ domain: "orders.impactrentals.store", status: "pending" });
    expect(page.sender).toMatchObject({ override: null, address: null, verified: false });
    expect(page.branding).toEqual({
      accentColor: "#91d500",
      view: { logo: null, symbol: null, colors: null, darkColors: null, fonts: null, radius: null },
    });
    expect(page.workspace).toEqual({ id: WS, name: "Workspace ws_impact", slug: WS, basePath: "" });
    expect(page.viewerUserId).toBe("u_boss");
  });
});
