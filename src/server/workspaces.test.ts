import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { DEFAULT_STATUSES, createWorkspace, listWorkspacesForViewer } from "./workspaces";
import { openTestDb, seedMember, seedWorkspace } from "./desk/test-helpers";

const admin = { userId: "u_admin", email: "admin@example.com", platformAdmin: true };
const client = { userId: "u_client", email: "client@example.com", platformAdmin: false };

describe("listWorkspacesForViewer", () => {
  it("lists every workspace for a platform admin, as platform, by name", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_b");
    await seedWorkspace(db, "ws_a");
    await seedMember(db, "ws_a", "u_admin", "staff");
    expect(await listWorkspacesForViewer(db, admin)).toEqual([
      { id: "ws_a", name: "Workspace ws_a", slug: "ws_a", accentColor: "#91d500", symbol: null, role: "platform" },
      { id: "ws_b", name: "Workspace ws_b", slug: "ws_b", accentColor: "#91d500", symbol: null, role: "platform" },
    ]);
  });

  it("lists only a client's memberships, with their own roles", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_a");
    await seedWorkspace(db, "ws_b");
    await seedWorkspace(db, "ws_c");
    await seedMember(db, "ws_c", "u_client", "staff");
    await seedMember(db, "ws_a", "u_client", "manager");
    await seedMember(db, "ws_b", "u_someone", "manager");
    expect(await listWorkspacesForViewer(db, client)).toEqual([
      { id: "ws_a", name: "Workspace ws_a", slug: "ws_a", accentColor: "#91d500", symbol: null, role: "manager" },
      { id: "ws_c", name: "Workspace ws_c", slug: "ws_c", accentColor: "#91d500", symbol: null, role: "staff" },
    ]);
  });

  it("carries each workspace's uploaded symbol, with its dark version, as served paths", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_a");
    await seedWorkspace(db, "ws_b");
    const asset = (key: string) => ({ key, contentType: "image/png" as const, pngKey: null });
    await db
      .update(schema.workspaces)
      .set({
        branding: {
          symbol: { light: asset("branding/ws_a/symbol-light-1.png"), dark: asset("branding/ws_a/symbol-dark-2.png") },
        },
      })
      .where(eq(schema.workspaces.id, "ws_a"));
    await db
      .update(schema.workspaces)
      .set({ branding: { symbol: { light: asset("branding/ws_b/symbol-light-3.png"), dark: null } } })
      .where(eq(schema.workspaces.id, "ws_b"));
    await seedMember(db, "ws_a", "u_client", "staff");
    const symbols = (list: { symbol: unknown }[]) => list.map((workspace) => workspace.symbol);
    expect(symbols(await listWorkspacesForViewer(db, admin))).toEqual([
      { light: "/api/branding/ws_a/symbol-light-1.png", dark: "/api/branding/ws_a/symbol-dark-2.png" },
      { light: "/api/branding/ws_b/symbol-light-3.png", dark: null },
    ]);
    expect(symbols(await listWorkspacesForViewer(db, client))).toEqual([
      { light: "/api/branding/ws_a/symbol-light-1.png", dark: "/api/branding/ws_a/symbol-dark-2.png" },
    ]);
  });

  it("is empty for a client with no membership", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, "ws_a");
    expect(await listWorkspacesForViewer(db, client)).toEqual([]);
  });
});

describe("createWorkspace", () => {
  it("creates the workspace with its settings and the default statuses, and no membership", async () => {
    const { db } = openTestDb();
    const result = await createWorkspace(db, "u_admin", { name: "  IMPACT Rentals  " });
    expect(result).toMatchObject({
      kind: "created",
      workspace: { name: "IMPACT Rentals", slug: "impact-rentals", role: "platform" },
    });
    if (result.kind !== "created") {
      return;
    }
    const id = result.workspace.id;
    const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    expect(row).toMatchObject({ name: "IMPACT Rentals", slug: "impact-rentals", createdBy: "u_admin" });
    expect(await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.workspaceId, id))).toHaveLength(1);
    // A platform admin reaches every workspace without a membership.
    expect(await db.select().from(schema.workspaceMembers)).toEqual([]);

    const statuses = await db
      .select({
        key: schema.statuses.key,
        label: schema.statuses.label,
        sort: schema.statuses.sort,
        triggersPo: schema.statuses.triggersPo,
        shopifyLink: schema.statuses.shopifyLink,
      })
      .from(schema.statuses)
      .where(eq(schema.statuses.workspaceId, id))
      .orderBy(asc(schema.statuses.sort));
    expect(statuses.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
    expect(statuses.find((s) => s.key === "shipped")?.shopifyLink).toBe("fulfilled");
    expect(statuses.find((s) => s.key === "delivered")?.shopifyLink).toBe("delivered");
    // Draft orders (spec section 2.3): Approve uses Approved, Reject uses a
    // pink Rejected status at the end.
    expect(statuses.find((s) => s.key === "approved")?.shopifyLink).toBe("draft_completed");
    expect(statuses[statuses.length - 1]).toEqual({
      key: "rejected",
      label: "Rejected",
      sort: statuses.length - 1,
      triggersPo: false,
      shopifyLink: "draft_rejected",
    });
    expect(statuses.filter((s) => s.shopifyLink !== null)).toHaveLength(4);
    expect(statuses.find((s) => s.key === "approved")?.triggersPo).toBe(true);
  });

  it("picks the next free slug", async () => {
    const { db } = openTestDb();
    await createWorkspace(db, "u_admin", { name: "Impact" });
    const second = await createWorkspace(db, "u_admin", { name: "IMPACT!" });
    expect(second).toMatchObject({ kind: "created", workspace: { slug: "impact-2" } });
  });

  it("starts every new workspace with Delivered and Rejected closed", async () => {
    const { db } = openTestDb();
    const result = await createWorkspace(db, "user_admin", { name: "Closed Check" });
    if (result.kind !== "created") throw new Error(result.kind);
    const rows = await db
      .select({ key: schema.statuses.key, closed: schema.statuses.closed })
      .from(schema.statuses)
      .where(eq(schema.statuses.workspaceId, result.workspace.id));
    expect(rows.filter((row) => row.closed).map((row) => row.key).sort()).toEqual(["delivered", "rejected"]);
  });

  it("refuses a missing, blank or overlong name", async () => {
    const { db } = openTestDb();
    for (const body of [null, {}, { name: "   " }, { name: 7 }, { name: "x".repeat(81) }]) {
      expect((await createWorkspace(db, "u_admin", body)).kind, JSON.stringify(body)).toBe("invalid");
    }
    expect(await db.select().from(schema.workspaces)).toEqual([]);
  });
});
