import { describe, it, expect, vi } from "vitest";
import * as schema from "@/db/schema";
import { openTestDb } from "@/server/desk/test-helpers";
import { providerUserId, type GrantHelpers } from "./grants";
import { pruneDeletes, pruneMcpTables, sweepKvRevokes } from "./prune";
import { GRANT, MANAGER, NOW, STAFF, WS, seedGrant, setupMcp } from "./test-helpers";

const DAY = 86400000;

describe("the MCP prune", () => {
  it("drops old prepared actions and sign-in codes, and audit rows after 400 days", async () => {
    const db = await setupMcp();
    const action = (id: string, createdAt: number) => ({ id, workspaceId: WS, grantId: GRANT, userId: MANAGER, tool: "note" as const, targetId: "d1", payload: {}, contentHash: "h", createdAt, expiresAt: createdAt + 600000 });
    await db.insert(schema.aiActions).values([action("a_old", NOW - 3 * DAY), action("a_new", NOW - 1000)]);
    const code = (id: string, createdAt: number) => ({ id, origin: "https://orders.example.com", email: "x@example.com", userId: null, clientId: "c", codeHash: "h", ipHash: "i", createdAt, expiresAt: createdAt + 600000 });
    await db.insert(schema.aiSignInCodes).values([code("c_old", NOW - 3 * DAY), code("c_new", NOW - 1000)]);
    const audit = (id: string, createdAt: number) => ({ id, workspaceId: WS, actorId: MANAGER, tool: "get_order", outcome: "ok", createdAt });
    await db.insert(schema.auditLog).values([audit("l_old", NOW - 401 * DAY), audit("l_new", NOW - 399 * DAY)]);
    await pruneMcpTables(db, NOW);
    expect((await db.select().from(schema.aiActions)).map((row) => row.id)).toEqual(["a_new"]);
    expect((await db.select().from(schema.aiSignInCodes)).map((row) => row.id)).toEqual(["c_new"]);
    expect((await db.select().from(schema.auditLog)).map((row) => row.id)).toEqual(["l_new"]);
  });

  // Retention is counted from when a row was made, to the millisecond: an
  // action or a code made exactly two days ago stays, one made a moment
  // earlier goes (the deletes read expires_at, which is created_at plus
  // the 10-minute life, so they can use its index).
  it("keeps the retention exact at the boundary", async () => {
    const db = await setupMcp();
    const action = (id: string, createdAt: number) => ({ id, workspaceId: WS, grantId: GRANT, userId: MANAGER, tool: "note" as const, targetId: "d1", payload: {}, contentHash: "h", createdAt, expiresAt: createdAt + 600000 });
    await db.insert(schema.aiActions).values([action("a_edge_old", NOW - 2 * DAY - 1), action("a_edge", NOW - 2 * DAY)]);
    const code = (id: string, createdAt: number) => ({ id, origin: "https://orders.example.com", email: "x@example.com", userId: null, clientId: "c", codeHash: "h", ipHash: "i", createdAt, expiresAt: createdAt + 600000 });
    await db.insert(schema.aiSignInCodes).values([code("c_edge_old", NOW - 2 * DAY - 1), code("c_edge", NOW - 2 * DAY)]);
    const audit = (id: string, createdAt: number) => ({ id, workspaceId: WS, actorId: MANAGER, tool: "get_order", outcome: "ok", createdAt });
    await db.insert(schema.auditLog).values([audit("l_edge_old", NOW - 400 * DAY - 1), audit("l_edge", NOW - 400 * DAY)]);
    await pruneMcpTables(db, NOW);
    expect((await db.select().from(schema.aiActions)).map((row) => row.id)).toEqual(["a_edge"]);
    expect((await db.select().from(schema.aiSignInCodes)).map((row) => row.id)).toEqual(["c_edge"]);
    expect((await db.select().from(schema.auditLog)).map((row) => row.id)).toEqual(["l_edge"]);
  });

  // The cron runs every 10 minutes and audit_log keeps one row per tool
  // call for 400 days: a delete that scans the whole table reads every
  // retained row 144 times a day. Each delete must search an index (as
  // webhook_deliveries' prune does with webhook_received).
  it("deletes through an index on every table, never a scan of the whole table", () => {
    const { db, raw } = openTestDb();
    const plans = pruneDeletes(db, NOW).map((statement) => {
      const { sql, params } = statement.toSQL();
      return (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as number[])) as { detail: string }[]).map((row) => row.detail).join("; ");
    });
    expect(plans).toHaveLength(3);
    expect(plans[0]).toMatch(/^SEARCH ai_actions USING (COVERING )?INDEX ai_actions_expires /);
    expect(plans[1]).toMatch(/^SEARCH ai_sign_in_codes USING (COVERING )?INDEX ai_codes_expires /);
    expect(plans[2]).toMatch(/^SEARCH audit_log USING (COVERING )?INDEX audit_created /);
    for (const plan of plans) {
      expect(plan).not.toMatch(/\bSCAN\b/);
    }
  });

  it("revokes revoked connections in KV once, and builds the helpers only when there is work", async () => {
    const db = await setupMcp();
    await seedGrant(db, { id: "g_live" });
    await seedGrant(db, { id: "g_gone", revokedAt: NOW - 1000 });
    const revokeGrant = vi.fn(async () => undefined);
    const listUserGrants = vi.fn(async () => ({ items: [{ id: "kv1", clientId: "c", userId: "x", scope: [], metadata: { aiGrantId: "g_gone" }, createdAt: 1 }] }));
    const helpers = vi.fn(() => ({ listUserGrants, revokeGrant }) as unknown as GrantHelpers);
    expect(await sweepKvRevokes(db, helpers, NOW)).toBe(1);
    expect(revokeGrant).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.aiGrants)).find((row) => row.id === "g_gone")?.kvRevokedAt).toBe(NOW);
    expect(await sweepKvRevokes(db, helpers, NOW + 1)).toBe(0);
    expect(helpers).toHaveBeenCalledTimes(1);
  });

  // A KV revoke that failed stays pending, so the next cron tick tries it
  // again; only the owners whose revoke worked are marked, and the log line
  // counts the rest.
  it("marks only the connections whose KV revoke worked, and tries a failed one again on the next tick", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = await setupMcp();
    await seedGrant(db, { id: "g_ok", userId: MANAGER, revokedAt: NOW - 1000 });
    await seedGrant(db, { id: "g_down", userId: STAFF, revokedAt: NOW - 1000 });
    let kvDown = true;
    const listUserGrants = vi.fn(async (owner: string) => {
      if (owner === providerUserId(WS, STAFF) && kvDown) {
        throw new Error("kv down");
      }
      const aiGrantId = owner === providerUserId(WS, STAFF) ? "g_down" : "g_ok";
      return { items: [{ id: "kv_" + aiGrantId, clientId: "c", userId: owner, scope: [], metadata: { aiGrantId }, createdAt: 1 }] };
    });
    const revokeGrant = vi.fn(async () => undefined);
    const helpers = vi.fn(() => ({ listUserGrants, revokeGrant }) as unknown as GrantHelpers);
    const kvRevokedAt = async () =>
      Object.fromEntries((await db.select().from(schema.aiGrants)).map((row) => [row.id, row.kvRevokedAt]));

    expect(await sweepKvRevokes(db, helpers, NOW)).toBe(1);
    expect(await kvRevokedAt()).toEqual({ g_ok: NOW, g_down: null });
    expect(log).toHaveBeenLastCalledWith('[oauth] {"kvSwept":2,"kvRevoked":1,"kvFailed":1}');

    kvDown = false;
    expect(await sweepKvRevokes(db, helpers, NOW + 1)).toBe(1);
    expect(await kvRevokedAt()).toEqual({ g_ok: NOW, g_down: NOW + 1 });
    expect(revokeGrant.mock.calls.map((args) => (args as unknown[])[0])).toEqual(["kv_g_ok", "kv_g_down"]);
    expect(log).toHaveBeenLastCalledWith('[oauth] {"kvSwept":1,"kvRevoked":1,"kvFailed":0}');

    expect(await sweepKvRevokes(db, helpers, NOW + 2)).toBe(0);
    expect(helpers).toHaveBeenCalledTimes(2);
    log.mockRestore();
    warn.mockRestore();
  });

  // A revoke that fails after the listing (the KV write) is no different.
  it("leaves a connection pending when revoking its KV grant fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = await setupMcp();
    await seedGrant(db, { id: "g_gone", revokedAt: NOW - 1000 });
    const listUserGrants = vi.fn(async () => ({ items: [{ id: "kv1", clientId: "c", userId: "x", scope: [], metadata: { aiGrantId: "g_gone" }, createdAt: 1 }] }));
    const revokeGrant = vi.fn(async () => {
      throw new Error("kv write failed");
    });
    const helpers = () => ({ listUserGrants, revokeGrant }) as unknown as GrantHelpers;
    expect(await sweepKvRevokes(db, helpers, NOW)).toBe(0);
    expect((await db.select().from(schema.aiGrants))[0].kvRevokedAt).toBeNull();
    expect(log).toHaveBeenLastCalledWith('[oauth] {"kvSwept":1,"kvRevoked":0,"kvFailed":1}');
    expect(warn).toHaveBeenCalledWith('[oauth] {"kvRevoke":"Error"}');
    log.mockRestore();
    warn.mockRestore();
  });
});
