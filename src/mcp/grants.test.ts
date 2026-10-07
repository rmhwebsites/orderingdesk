import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { GRANT_TTL_MS, TOUCH_EVERY_MS } from "./constants";
import { loadActiveGrant, providerUserId, recordGrant, revokeGrants, revokeInKv, touchGrant, type GrantHelpers } from "./grants";
import { ADMIN, HOST, HUB, MANAGER, NOW, STAFF, WS, setupMcp } from "./test-helpers";

const input = (overrides: Partial<Parameters<typeof recordGrant>[2]> = {}) => ({
  workspaceId: WS,
  userId: MANAGER,
  host: HOST,
  clientId: "https://claude.ai/oauth/mcp-client",
  client: "claude" as const,
  clientDomain: "claude.ai",
  redirectHost: "claude.ai",
  scopes: ["desk.read", "desk.write"],
  ...overrides,
});

describe("the grant mirror", () => {
  it("records a connection for 90 days and replaces the same app's older one on the same host", async () => {
    expect(GRANT_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
    const db = await setupMcp();
    await recordGrant(db, "g1", input(), NOW - 1000);
    await recordGrant(db, "g2", input({ redirectHost: "claude.com" }), NOW - 500);
    await recordGrant(db, "g3", input(), NOW);
    const rows = await db.select().from(schema.aiGrants);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("g1")).toMatchObject({ revokedAt: NOW, revokedBy: null, revokeReason: "replaced" });
    expect(byId.get("g2")?.revokedAt).toBeNull();
    expect(byId.get("g3")).toMatchObject({ revokedAt: null, createdAt: NOW, expiresAt: NOW + GRANT_TTL_MS, scopes: ["desk.read", "desk.write"] });
  });

  it("loads only active, unexpired connections", async () => {
    const db = await setupMcp();
    await recordGrant(db, "g1", input(), NOW);
    expect((await loadActiveGrant(db, "g1", NOW + 1000))?.id).toBe("g1");
    expect(await loadActiveGrant(db, "g1", NOW + GRANT_TTL_MS)).toBeNull();
    await revokeGrants(db, { workspaceId: WS, grantId: "g1" }, { userId: MANAGER, reason: "person" }, NOW + 2000);
    expect(await loadActiveGrant(db, "g1", NOW + 3000)).toBeNull();
    expect(await loadActiveGrant(db, "nope", NOW)).toBeNull();
  });

  it("writes last used at most every five minutes", async () => {
    const db = await setupMcp();
    await recordGrant(db, "g1", input(), NOW);
    await touchGrant(db, "g1", NOW + 1000);
    await touchGrant(db, "g1", NOW + 2000);
    const lastUsed = async () => (await db.select().from(schema.aiGrants).where(eq(schema.aiGrants.id, "g1")))[0].lastUsedAt;
    expect(await lastUsed()).toBe(NOW + 1000);
    await touchGrant(db, "g1", NOW + 1000 + TOUCH_EVERY_MS + 1);
    expect(await lastUsed()).toBe(NOW + 1000 + TOUCH_EVERY_MS + 1);
  });

  it("revokes one connection, a person's, or all of a workspace's, and returns what it revoked", async () => {
    const db = await setupMcp();
    await recordGrant(db, "g1", input(), NOW);
    await recordGrant(db, "g2", input({ userId: STAFF }), NOW);
    await recordGrant(db, "g3", input({ userId: STAFF, client: "chatgpt", clientId: "https://chatgpt.com/oauth/client.json", redirectHost: "chatgpt.com" }), NOW);
    expect((await revokeGrants(db, { workspaceId: WS, userId: STAFF }, { userId: MANAGER, reason: "manager" }, NOW + 1)).map((row) => row.id).sort()).toEqual(["g2", "g3"]);
    expect((await revokeGrants(db, { workspaceId: WS }, { userId: null, reason: "platform_admin" }, NOW + 2)).map((row) => row.id)).toEqual(["g1"]);
    expect(await revokeGrants(db, { workspaceId: WS }, { userId: null, reason: "platform_admin" }, NOW + 3)).toEqual([]);
  });

  // Owner decision 3 (Oct 7): a platform admin's hub connection covers every
  // workspace; its mirror row has no workspace and its own provider user id.
  it("keeps a connection for every workspace apart from the per-workspace ones", async () => {
    const db = await setupMcp();
    const hubAdmin = (overrides: Partial<Parameters<typeof recordGrant>[2]> = {}) => input({ workspaceId: null, userId: ADMIN, host: HUB, ...overrides });
    await recordGrant(db, "e1", hubAdmin(), NOW - 1000);
    await recordGrant(db, "w1", input({ userId: ADMIN, host: HUB }), NOW - 500);
    await recordGrant(db, "e2", hubAdmin(), NOW);
    const byId = new Map((await db.select().from(schema.aiGrants)).map((row) => [row.id, row]));
    expect(byId.get("e1")).toMatchObject({ workspaceId: null, revokeReason: "replaced" });
    expect(byId.get("w1")?.revokedAt).toBeNull();
    expect(byId.get("e2")).toMatchObject({ workspaceId: null, revokedAt: null, expiresAt: NOW + GRANT_TTL_MS });
    expect(providerUserId(null, ADMIN)).toBe(encodeURIComponent(`*.${ADMIN}`));
    // A workspace's own revoke leaves it alone unless asked to include it;
    // revoking by null reaches only the every-workspace rows.
    expect((await revokeGrants(db, { workspaceId: WS, userId: ADMIN }, { userId: ADMIN, reason: "person" }, NOW + 1)).map((row) => row.id)).toEqual(["w1"]);
    expect((await revokeGrants(db, { workspaceId: WS, everyWorkspaceToo: true }, { userId: ADMIN, reason: "platform_admin" }, NOW + 2)).map((row) => row.id)).toEqual(["e2"]);
    await recordGrant(db, "e3", hubAdmin(), NOW + 3);
    expect((await revokeGrants(db, { workspaceId: null, grantId: "e3" }, { userId: ADMIN, reason: "person" }, NOW + 4)).map((row) => row.id)).toEqual(["e3"]);
  });

  it("revokes the matching KV grants best effort, by the provider user id", async () => {
    const listUserGrants = vi.fn(async (owner: string, options?: { cursor?: string }) =>
      options?.cursor
        ? { items: [{ id: "kv2", clientId: "c", userId: owner, scope: [], metadata: { aiGrantId: "g2" }, createdAt: 1 }] }
        : {
            items: [
              { id: "kv1", clientId: "c", userId: owner, scope: [], metadata: { aiGrantId: "g1" }, createdAt: 1 },
              { id: "kv9", clientId: "c", userId: owner, scope: [], metadata: { aiGrantId: "other" }, createdAt: 1 },
            ],
            cursor: "next",
          },
    );
    const revokeGrant = vi.fn(async () => undefined);
    const helpers = { listUserGrants, revokeGrant } as unknown as GrantHelpers;
    const owner = providerUserId(WS, MANAGER);
    expect(owner).toBe(encodeURIComponent(`${WS}.${MANAGER}`));
    expect(await revokeInKv(helpers, [{ id: "g1", workspaceId: WS, userId: MANAGER }, { id: "g2", workspaceId: WS, userId: MANAGER }])).toBe(2);
    expect(revokeGrant.mock.calls).toEqual([["kv1", owner], ["kv2", owner]]);
    const failing = { listUserGrants: vi.fn(async () => { throw new Error("kv down"); }), revokeGrant } as unknown as GrantHelpers;
    expect(await revokeInKv(failing, [{ id: "g1", workspaceId: WS, userId: MANAGER }])).toBe(0);
    const everyOwner = vi.fn(async (owner: string) => ({ items: [{ id: "kv5", clientId: "c", userId: owner, scope: [], metadata: { aiGrantId: "e1" }, createdAt: 1 }] }));
    const everyHelpers = { listUserGrants: everyOwner, revokeGrant } as unknown as GrantHelpers;
    expect(await revokeInKv(everyHelpers, [{ id: "e1", workspaceId: null, userId: ADMIN }])).toBe(1);
    expect(everyOwner.mock.calls[0][0]).toBe(providerUserId(null, ADMIN));
  });
});
