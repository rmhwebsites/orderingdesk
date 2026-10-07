import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Migration 0012 (comprehensive design section 2) on rows in the 0011
// shape: a closed Cancelled status linked to Shopify's cancelled state at
// the end of every workspace that has room and none yet; orders keep every
// column and start without a location; the locations table starts empty.
// Production applies it with `npm run db:migrate:remote` before the code
// that reads orders.location_id is deployed.

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

describe("migration 0012 on rows in the 0011 shape", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    expect(migrationFiles().some((file) => file.startsWith("0012_"))).toBe(true);
    applyMigrations(db, (file) => file.slice(0, 4) <= "0011");

    const workspace = db.prepare("INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const id of ["ws_a", "ws_full", "ws_named", "ws_linked", "ws_empty"]) {
      workspace.run(id, id, id, "u_owner", 1);
    }
    const status = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort, triggers_po, shopify_link, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // ws_a: the production list after 0011 (Delivered and Rejected closed).
    const list: Array<[string, string, string, string | null, number]> = [
      ["new", "New", "lime", null, 0],
      ["processing", "Processing", "blue", null, 0],
      ["on_hold", "On Hold", "amber", null, 0],
      ["approved", "Approved", "green", "draft_completed", 0],
      ["shipped", "Shipped", "violet", "fulfilled", 0],
      ["delivered", "Delivered", "slate", "delivered", 1],
      ["issue", "Issue", "red", null, 0],
      ["rejected", "Rejected", "pink", "draft_rejected", 1],
    ];
    list.forEach(([key, label, color, link, closed], sort) =>
      status.run(`ws_a_${key}`, "ws_a", key, label, color, sort, key === "approved" ? 1 : 0, link, closed),
    );
    for (let sort = 0; sort < 20; sort++) {
      status.run(`ws_full_${sort}`, "ws_full", `s${sort}`, `S${sort}`, "slate", sort, 0, null, 0);
    }
    status.run("ws_named_c", "ws_named", "cancelled", "Called off", "red", 0, 0, null, 0);
    status.run("ws_linked_v", "ws_linked", "void", "Void", "slate", 3, 0, "cancelled", 1);

    db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("o1", "ws_a", "1001", "#1001", '{"kind":"order"}', "new", 1, 2);
    db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, shopify_draft_id, name, shopify, status_key, created_at, synced_at, draft_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("d1", "ws_a", null, "12", "#D12", '{"kind":"draft","location":"Buford, GA"}', "new", 3, 4, "#D12");

    applyMigrations(db, (file) => file.slice(0, 4) === "0012");
  });

  afterAll(() => {
    db.close();
  });

  it("adds a closed Cancelled status last to every workspace with room and none yet", () => {
    expect(
      db
        .prepare(
          "SELECT workspace_id, key, label, color, sort, triggers_po, shopify_link, closed FROM statuses WHERE key = 'cancelled' OR shopify_link = 'cancelled' ORDER BY workspace_id",
        )
        .all(),
    ).toEqual([
      { workspace_id: "ws_a", key: "cancelled", label: "Cancelled", color: "slate", sort: 8, triggers_po: 0, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_empty", key: "cancelled", label: "Cancelled", color: "slate", sort: 0, triggers_po: 0, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_linked", key: "void", label: "Void", color: "slate", sort: 3, triggers_po: 0, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_named", key: "cancelled", label: "Called off", color: "red", sort: 0, triggers_po: 0, shopify_link: null, closed: 0 },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM statuses WHERE workspace_id = 'ws_full'").get()).toEqual({ n: 20 });
    const added = db
      .prepare("SELECT id FROM statuses WHERE key = 'cancelled' AND workspace_id IN ('ws_a', 'ws_empty')")
      .all() as { id: string }[];
    expect(added).toHaveLength(2);
    for (const { id } of added) {
      expect(id).toMatch(UUID);
    }
  });

  it("keeps every order and its columns, with no location yet, and starts with no locations", () => {
    expect(
      db.prepare("SELECT id, name, status_key, created_at, synced_at, draft_name, location_id FROM orders ORDER BY id").all(),
    ).toEqual([
      { id: "d1", name: "#D12", status_key: "new", created_at: 3, synced_at: 4, draft_name: "#D12", location_id: null },
      { id: "o1", name: "#1001", status_key: "new", created_at: 1, synced_at: 2, draft_name: null, location_id: null },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM locations").get()).toEqual({ n: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
