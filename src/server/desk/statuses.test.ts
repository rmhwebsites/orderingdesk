import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { STATUS_COLORS, STATUS_LIST_MAX, replaceStatuses } from "./statuses";
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
        { key: "approved", label: "Approved for PO", color: "teal", sort: 0, triggersPo: false, shopifyLink: null },
        { key: "new", label: "Fresh", color: "pink", sort: 1, triggersPo: true, shopifyLink: null },
        { key: "waiting_on_parts", label: "Waiting on Parts", color: "amber", sort: 2, triggersPo: false, shopifyLink: null },
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
      [entry("x".repeat(41))],
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

  it("refuses an unknown Shopify link and two statuses linked to the same Shopify state", async () => {
    const { db } = await setup();
    const before = await statusRows(db);
    for (const body of [
      [entry("Bad link", { shopifyLink: "cancelled" })],
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

  it("trims labels and accepts 40 characters", async () => {
    const { db } = await setup();
    const forty = "y".repeat(40);
    const result = await replaceStatuses(db, WS, [entry("  Ready  "), entry(forty)]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.statuses.map((s) => s.label)).toEqual(["Ready", forty]);
  });
});
