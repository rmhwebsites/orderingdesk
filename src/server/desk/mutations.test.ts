import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { NOTE_MAX, addOrderNote, changeOrderStatus } from "./mutations";
import {
  openTestDb,
  seedDraft,
  seedDraftStatuses,
  seedOrder,
  seedWorkspace,
  snapshotOf,
  withBatch,
} from "./test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";
const USER = "user_marta";
const NOW = Date.parse("2026-10-02T09:30:00.000Z");

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  await seedOrder(db, WS, {
    id: "o1",
    name: "#1001",
    statusKey: "new",
    createdAt: 1000,
    syncedAt: 2000,
    shopify: snapshotOf({ note: "from Shopify" }),
  });
  await seedOrder(db, OTHER, { id: "x1" });
  return db;
}

const ctx = (orderId = "o1", role: "staff" | "manager" | "platform" = "staff") => ({
  workspaceId: WS,
  orderId,
  userId: USER,
  role,
  now: NOW,
});

async function orderRow(db: Db, id: string) {
  const rows = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
  return rows[0];
}

function eventsOf(db: Db, workspaceId = WS) {
  return db.select().from(schema.events).where(eq(schema.events.workspaceId, workspaceId));
}

describe("changeOrderStatus", () => {
  it("writes the order update and a status event together", async () => {
    const db = await setup();
    const result = await changeOrderStatus(db, ctx(), { statusKey: "processing" });

    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    const [event] = await eventsOf(db);
    expect(event).toMatchObject({
      workspaceId: WS,
      orderId: "o1",
      type: "status",
      actorId: USER,
      text: "Status set to Processing",
      meta: { from: "new", to: "processing" },
      createdAt: NOW,
      source: "app",
    });
    expect(result.event).toEqual({
      id: event.id,
      orderId: "o1",
      type: "status",
      text: "Status set to Processing",
      actorId: USER,
      meta: { from: "new", to: "processing" },
      createdAt: NOW,
      source: "app",
    });
    expect(result.order).toEqual({
      id: "o1",
      statusKey: "processing",
      statusSetBy: USER,
      statusSetAt: NOW,
    });
    expect(result.triggersPo).toBe(false);

    const order = await orderRow(db, "o1");
    expect(order.statusKey).toBe("processing");
    expect(order.statusSetBy).toBe(USER);
    expect(order.statusSetAt).toBe(NOW);
  });

  it("sends the order update and the event through one db.batch", async () => {
    const db = await setup();
    const batched: unknown[][] = [];
    const result = await changeOrderStatus(withBatch(db, batched), ctx(), { statusKey: "shipped" });
    expect(result.kind).toBe("changed");
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    expect((await orderRow(db, "o1")).statusKey).toBe("shipped");
    expect(await eventsOf(db)).toHaveLength(1);
  });

  it("reports triggersPo from the target status", async () => {
    const db = await setup();
    const result = await changeOrderStatus(db, ctx(), { statusKey: "approved" });
    expect(result).toMatchObject({ kind: "changed", triggersPo: true });
  });

  it("writes nothing when the status is unchanged", async () => {
    const db = await setup();
    const before = await orderRow(db, "o1");
    const result = await changeOrderStatus(db, ctx(), { statusKey: "new" });
    expect(result).toEqual({ kind: "unchanged" });
    expect(await orderRow(db, "o1")).toEqual(before);
    expect(await eventsOf(db)).toEqual([]);
  });

  it("rejects a status key the workspace does not have, and writes nothing", async () => {
    const db = await setup();
    await db.insert(schema.statuses).values({
      id: "other_only",
      workspaceId: OTHER,
      key: "other_only",
      label: "Other only",
      color: "pink",
      sort: 9,
    });
    const before = await orderRow(db, "o1");
    for (const body of [
      { statusKey: "bogus" },
      { statusKey: "other_only" },
      { statusKey: "" },
      { statusKey: 7 },
      {},
      null,
      "processing",
    ]) {
      const result = await changeOrderStatus(db, ctx(), body);
      expect(result.kind, JSON.stringify(body)).toBe("invalid");
    }
    expect(await orderRow(db, "o1")).toEqual(before);
    expect(await eventsOf(db)).toEqual([]);
  });

  it("never touches the sync-owned snapshot or synced_at", async () => {
    const db = await setup();
    const before = await orderRow(db, "o1");
    await changeOrderStatus(db, ctx(), { statusKey: "processing" });
    const after = await orderRow(db, "o1");
    expect(after.shopify).toEqual(before.shopify);
    expect(after.syncedAt).toBe(2000);
    expect(after.name).toBe(before.name);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.shopifyOrderId).toBe(before.shopifyOrderId);
  });

  // replaceStatuses can delete the status after this function checked it
  // and before its write lands; the order must not end up on a deleted key,
  // with or without the atomic batch path.
  it("does not land on a status removed between its check and its write", async () => {
    for (const batched of [false, true]) {
      const { db, raw } = openTestDb();
      await seedWorkspace(db, WS);
      await seedOrder(db, WS, { id: "o1", statusKey: "new" });
      const removing = new Proxy(db as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop === "update") {
            return (...args: unknown[]) => {
              raw.prepare("DELETE FROM statuses WHERE workspace_id = ? AND key = ?").run(WS, "shipped");
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as unknown as Db;
      const before = await orderRow(db, "o1");

      const result = await changeOrderStatus(batched ? withBatch(removing, []) : removing, ctx(), {
        statusKey: "shipped",
      });
      expect(result.kind, `batched: ${batched}`).toBe("invalid");
      expect(await orderRow(db, "o1")).toEqual(before);
      expect(await eventsOf(db)).toEqual([]);
    }
  });

  it("is not-found for an order in another workspace, and writes nothing there", async () => {
    const db = await setup();
    const before = await orderRow(db, "x1");
    const result = await changeOrderStatus(db, ctx("x1"), { statusKey: "processing" });
    expect(result).toEqual({ kind: "not-found" });
    expect(await orderRow(db, "x1")).toEqual(before);
    expect(await eventsOf(db, OTHER)).toEqual([]);
  });
});

// Draft orders spec section 8.2 and section 18 item 5.
describe("changeOrderStatus on draft cards", () => {
  async function draftSetup(statusKey = "new") {
    const db = await setup();
    await seedDraftStatuses(db, WS);
    await seedDraft(db, WS, { id: "d1", draftId: "12", name: "#D12", statusKey });
    return db;
  }

  it("lets staff move a request between statuses with no Shopify link", async () => {
    const db = await draftSetup();
    const result = await changeOrderStatus(db, ctx("d1"), { statusKey: "processing" });
    expect(result).toMatchObject({ kind: "changed", order: { statusKey: "processing" }, triggersPo: false });
    expect((await changeOrderStatus(db, ctx("d1"), { statusKey: "issue" })).kind).toBe("changed");
  });

  it("refuses the fulfilled and delivered statuses for a request", async () => {
    const db = await draftSetup();
    expect(await changeOrderStatus(db, ctx("d1", "manager"), { statusKey: "shipped" })).toEqual({
      kind: "invalid",
      error: "A draft cannot be marked Shipped until it is approved and becomes an order.",
    });
    expect((await orderRow(db, "d1")).statusKey).toBe("new");
    expect(await eventsOf(db)).toEqual([]);
  });

  it("points to Approve and Reject instead of their statuses", async () => {
    const db = await draftSetup();
    expect(await changeOrderStatus(db, ctx("d1", "manager"), { statusKey: "approved" })).toEqual({
      kind: "invalid",
      error: "Use Approve to approve this request. It creates the order in Shopify.",
    });
    expect(await changeOrderStatus(db, ctx("d1", "platform"), { statusKey: "rejected" })).toEqual({
      kind: "invalid",
      error: "Use Reject to reject this request. It asks for a reason.",
    });
    expect(await eventsOf(db)).toEqual([]);
  });

  it("lets only a manager or platform admin reopen a rejected request", async () => {
    const db = await draftSetup("rejected");
    expect(await changeOrderStatus(db, ctx("d1", "staff"), { statusKey: "processing" })).toEqual({
      kind: "forbidden",
      error: "Only a manager can reopen a rejected request.",
    });
    expect((await orderRow(db, "d1")).statusKey).toBe("rejected");
    expect((await changeOrderStatus(db, ctx("d1", "manager"), { statusKey: "processing" })).kind).toBe("changed");
    await db.update(schema.orders).set({ statusKey: "rejected" }).where(eq(schema.orders.id, "d1"));
    expect((await changeOrderStatus(db, ctx("d1", "platform"), { statusKey: "new" })).kind).toBe("changed");
  });

  it("never rejects an order, and keeps every other status open to orders", async () => {
    const db = await draftSetup();
    expect(await changeOrderStatus(db, ctx("o1", "manager"), { statusKey: "rejected" })).toEqual({
      kind: "invalid",
      error: "Rejected is for requests that are still drafts.",
    });
    expect(await changeOrderStatus(db, ctx("o1"), { statusKey: "approved" })).toMatchObject({
      kind: "changed",
      triggersPo: true,
    });
    expect((await changeOrderStatus(db, ctx("o1"), { statusKey: "shipped" })).kind).toBe("changed");
  });

  it("never asks for a purchase order on a request", async () => {
    const db = await draftSetup();
    await db.update(schema.statuses).set({ triggersPo: true }).where(eq(schema.statuses.key, "processing"));
    expect(await changeOrderStatus(db, ctx("d1"), { statusKey: "processing" })).toMatchObject({
      kind: "changed",
      triggersPo: false,
    });
  });
});

describe("addOrderNote", () => {
  it("stores the trimmed text as a note event and returns it", async () => {
    const db = await setup();
    const result = await addOrderNote(db, ctx(), { text: "  Called the customer.\nShip Monday.  " });

    expect(result.kind).toBe("added");
    if (result.kind !== "added") return;
    const [event] = await eventsOf(db);
    expect(event).toMatchObject({
      workspaceId: WS,
      orderId: "o1",
      type: "note",
      actorId: USER,
      text: "Called the customer.\nShip Monday.",
      createdAt: NOW,
      source: "app",
    });
    expect(result.event).toEqual({
      id: event.id,
      orderId: "o1",
      type: "note",
      text: "Called the customer.\nShip Monday.",
      actorId: USER,
      meta: null,
      createdAt: NOW,
      source: "app",
    });
  });

  it("accepts exactly 4000 characters", async () => {
    const db = await setup();
    expect(NOTE_MAX).toBe(4000);
    const result = await addOrderNote(db, ctx(), { text: "a".repeat(NOTE_MAX) });
    expect(result.kind).toBe("added");
  });

  it("rejects empty, blank, 4001 character and non-string notes, and writes nothing", async () => {
    const db = await setup();
    for (const body of [
      { text: "" },
      { text: "   \n\t " },
      { text: "a".repeat(NOTE_MAX + 1) },
      { text: 42 },
      {},
      null,
    ]) {
      const result = await addOrderNote(db, ctx(), body);
      expect(result.kind, JSON.stringify(body)?.slice(0, 40)).toBe("invalid");
    }
    expect(await eventsOf(db)).toEqual([]);
  });

  it("counts the limit after trimming", async () => {
    const db = await setup();
    const result = await addOrderNote(db, ctx(), { text: `  ${"a".repeat(NOTE_MAX)}  ` });
    expect(result.kind).toBe("added");
  });

  it("is not-found for an order in another workspace", async () => {
    const db = await setup();
    const result = await addOrderNote(db, ctx("x1"), { text: "hello" });
    expect(result).toEqual({ kind: "not-found" });
    expect(await eventsOf(db, OTHER)).toEqual([]);
  });
});
