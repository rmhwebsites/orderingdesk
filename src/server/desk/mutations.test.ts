import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { indexOrders } from "@/server/search/index-orders";
import { NOTE_MAX, addOrderNote, changeOrderStatus, changeOrderStatuses } from "./mutations";
import {
  openTestDb,
  seedDraft,
  seedCancelledStatus,
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
    // The status write, then the search index's own batch (the card's
    // search row; its snapshot names no customer, so no people upsert).
    expect(batched).toHaveLength(2);
    expect(batched[0]).toHaveLength(2);
    expect(batched[1]).toHaveLength(1);
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

describe("changeOrderStatuses (bulk)", () => {
  const bulk = (role: "staff" | "manager" = "staff") => ({ workspaceId: WS, userId: USER, role, now: NOW });

  // The same rules hold for one change and for a bulk move.
  it("keeps the cancelled status for Cancel order, and lets only a manager move a cancelled order to a status with no Shopify link", async () => {
    const db = await setup();
    await seedDraftStatuses(db, WS);
    await seedCancelledStatus(db, WS);
    expect(await changeOrderStatus(db, ctx("o1", "manager"), { statusKey: "cancelled" })).toEqual({
      kind: "invalid",
      error: "Use Cancel order to cancel an order. It cancels the order in Shopify.",
    });
    const moved = await changeOrderStatuses(db, bulk("manager"), { orderIds: ["o1"], statusKey: "cancelled" });
    expect(moved.kind === "ok" ? moved.results.map((row) => row.outcome) : moved).toEqual(["refused"]);
    await db.update(schema.orders).set({ statusKey: "cancelled" }).where(eq(schema.orders.id, "o1"));
    expect(await changeOrderStatus(db, ctx("o1", "staff"), { statusKey: "processing" })).toEqual({
      kind: "forbidden",
      error: "Only a manager can move a cancelled order.",
    });
    expect(await changeOrderStatus(db, ctx("o1", "manager"), { statusKey: "shipped" })).toEqual({
      kind: "invalid",
      error: "A cancelled order cannot be marked Shipped. Shopify keeps it cancelled.",
    });
    expect((await changeOrderStatus(db, ctx("o1", "manager"), { statusKey: "issue" })).kind).toBe("changed");
  });

  it("moves every card it may in one batch, each with its own status entry", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o2", name: "#1002", statusKey: "processing" });
    const record: unknown[][] = [];
    const result = await changeOrderStatuses(withBatch(db, record), bulk(), { orderIds: ["o1", "o2"], statusKey: "shipped" });
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.results).toEqual([
      { orderId: "o1", name: "#1001", outcome: "changed" },
      { orderId: "o2", name: "#1002", outcome: "changed" },
    ]);
    // The status writes, then the search index's own batch (one search row
    // per changed card).
    expect(record).toHaveLength(2);
    expect(record[0]).toHaveLength(4);
    expect(record[1]).toHaveLength(2);
    expect((await orderRow(db, "o2")).statusKey).toBe("shipped");
    expect((await orderRow(db, "o2")).statusSetBy).toBe(USER);
    const entries = (await eventsOf(db)).map((entry) => [entry.orderId, entry.text, entry.meta]);
    expect(entries).toEqual(
      expect.arrayContaining([
        ["o1", "Status set to Shipped", { from: "new", to: "shipped", bulk: true }],
        ["o2", "Status set to Shipped", { from: "processing", to: "shipped", bulk: true }],
      ]),
    );
    expect(result.changed.map((change) => change.order.id)).toEqual(["o1", "o2"]);
    expect(result.statusLabel).toBe("Shipped");
  });

  it("re-checks every card: no request into a fulfilled status or Approved, no staff reopening a rejected one", async () => {
    const db = await setup();
    await seedDraftStatuses(db, WS);
    await seedDraft(db, WS, { id: "d1" });
    await seedDraft(db, WS, { id: "d2", statusKey: "rejected" });
    const shipped = await changeOrderStatuses(db, bulk(), { orderIds: ["o1", "d1"], statusKey: "shipped" });
    if (shipped.kind !== "ok") throw new Error(shipped.kind);
    expect(shipped.results.map((row) => [row.orderId, row.outcome, row.error ?? null])).toEqual([
      ["o1", "changed", null],
      ["d1", "refused", "A draft cannot be marked Shipped until it is approved and becomes an order."],
    ]);
    const approved = await changeOrderStatuses(db, bulk("manager"), { orderIds: ["d1"], statusKey: "approved" });
    if (approved.kind !== "ok") throw new Error(approved.kind);
    expect(approved.results[0]).toMatchObject({ outcome: "refused", error: "Use Approve to approve this request. It creates the order in Shopify." });
    const reopen = await changeOrderStatuses(db, bulk("staff"), { orderIds: ["d2"], statusKey: "processing" });
    if (reopen.kind !== "ok") throw new Error(reopen.kind);
    expect(reopen.results[0]).toMatchObject({ outcome: "refused", error: "Only a manager can reopen a rejected request." });
    expect((await orderRow(db, "d1")).statusKey).toBe("new");
    expect((await orderRow(db, "d2")).statusKey).toBe("rejected");
  });

  it("says which cards were already there or are not in this workspace", async () => {
    const db = await setup();
    const result = await changeOrderStatuses(db, bulk(), { orderIds: ["o1", "x1", "nope"], statusKey: "new" });
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.results).toEqual([
      { orderId: "o1", name: "#1001", outcome: "unchanged" },
      { orderId: "x1", name: null, outcome: "not-found" },
      { orderId: "nope", name: null, outcome: "not-found" },
    ]);
    expect(result.changed).toEqual([]);
  });

  it("refuses an empty list, more than 25 cards and an unknown status, changing nothing", async () => {
    const db = await setup();
    expect(await changeOrderStatuses(db, bulk(), { orderIds: [], statusKey: "shipped" })).toEqual({
      kind: "invalid",
      error: "Pick at least one card",
    });
    const many = Array.from({ length: 26 }, (_, i) => `o${i}`);
    expect(await changeOrderStatuses(db, bulk(), { orderIds: many, statusKey: "shipped" })).toEqual({
      kind: "invalid",
      error: "Move up to 25 cards at a time",
    });
    expect(await changeOrderStatuses(db, bulk(), { orderIds: ["o1"], statusKey: "gone" })).toEqual({
      kind: "invalid",
      error: "Unknown status for this workspace",
    });
    expect((await orderRow(db, "o1")).statusKey).toBe("new");
  });

  it("asks for a purchase order only when an order moved into a status that starts one", async () => {
    const db = await setup();
    const result = await changeOrderStatuses(db, bulk(), { orderIds: ["o1"], statusKey: "approved" });
    expect(result).toMatchObject({ kind: "ok", triggersPo: true });
  });

  it("moves every changed card's search row with it", async () => {
    const db = await setup();
    await seedOrder(db, WS, { id: "o2", name: "#1002" });
    await indexOrders(db, WS, ["o1", "o2"]);
    const result = await changeOrderStatuses(db, bulk(), { orderIds: ["o1", "o2"], statusKey: "processing" });
    expect(result.kind).toBe("ok");
    const rows = await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.workspaceId, WS));
    expect(rows.map((row) => row.statusKey).sort()).toEqual(["processing", "processing"]);
  });
});

describe("changeOrderStatus and the search index", () => {
  it("moves the card's search row with its status", async () => {
    const db = await setup();
    await indexOrders(db, WS, ["o1"]);
    const result = await changeOrderStatus(db, ctx(), { statusKey: "processing" });
    expect(result.kind).toBe("changed");
    const [row] = await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, "o1"));
    expect(row).toMatchObject({ statusKey: "processing", statusSetAt: NOW });
  });
});

describe("changes made through an AI app", () => {
  it("record source ai and the app on the status entry and on the note", async () => {
    const db = await setup();
    const via = { client: "claude" as const };
    expect((await changeOrderStatus(db, { ...ctx(), via }, { statusKey: "processing" })).kind).toBe("changed");
    expect((await addOrderNote(db, { ...ctx(), via }, { text: "Checked the stock" })).kind).toBe("added");
    const rows = await eventsOf(db);
    expect(rows.map((row) => [row.type, row.source, row.meta])).toEqual(
      expect.arrayContaining([
        ["status", "ai", { from: "new", to: "processing", ai: { client: "claude" } }],
        ["note", "ai", { ai: { client: "claude" } }],
      ]),
    );
  });
});
