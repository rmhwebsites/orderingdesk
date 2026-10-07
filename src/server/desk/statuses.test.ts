import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { STATUS_COLORS, STATUS_LABEL_MAX, STATUS_LIST_MAX, replaceStatuses } from "./statuses";
import { openTestDb, seedOrder, seedWorkspace, withBatch } from "./test-helpers";

const WS = "ws_impact";
const OTHER = "ws_other";

async function setup() {
  const { db, raw } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  return { db, raw };
}

function statusRows(db: Db, workspaceId = WS) {
  return db
    .select()
    .from(schema.statuses)
    .where(eq(schema.statuses.workspaceId, workspaceId))
    .orderBy(asc(schema.statuses.sort), asc(schema.statuses.key));
}

// Proxy that assigns an order to statusKey the moment the delete statement
// is built, i.e. after replaceStatuses' in-use check and before its batch
// runs.
function assignDuringDelete(db: Db, raw: ReturnType<typeof openTestDb>["raw"], statusKey: string): Db {
  return new Proxy(db as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "delete") {
        return (...args: unknown[]) => {
          raw
            .prepare(
              "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run("late", WS, "777", "#777", "{}", statusKey, 1, 1);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

const entry = (label: string, extra: Record<string, unknown> = {}) => ({
  label,
  color: "blue",
  triggersPo: false,
  ...extra,
});

describe("replaceStatuses", () => {
  it("updates by key, inserts new entries, deletes omitted unused statuses, and sorts by position", async () => {
    const { db } = await setup();
    const before = await statusRows(db);
    const idOf = (key: string) => before.find((row) => row.key === key)?.id;

    const result = await replaceStatuses(db, WS, [
      { key: "approved", label: "Approved for PO", color: "teal", triggersPo: false },
      { key: "new", label: "Fresh", color: "pink", triggersPo: true },
      { label: "Waiting on Parts", color: "amber", triggersPo: false },
    ]);

    expect(result).toEqual({
      kind: "ok",
      statuses: [
        { key: "approved", label: "Approved for PO", color: "teal", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
        { key: "new", label: "Fresh", color: "pink", sort: 1, triggersPo: true, shopifyLink: null, closed: false },
        { key: "waiting_on_parts", label: "Waiting on Parts", color: "amber", sort: 2, triggersPo: false, shopifyLink: null, closed: false },
      ],
    });
    const after = await statusRows(db);
    expect(after.map((row) => row.key)).toEqual(["approved", "new", "waiting_on_parts"]);
    // Kept statuses are updated in place, not re-created.
    expect(after.find((row) => row.key === "approved")?.id).toBe(idOf("approved"));
    expect(after.find((row) => row.key === "new")?.id).toBe(idOf("new"));
    // The other workspace is untouched.
    expect((await statusRows(db, OTHER)).map((row) => row.key)).toEqual([
      "new",
      "processing",
      "approved",
      "shipped",
    ]);
  });

  it("slugifies new keys from labels and dedupes them against every existing and new key", async () => {
    const { db } = await setup();
    const result = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      { key: "processing", label: "Processing", color: "blue", triggersPo: false },
      { key: "approved", label: "Approved", color: "green", triggersPo: true },
      entry("New"),
      entry("new!"),
      entry("  Out for Delivery!! "),
      entry("Café Hold"),
      entry("!!!"),
      // "shipped" is being removed in this same save; its key is not reused.
      entry("Shipped"),
    ]);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.statuses.map((s) => s.key)).toEqual([
      "new",
      "processing",
      "approved",
      "new_2",
      "new_3",
      "out_for_delivery",
      "cafe_hold",
      "status",
      "shipped_2",
    ]);
    expect(result.statuses[5].label).toBe("Out for Delivery!!");
  });

  it("keeps keys immutable: a known key updates that status and an unknown key is refused", async () => {
    const { db } = await setup();
    await db.insert(schema.statuses).values({
      id: "other_only",
      workspaceId: OTHER,
      key: "other_only",
      label: "Other only",
      color: "pink",
      sort: 9,
    });

    const renamed = await replaceStatuses(db, WS, [
      { key: "new", label: "Brand New", color: "lime", triggersPo: false },
    ]);
    expect(renamed.kind).toBe("ok");
    expect((await statusRows(db)).map((row) => [row.key, row.label])).toEqual([["new", "Brand New"]]);

    const before = await statusRows(db);
    for (const key of ["brand_new", "other_only", "", 7]) {
      const result = await replaceStatuses(db, WS, [
        { key, label: "Anything", color: "lime", triggersPo: false },
      ]);
      expect(result.kind, JSON.stringify(key)).toBe("invalid");
    }
    expect(await statusRows(db)).toEqual(before);
  });

  it("refuses to remove statuses that orders use, with counts, and changes nothing", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "a", statusKey: "processing" });
    await seedOrder(db, WS, { id: "b", statusKey: "processing" });
    await seedOrder(db, WS, { id: "c", statusKey: "shipped" });
    await seedOrder(db, WS, { id: "d", statusKey: "new" });
    // Another workspace's orders never block this one.
    await seedOrder(db, OTHER, { id: "x", statusKey: "approved" });
    const before = await statusRows(db);

    const result = await replaceStatuses(db, WS, [
      { key: "new", label: "Renamed", color: "red", triggersPo: false },
      { key: "approved", label: "Approved", color: "green", triggersPo: true },
      entry("Brand new status"),
    ]);

    expect(result).toEqual({
      kind: "in-use",
      error: expect.any(String),
      inUse: [
        { key: "processing", label: "Processing", count: 2 },
        { key: "shipped", label: "Shipped", count: 1 },
      ],
    });
    expect(await statusRows(db)).toEqual(before);
  });

  it("removes a status once no order uses it", async () => {
    const { db } = await setup();
    await seedOrder(db, OTHER, { id: "x", statusKey: "shipped" });
    const result = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
    ]);
    expect(result.kind).toBe("ok");
    expect((await statusRows(db)).map((row) => row.key)).toEqual(["new"]);
  });

  // The in-use check runs before the batch. An order assigned to a removed
  // status in between must not be orphaned: that delete is guarded in SQL.
  it("keeps a status that gains an order between the check and the write", async () => {
    const { db, raw } = await setup();
    const result = await replaceStatuses(assignDuringDelete(db, raw, "shipped"), WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
    ]);
    expect(result.kind).toBe("ok");
    const keys = (await statusRows(db)).map((row) => row.key);
    expect(keys).toEqual(["new", "shipped"]);
  });

  // Left at its old sort, a survivor could tie with the new sort 0 and so
  // become the default status for synced orders.
  it("moves a status the guard kept to the end of the list", async () => {
    const { db, raw } = await setup();
    // Remove "new" (the default, sort 0) and "shipped"; an order is assigned
    // to "new" between the check and the write.
    const result = await replaceStatuses(assignDuringDelete(db, raw, "new"), WS, [
      { key: "processing", label: "Processing", color: "blue", triggersPo: false },
      { key: "approved", label: "Approved", color: "green", triggersPo: true },
    ]);
    expect(result.kind).toBe("ok");
    expect((await statusRows(db)).map((row) => [row.key, row.sort])).toEqual([
      ["processing", 0],
      ["approved", 1],
      ["new", 2],
    ]);
  });

  it("sends every write through one batch", async () => {
    const { db, raw } = await setup();
    const batched: unknown[][] = [];
    const result = await replaceStatuses(withBatch(assignDuringDelete(db, raw, "shipped"), batched), WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      { key: "approved", label: "Approved", color: "green", triggersPo: true },
      entry("Brand new"),
    ]);
    expect(result.kind).toBe("ok");
    expect(batched).toHaveLength(1);
    // The guarded delete, the survivor re-sort, two updates and one insert.
    expect(batched[0]).toHaveLength(5);
    expect((await statusRows(db)).map((row) => row.key)).toEqual([
      "new",
      "approved",
      "brand_new",
      "shipped",
    ]);
  });

  it("allows exactly the nine design token colors, green included", async () => {
    const { db } = await setup();
    expect([...STATUS_COLORS]).toEqual([
      "lime",
      "blue",
      "amber",
      "green",
      "teal",
      "violet",
      "red",
      "slate",
      "pink",
    ]);
    const result = await replaceStatuses(
      db,
      WS,
      STATUS_COLORS.map((color, i) => entry(`Color ${i}`, { color })),
    );
    expect(result.kind).toBe("ok");
  });

  it("validates the list and each entry, changing nothing on any failure", async () => {
    const { db } = await setup();
    expect(STATUS_LIST_MAX).toBe(20);
    const before = await statusRows(db);
    const bodies: unknown[] = [
      null,
      "new",
      { statuses: [entry("Wrapped")] },
      [],
      Array.from({ length: STATUS_LIST_MAX + 1 }, (_, i) => entry(`Status ${i}`)),
      [entry("Fine"), "not an object"],
      [entry("")],
      [entry("   ")],
      [entry("x".repeat(26))],
      [entry("Bad color", { color: "#ff0000" })],
      [entry("Bad color", { color: "purple" })],
      [entry("Bad color", { color: "Lime" })],
      [entry("Missing color", { color: undefined })],
      [entry("No flag", { triggersPo: undefined })],
      [entry("String flag", { triggersPo: "true" })],
      [entry("Label", { label: 12 })],
      [
        { key: "new", label: "One", color: "lime", triggersPo: false },
        { key: "new", label: "Two", color: "lime", triggersPo: false },
      ],
    ];
    for (const body of bodies) {
      const result = await replaceStatuses(db, WS, body);
      expect(result.kind, JSON.stringify(body)?.slice(0, 80)).toBe("invalid");
    }
    expect(await statusRows(db)).toEqual(before);
  });

  it("saves each status's Shopify link and keeps a stored link when the entry leaves it out", async () => {
    const { db } = await setup();
    const result = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false, shopifyLink: "delivered" },
      // No shopifyLink: an existing status keeps its stored one.
      { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
      { key: "processing", label: "Processing", color: "blue", triggersPo: false, shopifyLink: null },
      // No shopifyLink on a new status: none.
      entry("Packed"),
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.statuses.map((s) => [s.key, s.shopifyLink])).toEqual([
      ["new", "delivered"],
      ["shipped", "fulfilled"],
      ["processing", null],
      ["packed", null],
    ]);
    expect((await statusRows(db)).map((row) => [row.key, row.shopifyLink])).toEqual([
      ["new", "delivered"],
      ["shipped", "fulfilled"],
      ["processing", null],
      ["packed", null],
    ]);
  });

  // Draft orders (spec section 8.1): Approve and Reject follow the statuses
  // linked to draft_completed and draft_rejected, one each, and a list that
  // carries them (migration 0010 links Approved and adds Rejected) saves
  // back unchanged.
  it("saves the draft order links, one status each, with the error naming every link", async () => {
    const { db } = await setup();
    const result = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false, shopifyLink: null },
      { key: "approved", label: "Approved", color: "green", triggersPo: true, shopifyLink: "draft_completed" },
      entry("Rejected", { shopifyLink: "draft_rejected" }),
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.statuses.map((s) => [s.key, s.shopifyLink])).toEqual([
      ["new", null],
      ["approved", "draft_completed"],
      ["rejected", "draft_rejected"],
    ]);
    const twice = await replaceStatuses(db, WS, [
      { key: "approved", label: "Approved", color: "green", triggersPo: true, shopifyLink: "draft_completed" },
      entry("Done", { shopifyLink: "draft_completed" }),
    ]);
    expect(twice).toEqual({ kind: "invalid", error: "Only one status can follow Draft approved; Approved and Done both do" });
    const unknown = await replaceStatuses(db, WS, [entry("Bad link", { shopifyLink: "refunded" })]);
    expect(unknown).toEqual({
      kind: "invalid",
      error: "Status 1: the Shopify link must be fulfilled, delivered, draft completed, draft rejected, cancelled or none",
    });
  });

  it("refuses an unknown Shopify link and two statuses linked to the same Shopify state", async () => {
    const { db } = await setup();
    const before = await statusRows(db);
    for (const body of [
      [entry("Bad link", { shopifyLink: "refunded" })],
      [entry("Bad link", { shopifyLink: "Fulfilled" })],
      [entry("Bad link", { shopifyLink: 1 })],
      [
        { key: "shipped", label: "Shipped", color: "violet", triggersPo: false, shopifyLink: "fulfilled" },
        entry("Also shipped", { shopifyLink: "fulfilled" }),
      ],
      // The kept link of "shipped" collides with a new one.
      [{ key: "shipped", label: "Shipped", color: "violet", triggersPo: false }, entry("Sent", { shopifyLink: "fulfilled" })],
    ]) {
      const result = await replaceStatuses(db, WS, body);
      expect(result.kind, JSON.stringify(body).slice(0, 80)).toBe("invalid");
    }
    expect(await statusRows(db)).toEqual(before);
  });

  // Comprehensive design section 2: Cancel order and Shopify's own
  // cancellations put an order in the status that follows Shopify's
  // cancelled state. One status per link, like the others.
  it("lets one status follow Shopify's cancelled state", async () => {
    const { db } = await setup();
    const result = await replaceStatuses(db, WS, [
      entry("New", { key: "new", color: "lime" }),
      entry("Cancelled", { color: "slate", shopifyLink: "cancelled" }),
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.statuses.map((s) => [s.key, s.shopifyLink])).toEqual([
      ["new", null],
      ["cancelled", "cancelled"],
    ]);
    const twice = await replaceStatuses(db, WS, [
      entry("Cancelled", { key: "cancelled", color: "slate", shopifyLink: "cancelled" }),
      entry("Void", { shopifyLink: "cancelled" }),
    ]);
    expect(twice).toEqual({
      kind: "invalid",
      error: "Only one status can follow Shopify's cancelled state; Cancelled and Void both do",
    });
  });

  // Each status is written to its Shopify order as the tag
  // "Ordering Desk: <label>", and Shopify allows 40 characters per tag, so a
  // label longer than 25 would be refused on every move into that status.
  it("trims labels and accepts 25 characters, the most a Shopify status tag leaves room for", async () => {
    const { db } = await setup();
    expect(STATUS_LABEL_MAX).toBe(25);
    const longest = "y".repeat(25);
    const result = await replaceStatuses(db, WS, [entry("  Ready  "), entry(longest)]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.statuses.map((s) => s.label)).toEqual(["Ready", longest]);
  });

  it("refuses a label longer than 25 characters, saying why", async () => {
    const { db } = await setup();
    const before = await statusRows(db);
    const result = await replaceStatuses(db, WS, [entry("Waiting on customer approval")]);
    expect(result).toEqual({
      kind: "invalid",
      error: "Status 1: the label must be 1 to 25 characters (Shopify tags hold 40, and \"Ordering Desk: \" takes 15)",
    });
    expect(await statusRows(db)).toEqual(before);
  });

  // Comprehensive desk design section 1: closed statuses leave the Open view.
  it("keeps each status's closed flag unless the list sets it, and closes a new Delivered or Rejected status", async () => {
    const { db } = await setup();
    const first = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      { key: "shipped", label: "Shipped", color: "violet", triggersPo: false, closed: true },
      entry("Delivered", { shopifyLink: "delivered" }),
      entry("On Hold"),
    ]);
    if (first.kind !== "ok") throw new Error(first.kind);
    expect(first.statuses.map((s) => [s.key, s.closed])).toEqual([
      ["new", false],
      ["shipped", true],
      ["delivered", true],
      ["on_hold", false],
    ]);

    const second = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
      { key: "delivered", label: "Delivered", color: "slate", triggersPo: false, closed: false },
      { key: "on_hold", label: "On Hold", color: "amber", triggersPo: false },
    ]);
    if (second.kind !== "ok") throw new Error(second.kind);
    expect(second.statuses.map((s) => [s.key, s.closed])).toEqual([
      ["new", false],
      ["shipped", true],
      ["delivered", false],
      ["on_hold", false],
    ]);
  });

  // Wave 1a final review: new orders and requests land in the first status,
  // so it can never be closed, whether the list marks it, keeps a stored
  // flag or moves a closed status to the top.
  it("refuses a closed first status, saying why, and changes nothing", async () => {
    const { db } = await setup();
    const before = await statusRows(db);
    const error = "New is the first status, where new orders and requests land, so it cannot be closed. Turn off Closed for it or move another status to the top.";
    expect(
      await replaceStatuses(db, WS, [
        { key: "new", label: "New", color: "lime", triggersPo: false, closed: true },
        { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
      ]),
    ).toEqual({ kind: "invalid", error });
    await db.update(schema.statuses).set({ closed: true }).where(eq(schema.statuses.id, WS + "_st_new"));
    const closedBefore = await statusRows(db);
    expect(
      await replaceStatuses(db, WS, [
        { key: "new", label: "New", color: "lime", triggersPo: false },
        { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
      ]),
    ).toEqual({ kind: "invalid", error });
    expect(await statusRows(db)).toEqual(closedBefore);
    await db.update(schema.statuses).set({ closed: false }).where(eq(schema.statuses.id, WS + "_st_new"));
    expect(await statusRows(db)).toEqual(before);
    // A closed status lower down is fine, and so is the same status once it
    // is no longer first.
    const ok = await replaceStatuses(db, WS, [
      { key: "shipped", label: "Shipped", color: "violet", triggersPo: false },
      { key: "new", label: "New", color: "lime", triggersPo: false, closed: true },
    ]);
    expect(ok.kind === "ok" ? ok.statuses.map((s) => [s.key, s.closed]) : ok).toEqual([
      ["shipped", false],
      ["new", true],
    ]);
  });

  it("refuses a closed flag that is not true or false", async () => {
    const { db } = await setup();
    expect(await replaceStatuses(db, WS, [entry("New", { closed: "yes" })])).toEqual({
      kind: "invalid",
      error: "Status 1: closed must be true or false",
    });
  });

  // A new status that follows Shopify's cancelled state starts closed, like
  // Delivered and Rejected (comprehensive design section 2).
  it("closes a new status linked to cancelled by default", async () => {
    const { db } = await setup();
    const result = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      entry("Cancelled", { shopifyLink: "cancelled" }),
    ]);
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.statuses.map((s) => [s.key, s.closed])).toEqual([
      ["new", false],
      ["cancelled", true],
    ]);
  });
});
