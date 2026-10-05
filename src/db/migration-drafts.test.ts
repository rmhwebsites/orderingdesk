import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Migration 0010 (draft orders spec section 2): the orders table is rebuilt
// so shopify_order_id can be null while a card is still a draft, four draft
// columns are added, store_connections gains the draft cursor columns and
// the store's own myshopify domain (canonical_shop_domain), Approved is
// linked to draft_completed and a Rejected status is added where there is
// room. Production data has to come through whole: this replays it on a
// database migrated through 0009 and holding rows in the old shape, then
// applies 0010.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations(db: Database, include: (file: string) => boolean) {
  for (const file of migrationFiles().filter(include)) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        db.prepare(trimmed).run();
      }
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const DEFAULTS = [
  ["new", "New", "lime", 0, 0, null],
  ["processing", "Processing", "blue", 1, 0, null],
  ["on_hold", "On Hold", "amber", 2, 0, null],
  ["approved", "Approved", "green", 3, 1, null],
  ["shipped", "Shipped", "violet", 4, 0, "fulfilled"],
  ["delivered", "Delivered", "slate", 5, 0, "delivered"],
  ["issue", "Issue", "red", 6, 0, null],
] as const;

describe("migration 0010 on rows in the 0009 shape", () => {
  let db: Database;
  let ordersBefore: unknown[];
  let eventsBefore: unknown[];
  let posBefore: unknown[];
  let connectionsBefore: unknown[];

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    expect(migrationFiles().some((file) => file.startsWith("0010_"))).toBe(true);
    applyMigrations(db, (file) => file.slice(0, 4) <= "0009");

    const workspace = db.prepare(
      "INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const id of ["ws_a", "ws_full", "ws_rej", "ws_linked", "ws_empty", "ws_custom"]) {
      workspace.run(id, "Workspace " + id, id, "u_ryan", 1);
    }
    const status = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort, triggers_po, shopify_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const [key, label, color, sort, triggersPo, link] of DEFAULTS) {
      status.run(`ws_a_${key}`, "ws_a", key, label, color, sort, triggersPo, link);
    }
    // Already at STATUS_LIST_MAX (20): Approved is linked, nothing is added.
    for (let i = 0; i < 20; i++) {
      const key = i === 3 ? "approved" : `s${i}`;
      status.run(`ws_full_${key}`, "ws_full", key, key === "approved" ? "Approved" : `Step ${i}`, "blue", i * 10, 0, null);
    }
    // Has its own rejected key: no second one.
    status.run("ws_rej_new", "ws_rej", "new", "New", "lime", 0, 0, null);
    status.run("ws_rej_rejected", "ws_rej", "rejected", "Declined", "red", 5, 0, null);
    // Something already follows draft_completed: Approved stays unlinked.
    status.run("ws_linked_approved", "ws_linked", "approved", "Approved", "green", 0, 1, null);
    status.run("ws_linked_done", "ws_linked", "done", "Done", "green", 1, 0, "draft_completed");
    // An Approved already linked to a Shopify state is left alone.
    status.run("ws_custom_approved", "ws_custom", "approved", "Approved", "green", 2, 0, "fulfilled");

    const order = db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, status_set_by, status_set_at, created_at, synced_at, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    order.run("o1", "ws_a", "7001", "#1001", '{"name":"#1001","tags":"Ordering Desk: Approved"}', "approved", "u_ryan", 50, 10, 60, 70);
    order.run("o2", "ws_a", "7002", "#1002", '{"name":"#1002"}', "new", null, null, 11, 61, null);
    order.run("o3", "ws_custom", "7001", "#1001", "{}", "approved", null, 40, 12, 62, 72);

    const event = db.prepare(
      "INSERT INTO events (id, workspace_id, order_id, type, text, actor_id, meta, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    event.run("e1", "ws_a", "o1", "order_new", "New order #1001", null, '{"orderName":"#1001"}', 10, "shopify");
    event.run("e2", "ws_a", "o1", "note", "Call the branch", "u_ryan", null, 20, "app");
    event.run("e3", "ws_a", "o2", "status", "Status set to New", "u_ryan", '{"from":"x","to":"new"}', 30, "app");

    db.prepare(
      "INSERT INTO purchase_orders (id, workspace_id, order_id, vendor_id, po_number, line_items, created_by, created_at, status, send_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("po1", "ws_a", "o1", "v1", "PO-2026-0001", "[]", "u_ryan", 80, "sent", 1);

    db.prepare(
      "INSERT INTO store_connections (workspace_id, shop_domain, encrypted_token, last_sync_at, sync_cursor, sync_cursor_since) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("ws_a", "impactrentals.myshopify.com", "", 1234, "99|abc", 1000);

    ordersBefore = db.prepare("SELECT * FROM orders ORDER BY id").all();
    eventsBefore = db.prepare("SELECT * FROM events ORDER BY id").all();
    posBefore = db.prepare("SELECT * FROM purchase_orders ORDER BY id").all();
    connectionsBefore = db.prepare("SELECT * FROM store_connections ORDER BY workspace_id").all();

    applyMigrations(db, (file) => file.slice(0, 4) === "0010");
  });

  afterAll(() => {
    db.close();
  });

  it("keeps every order row and column, with the draft columns empty", () => {
    const after = db.prepare("SELECT * FROM orders ORDER BY id").all() as Record<string, unknown>[];
    expect(after).toHaveLength(ordersBefore.length);
    expect(after).toEqual(
      ordersBefore.map((row) => ({
        ...(row as Record<string, unknown>),
        shopify_draft_id: null,
        draft_name: null,
        draft_snapshot: null,
        draft_deleted_at: null,
      })),
    );
  });

  it("keeps the physical column order the positional insert-selects rely on", () => {
    const columns = (db.prepare("PRAGMA table_info(orders)").all() as { name: string; notnull: number }[]).map(
      (column) => [column.name, column.notnull],
    );
    expect(columns).toEqual([
      ["id", 1],
      ["workspace_id", 1],
      ["shopify_order_id", 0],
      ["name", 1],
      ["shopify", 1],
      ["status_key", 1],
      ["status_set_by", 0],
      ["status_set_at", 0],
      ["created_at", 1],
      ["synced_at", 1],
      ["notified_at", 0],
      ["shopify_draft_id", 0],
      ["draft_name", 0],
      ["draft_snapshot", 0],
      ["draft_deleted_at", 0],
    ]);
  });

  it("leaves events, purchase orders and the connection exactly as they were", () => {
    expect(db.prepare("SELECT * FROM events ORDER BY id").all()).toEqual(eventsBefore);
    expect(db.prepare("SELECT * FROM purchase_orders ORDER BY id").all()).toEqual(posBefore);
    expect(db.prepare("SELECT * FROM store_connections ORDER BY workspace_id").all()).toEqual(
      connectionsBefore.map((row) => ({
        ...(row as Record<string, unknown>),
        draft_sync_cursor: null,
        draft_sync_cursor_since: null,
        draft_last_sync_at: 0,
        draft_checked_at: 0,
        // The store's own myshopify domain: unknown until the connection is
        // saved or refreshed (webhooks name the store by it).
        canonical_shop_domain: null,
      })),
    );
  });

  it("passes the foreign key check and keeps every orders index", () => {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orders' AND sql IS NOT NULL ORDER BY name")
      .all() as { name: string; sql: string }[];
    expect(indexes.map((index) => index.name)).toEqual([
      "order_draft_unique",
      "order_open_drafts",
      "order_unique",
      "order_ws_created",
      "order_ws_status",
    ]);
    for (const index of indexes) {
      expect(index.sql).not.toContain("__new_orders");
    }
    expect(indexes.find((index) => index.name === "order_open_drafts")?.sql).toMatch(/WHERE shopify_order_id is null$/i);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get() as { sql: string };
    expect(table.sql).not.toContain("__new_orders");
  });

  it("accepts open drafts with no order id and refuses rows with neither id or a duplicate draft", () => {
    const insert = db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, shopify_draft_id, draft_name, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("d1", "ws_a", null, "9001", "#D1", "#D1", "{}", "new", 1, 1);
    insert.run("d2", "ws_a", null, "9002", "#D2", "#D2", "{}", "new", 1, 1);
    // The same draft id in another workspace is another store's draft.
    insert.run("d3", "ws_custom", null, "9001", "#D1", "#D1", "{}", "new", 1, 1);
    expect(() => insert.run("d4", "ws_a", null, "9001", "#D1", "#D1", "{}", "new", 1, 1)).toThrow(/UNIQUE/);
    expect(() => insert.run("d5", "ws_a", null, null, null, "#X", "{}", "new", 1, 1)).toThrow(/CHECK/);
    expect(() => insert.run("d6", "ws_a", "7001", null, null, "#1001", "{}", "new", 1, 1)).toThrow(/UNIQUE/);
    expect(() => insert.run("d7", "ws_missing", null, "9100", "#D9", "#D9", "{}", "new", 1, 1)).toThrow(/FOREIGN KEY/);
    // An attached draft row carries both ids.
    insert.run("d8", "ws_a", "7003", "9003", "#D3", "#1003", "{}", "new", 1, 1);
  });

  it("links Approved to draft_completed only where nothing follows it yet", () => {
    const linkOf = (id: string) =>
      (db.prepare("SELECT shopify_link FROM statuses WHERE id = ?").get(id) as { shopify_link: string | null }).shopify_link;
    expect(linkOf("ws_a_approved")).toBe("draft_completed");
    expect(linkOf("ws_full_approved")).toBe("draft_completed");
    expect(linkOf("ws_linked_approved")).toBeNull();
    expect(linkOf("ws_linked_done")).toBe("draft_completed");
    expect(linkOf("ws_custom_approved")).toBe("fulfilled");
    // Nothing else moved.
    expect(linkOf("ws_a_shipped")).toBe("fulfilled");
    expect(linkOf("ws_a_delivered")).toBe("delivered");
    expect(linkOf("ws_a_new")).toBeNull();
  });

  it("adds a pink Rejected status last where there is room and none yet", () => {
    const rejected = db
      .prepare("SELECT id, workspace_id, key, label, color, sort, triggers_po, shopify_link FROM statuses WHERE shopify_link = 'draft_rejected' ORDER BY workspace_id")
      .all() as Record<string, unknown>[];
    expect(rejected.map((row) => row.workspace_id)).toEqual(["ws_a", "ws_custom", "ws_empty", "ws_linked"]);
    for (const row of rejected) {
      expect(row.id).toMatch(UUID);
      expect(row).toMatchObject({ key: "rejected", label: "Rejected", color: "pink", triggers_po: 0 });
    }
    const sortIn = (ws: string) => rejected.find((row) => row.workspace_id === ws)?.sort;
    expect(sortIn("ws_a")).toBe(7);
    expect(sortIn("ws_custom")).toBe(3);
    expect(sortIn("ws_empty")).toBe(0);
    expect(sortIn("ws_linked")).toBe(2);
    expect(new Set(rejected.map((row) => row.id)).size).toBe(rejected.length);
    expect((db.prepare("SELECT count(*) AS n FROM statuses WHERE workspace_id = 'ws_full'").get() as { n: number }).n).toBe(20);
    expect(db.prepare("SELECT key, label FROM statuses WHERE workspace_id = 'ws_rej' ORDER BY sort").all()).toEqual([
      { key: "new", label: "New" },
      { key: "rejected", label: "Declined" },
    ]);
  });

  it("defers foreign keys the way D1 allows, never switching them off", () => {
    const file = migrationFiles().find((name) => name.startsWith("0010_"));
    const sql = readFileSync(join(migrationsDir, file as string), "utf8");
    expect(sql).toContain("PRAGMA defer_foreign_keys = on;");
    expect(sql).not.toMatch(/PRAGMA foreign_keys/i);
  });
});
