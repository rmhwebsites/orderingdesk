import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "../../db/schema";
import { openTestDb, seedWorkspace } from "../desk/test-helpers";
import type { SyncResult } from "./run";

vi.mock("./run", () => ({ runSync: vi.fn() }));
vi.mock("../broadcast", () => ({ broadcastSync: vi.fn(async () => undefined), kickUsers: vi.fn(async () => undefined) }));
vi.mock("../notify", () => ({
  notifyNewOrders: vi.fn(async () => ({ claimed: 0, announced: [], pushed: 0, emailed: 0 })),
  notifyActivity: vi.fn(async () => ({ pushed: 0 })),
}));
vi.mock("../shopify/roster-sync", () => ({
  syncRoster: vi.fn(async () => ({ kind: "ok", complete: true, entries: 0, removed: 0, revokedUserIds: [] })),
}));

const { runSync } = await import("./run");
const { broadcastSync, kickUsers } = await import("../broadcast");
const { syncRoster } = await import("../shopify/roster-sync");
const { notifyNewOrders } = await import("../notify");
const { runAllSyncs, WEBHOOK_DELIVERY_RETENTION_MS } = await import("./cron");

const env = { ENCRYPTION_KEY: "unused" } as CloudflareEnv;

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return { added: 0, updated: 0, addedOrderIds: [], updatedOrderIds: [], ...overrides };
}

async function setup() {
  const { db } = openTestDb();
  for (const id of ["ws_a", "ws_b", "ws_off"]) {
    await seedWorkspace(db, id);
    await db.insert(schema.storeConnections).values({
      workspaceId: id,
      shopDomain: `${id}.myshopify.com`,
      encryptedToken: "v1.x",
      status: id === "ws_off" ? "disabled" : "ok",
    });
  }
  return db;
}

beforeEach(() => {
  vi.mocked(runSync).mockReset();
  vi.mocked(broadcastSync).mockClear();
  vi.mocked(kickUsers).mockClear();
  vi.mocked(syncRoster).mockClear();
  vi.mocked(notifyNewOrders).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("runAllSyncs broadcasting", () => {
  it("broadcasts each workspace's landed ids after its run", async () => {
    const db = await setup();
    const a = result({ added: 1, addedOrderIds: ["o1"] });
    const b = result({ updated: 1, updatedOrderIds: ["o2"] });
    vi.mocked(runSync).mockImplementation(async (_db, _env, workspaceId) =>
      workspaceId === "ws_a" ? a : b,
    );
    await runAllSyncs(db, env);
    expect(vi.mocked(runSync).mock.calls.map((call) => call[2]).sort()).toEqual(["ws_a", "ws_b"]);
    expect(vi.mocked(broadcastSync).mock.calls).toEqual(
      expect.arrayContaining([
        [env, "ws_a", a],
        [env, "ws_b", b],
      ]),
    );
    expect(vi.mocked(broadcastSync)).toHaveBeenCalledTimes(2);
  });

  // Phase 6: every order a run inserted is announced (notify.ts claims
  // each one, so a webhook that landed it too announces nothing twice).
  it("announces each workspace's new orders after its run", async () => {
    const db = await setup();
    const a = result({ added: 2, addedOrderIds: ["o1", "o2"], updated: 1, updatedOrderIds: ["o3"] });
    vi.mocked(runSync).mockImplementation(async (_db, _env, workspaceId) => (workspaceId === "ws_a" ? a : result()));
    await runAllSyncs(db, env);
    expect(vi.mocked(notifyNewOrders).mock.calls.map((call) => [call[2], call[3]])).toEqual(
      expect.arrayContaining([
        ["ws_a", ["o1", "o2"]],
        ["ws_b", []],
      ]),
    );
  });

  it("keeps going after one workspace's run throws", async () => {
    const db = await setup();
    const b = result({ added: 2, addedOrderIds: ["x", "y"] });
    vi.mocked(runSync).mockImplementation(async (_db, _env, workspaceId) => {
      if (workspaceId === "ws_a") {
        throw new Error("boom");
      }
      return b;
    });
    await runAllSyncs(db, env);
    expect(vi.mocked(broadcastSync).mock.calls).toEqual([[env, "ws_b", b]]);
  });
});

describe("runAllSyncs roster and housekeeping", () => {
  // Missed customer webhooks heal here; legacy-token stores (no webhooks)
  // get their roster only this way.
  it("reconciles each connected workspace's roster after its order sync", async () => {
    const db = await setup();
    vi.mocked(runSync).mockResolvedValue(result());
    await runAllSyncs(db, env);
    expect(vi.mocked(syncRoster).mock.calls.map((call) => call[2]).sort()).toEqual(["ws_a", "ws_b"]);
  });

  it("closes the open sockets of people whose Shopify tag was revoked", async () => {
    const db = await setup();
    vi.mocked(runSync).mockResolvedValue(result());
    vi.mocked(syncRoster).mockImplementation(async (_db, _env, workspaceId) => ({
      kind: "ok",
      complete: true,
      entries: 1,
      removed: workspaceId === "ws_a" ? 1 : 0,
      revokedUserIds: workspaceId === "ws_a" ? ["u_gone"] : [],
    }));
    await runAllSyncs(db, env);
    expect(vi.mocked(kickUsers).mock.calls).toEqual([[env, "ws_a", ["u_gone"]]]);
    // User ids stay out of the log line.
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("u_gone");
  });

  it("keeps going when a roster sync throws", async () => {
    const db = await setup();
    vi.mocked(runSync).mockResolvedValue(result());
    vi.mocked(syncRoster).mockRejectedValueOnce(new Error("boom"));
    await runAllSyncs(db, env);
    expect(vi.mocked(syncRoster)).toHaveBeenCalledTimes(2);
  });

  it("prunes webhook deliveries older than the retention window", async () => {
    const db = await setup();
    vi.mocked(runSync).mockResolvedValue(result());
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    expect(WEBHOOK_DELIVERY_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    await db.insert(schema.webhookDeliveries).values([
      { id: "ws_a:old", workspaceId: "ws_a", topic: "orders/updated", receivedAt: now - WEBHOOK_DELIVERY_RETENTION_MS - 1 },
      { id: "ws_a:kept", workspaceId: "ws_a", topic: "orders/updated", receivedAt: now - WEBHOOK_DELIVERY_RETENTION_MS + 1 },
    ]);
    await runAllSyncs(db, env, { now: () => now });
    const left = await db.select().from(schema.webhookDeliveries);
    expect(left.map((row) => row.id)).toEqual(["ws_a:kept"]);
  });
});
