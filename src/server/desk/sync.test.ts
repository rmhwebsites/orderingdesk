import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import type { SyncResult } from "@/server/sync/run";
import {
  MANUAL_SYNC_COOLDOWN_MS,
  getSyncConnection,
  manualSync,
  manualSyncResponse,
} from "./sync";
import { openTestDb, seedWorkspace } from "./test-helpers";

const WS = "ws_impact";
const NOW = Date.parse("2026-10-02T09:30:00.000Z");
const env = {} as CloudflareEnv;

async function setup(connection?: Partial<typeof schema.storeConnections.$inferInsert>) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  if (connection) {
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impact-rentals.myshopify.com",
      encryptedToken: "v1.ciphertext-not-for-clients",
      ...connection,
    });
  }
  return db;
}

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return { added: 0, updated: 0, addedOrderIds: [], updatedOrderIds: [], ...overrides };
}

// A stand-in for runSync that records its calls.
function fakeRun(out: SyncResult) {
  const calls: string[] = [];
  const run = async (_db: Db, _env: CloudflareEnv, workspaceId: string) => {
    calls.push(workspaceId);
    return out;
  };
  return { run, calls };
}

async function lastManualSyncAt(db: Db) {
  const rows = await db
    .select({ at: schema.storeConnections.lastManualSyncAt })
    .from(schema.storeConnections)
    .where(eq(schema.storeConnections.workspaceId, WS));
  return rows[0]?.at;
}

describe("getSyncConnection", () => {
  it("is null when the workspace has no store connection", async () => {
    const db = await setup();
    expect(await getSyncConnection(db, WS)).toBeNull();
  });

  it("returns the connection card fields and never the token", async () => {
    const db = await setup({ status: "error", lastSyncAt: NOW - 60000, lastError: "Shopify said no" });
    expect(await getSyncConnection(db, WS)).toEqual({
      shopDomain: "impact-rentals.myshopify.com",
      adminShopDomain: "impact-rentals.myshopify.com",
      status: "error",
      lastSyncAt: NOW - 60000,
      lastError: "Shopify said no",
      catchingUp: false,
    });
  });

  it("links to Shopify admin through the store's canonical domain once it is known", async () => {
    // A store saved under an alias (impactrentals.myshopify.com) has its admin
    // at the canonical handle (admin.shopify.com/store/40kra0-b6).
    const db = await setup({ shopDomain: "impactrentals.myshopify.com", canonicalShopDomain: "40kra0-b6.myshopify.com" });
    const connection = await getSyncConnection(db, WS);
    expect(connection?.shopDomain).toBe("impactrentals.myshopify.com");
    expect(connection?.adminShopDomain).toBe("40kra0-b6.myshopify.com");
  });

  it("reports catchingUp while a cursor chain is still draining", async () => {
    const db = await setup({ syncCursor: "1790000000000|abc", syncCursorSince: NOW - 3600000 });
    const connection = await getSyncConnection(db, WS);
    expect(connection?.catchingUp).toBe(true);
    expect(connection?.lastSyncAt).toBe(0);
  });
});

describe("manualSync cooldown", () => {
  it("refuses a run inside the 30 second window without calling the engine", async () => {
    const db = await setup({ lastManualSyncAt: NOW - MANUAL_SYNC_COOLDOWN_MS + 1 });
    const { run, calls } = fakeRun(result());
    const outcome = await manualSync(db, env, WS, { now: NOW, run });
    expect(outcome).toEqual({ kind: "cooldown", retryAfterSeconds: 1 });
    expect(calls).toEqual([]);
  });

  it("allows a run exactly 30 seconds after the last one", async () => {
    const db = await setup({ lastManualSyncAt: NOW - MANUAL_SYNC_COOLDOWN_MS });
    const { run, calls } = fakeRun(result({ added: 1, addedOrderIds: ["o1"] }));
    const outcome = await manualSync(db, env, WS, { now: NOW, run });
    expect(outcome.kind).toBe("done");
    expect(calls).toEqual([WS]);
  });

  it("rounds the wait up to whole seconds", async () => {
    const db = await setup({ lastManualSyncAt: NOW - 1 });
    const { run } = fakeRun(result());
    expect(await manualSync(db, env, WS, { now: NOW, run })).toEqual({
      kind: "cooldown",
      retryAfterSeconds: 30,
    });
  });
});

