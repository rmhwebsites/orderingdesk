import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { ADMIN, GRANT, HOST, HUB, MANAGER, NOW, STAFF, WS, seedGrant, setupMcp, testEnv } from "./test-helpers";
import { grantPropsOf, resolvePrincipal } from "./principal";

const env = testEnv();
const props = (overrides: Record<string, unknown> = {}) => ({ v: 1, kind: "member", grantId: GRANT, workspaceId: WS, userId: MANAGER, ...overrides });

describe("resolvePrincipal", () => {
  it("acts for the person behind an active connection on its own host, with their live role and limits", async () => {
    const db = await setupMcp();
    await seedGrant(db);
    expect(await resolvePrincipal(db, env, { props: props(), hostname: HOST }, NOW)).toEqual({
      workspaceId: WS,
      workspaceName: "Example Rentals",
      userId: MANAGER,
      personName: "Casey Lin",
      role: "manager",
      grantId: GRANT,
      client: "claude",
      scopes: ["desk.read", "desk.write", "offline_access"],
      host: HOST,
      limits: { reads: 1000, changes: 100 },
      grantExpiresAt: NOW + 86400000,
    });
    const touched = await db.select().from(schema.aiGrants).where(eq(schema.aiGrants.id, GRANT));
    expect(touched[0].lastUsedAt).toBe(NOW);
  });

  it("gives staff the staff limit and re-reads the role on every call", async () => {
    const db = await setupMcp();
    await seedGrant(db, { id: "g_riley", userId: STAFF });
    const staff = await resolvePrincipal(db, env, { props: props({ grantId: "g_riley", userId: STAFF }), hostname: HOST }, NOW);
    expect(staff).toMatchObject({ role: "staff", limits: { reads: 1000, changes: 50 } });
    await db
      .update(schema.workspaceMembers)
      .set({ role: "manager" })
      .where(and(eq(schema.workspaceMembers.workspaceId, WS), eq(schema.workspaceMembers.userId, STAFF)));
    expect(await resolvePrincipal(db, env, { props: props({ grantId: "g_riley", userId: STAFF }), hostname: HOST }, NOW + 1)).toMatchObject({ role: "manager" });
  });

  it("refuses a revoked, expired, foreign or malformed connection", async () => {
    const db = await setupMcp();
    await seedGrant(db, { id: "g_revoked", revokedAt: NOW - 1 });
    await seedGrant(db, { id: "g_expired", expiresAt: NOW });
    await seedGrant(db);
    expect(await resolvePrincipal(db, env, { props: props({ grantId: "g_revoked" }), hostname: HOST }, NOW)).toBeNull();
    expect(await resolvePrincipal(db, env, { props: props({ grantId: "g_expired" }), hostname: HOST }, NOW)).toBeNull();
    expect(await resolvePrincipal(db, env, { props: props({ userId: STAFF }), hostname: HOST }, NOW)).toBeNull();
    expect(await resolvePrincipal(db, env, { props: props({ workspaceId: "ws_other" }), hostname: HOST }, NOW)).toBeNull();
    expect(await resolvePrincipal(db, env, { props: props(), hostname: HUB }, NOW)).toBeNull();
    expect(await resolvePrincipal(db, env, { props: { grantId: GRANT }, hostname: HOST }, NOW)).toBeNull();
    expect(await resolvePrincipal(db, env, { props: null, hostname: HOST }, NOW)).toBeNull();
  });

  it("refuses once the person left, the AI switch is off, or the client host is no longer active", async () => {
    const db = await setupMcp();
    await seedGrant(db);
    await db.update(schema.workspaceSettings).set({ aiTeam: false }).where(eq(schema.workspaceSettings.workspaceId, WS));
    expect(await resolvePrincipal(db, env, { props: props(), hostname: HOST }, NOW)).toBeNull();
    await db.update(schema.workspaceSettings).set({ aiTeam: true }).where(eq(schema.workspaceSettings.workspaceId, WS));
    await db.update(schema.workspaces).set({ customDomainStatus: "pending" }).where(eq(schema.workspaces.id, WS));
    expect(await resolvePrincipal(db, env, { props: props(), hostname: HOST }, NOW)).toBeNull();
    await db.update(schema.workspaces).set({ customDomainStatus: "active" }).where(eq(schema.workspaces.id, WS));
    await db.delete(schema.workspaceMembers).where(and(eq(schema.workspaceMembers.workspaceId, WS), eq(schema.workspaceMembers.userId, MANAGER)));
    expect(await resolvePrincipal(db, env, { props: props(), hostname: HOST }, NOW)).toBeNull();
  });

  it("treats a platform admin as platform on the hub and as manager on the client host", async () => {
    const db = await setupMcp();
    await seedGrant(db, { id: "g_hub", userId: ADMIN, host: HUB });
    await seedGrant(db, { id: "g_host", userId: ADMIN, host: HOST });
    expect(await resolvePrincipal(db, env, { props: props({ grantId: "g_hub", userId: ADMIN }), hostname: HUB }, NOW)).toMatchObject({ role: "platform", limits: { changes: 100 } });
    expect(await resolvePrincipal(db, env, { props: props({ grantId: "g_host", userId: ADMIN }), hostname: HOST }, NOW)).toMatchObject({ role: "manager" });
  });

  // A platform admin's hub connection for every workspace has props with
  // workspaceId null; Task 30A's resolveEveryWorkspace serves it.
  it("leaves a connection for every workspace to resolveEveryWorkspace", async () => {
    const db = await setupMcp();
    await seedGrant(db, { id: "g_every", workspaceId: null, userId: ADMIN, host: HUB });
    expect(await resolvePrincipal(db, env, { props: props({ grantId: "g_every", workspaceId: null, userId: ADMIN }), hostname: HUB }, NOW)).toBeNull();
    expect(await resolvePrincipal(db, env, { props: props({ grantId: "g_every", userId: ADMIN }), hostname: HUB }, NOW)).toBeNull();
  });

  it("reads grant props strictly", () => {
    expect(grantPropsOf(props())).toEqual(props());
    expect(grantPropsOf(props({ workspaceId: null }))).toEqual(props({ workspaceId: null }));
    expect(grantPropsOf({ ...props(), workspaceId: 7 })).toBeNull();
    expect(grantPropsOf({ ...props(), v: 2 })).toBeNull();
    expect(grantPropsOf({ ...props(), kind: "requester" })).toBeNull();
    expect(grantPropsOf("x")).toBeNull();
  });
});