describe("manualSync cooldown stamp", () => {
  it("stamps a run that did work", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result({ updated: 2, updatedOrderIds: ["o1", "o2"] }));
    await manualSync(db, env, WS, { now: NOW, run });
    expect(await lastManualSyncAt(db)).toBe(NOW);
  });

  it("stamps a clean run that found nothing new", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result());
    await manualSync(db, env, WS, { now: NOW, run });
    expect(await lastManualSyncAt(db)).toBe(NOW);
  });

  it("stamps a failed run that still landed orders", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result({ error: "throttled", added: 1, addedOrderIds: ["o1"] }));
    await manualSync(db, env, WS, { now: NOW, run });
    expect(await lastManualSyncAt(db)).toBe(NOW);
  });

  it("does not stamp a fruitless failure, so it can be retried at once", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result({ error: "Shopify rejected the token." }));
    await manualSync(db, env, WS, { now: NOW, run });
    expect(await lastManualSyncAt(db)).toBe(0);
  });

  // A superseded run wrote nothing of its own terminal state (another run,
  // a connection save or a disconnect took the lease), so when it landed no
  // order either, nothing happened and the person may retry at once.
  it("does not stamp a superseded run that landed nothing", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result({ superseded: true }));
    await manualSync(db, env, WS, { now: NOW, run });
    expect(await lastManualSyncAt(db)).toBe(0);
  });

  it("stamps a superseded run that still landed orders", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result({ superseded: true, added: 2, addedOrderIds: ["o1", "o2"] }));
    await manualSync(db, env, WS, { now: NOW, run });
    expect(await lastManualSyncAt(db)).toBe(NOW);
  });

  it("does not stamp a skipped run", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result({ skipped: "running" }));
    await manualSync(db, env, WS, { now: NOW, run });
    expect(await lastManualSyncAt(db)).toBe(0);
  });

  it("runs (and the engine reports the skip) when there is no connection", async () => {
    const db = await setup();
    const { run, calls } = fakeRun(result({ skipped: "no-connection" }));
    const outcome = await manualSync(db, env, WS, { now: NOW, run });
    expect(calls).toEqual([WS]);
    expect(outcome).toEqual({ kind: "done", result: result({ skipped: "no-connection" }) });
  });
});

describe("manualSyncResponse", () => {
  it("maps the cooldown to 429 with Retry-After in seconds", () => {
    expect(manualSyncResponse({ kind: "cooldown", retryAfterSeconds: 12 })).toEqual({
      status: 429,
      headers: { "Retry-After": "12" },
      body: { error: "Sync already ran in the last 30 seconds" },
    });
  });

  it("maps a failed run to 502 with the error and the partial counts", () => {
    const failed = result({
      error: "Shopify is unavailable",
      added: 3,
      updated: 1,
      addedOrderIds: ["a", "b", "c"],
      updatedOrderIds: ["d"],
    });
    expect(manualSyncResponse({ kind: "failed", result: failed })).toEqual({
      status: 502,
      body: { error: "Shopify is unavailable", added: 3, updated: 1 },
    });
  });

  it("maps a finished run, skipped or not, to 200 with the whole result", () => {
    const done = result({ added: 1, addedOrderIds: ["a"] });
    expect(manualSyncResponse({ kind: "done", result: done })).toEqual({ status: 200, body: done });
    const skipped = result({ skipped: "disabled" });
    expect(manualSyncResponse({ kind: "done", result: skipped })).toEqual({
      status: 200,
      body: skipped,
    });
  });

  it("classifies an engine result with an error as failed", async () => {
    const db = await setup({ lastManualSyncAt: 0 });
    const { run } = fakeRun(result({ error: "boom", updated: 1, updatedOrderIds: ["x"] }));
    const outcome = await manualSync(db, env, WS, { now: NOW, run });
    expect(outcome.kind).toBe("failed");
    expect(manualSyncResponse(outcome).status).toBe(502);
  });
});
