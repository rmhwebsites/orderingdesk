import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

// Applies the real generated migrations to an in-memory SQLite database and
// asserts the constraints the app relies on, so schema drift breaks the suite.
// Each drizzle migration chunk between statement-breakpoint markers is a single
// statement, so prepare().run() applies it.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const APP_TABLES = [
  "events",
  "locations",
  "notification_prefs",
  "orders",
  "pending_invites",
  "platform_admins",
  "purchase_orders",
  "push_subscriptions",
  "shopify_roster",
  "statuses",
  "store_connections",
  "vendors",
  "webhook_deliveries",
  "workspace_members",
  "workspace_settings",
  "workspaces",
];

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// Applies the migration files whose number passes the filter, in order.
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

describe("schema migrations", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    expect(migrationFiles().length).toBeGreaterThan(0);
    applyMigrations(db, () => true);
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws1", "Impact", "impact", "user1", 1);
  });

  afterAll(() => {
    db.close();
  });

  it("rejects an order whose workspace does not exist", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("o_fk", "ws_missing", "900", "#900", "{}", "new", 1, 1),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a duplicate status key within a workspace", () => {
    const insert = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("st1", "ws1", "new", "New", "#91d500", 0);
    expect(() => insert.run("st2", "ws1", "new", "New again", "#000000", 1)).toThrow(/UNIQUE/);
  });

  it("rejects a duplicate shopify order within a workspace", () => {
    const insert = db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("o1", "ws1", "1001", "#1001", "{}", "new", 1, 1);
    expect(() => insert.run("o2", "ws1", "1001", "#1001 dup", "{}", "new", 2, 2)).toThrow(/UNIQUE/);
  });

  it("creates every app table", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = rows.map((r) => (r as { name: string }).name);
    for (const table of APP_TABLES) {
      expect(names).toContain(table);
    }
  });

  it("accepts exactly one invite kind per pending invite", () => {
    const insert = db.prepare(
      "INSERT INTO pending_invites (id, email, workspace_id, role, platform_admin, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    // A workspace invite and a platform-admin invite are both fine.
    insert.run("inv_ws", "a@example.com", "ws1", "staff", 0, "user1", 1);
    insert.run("inv_pa", "a@example.com", null, null, 1, "user1", 1);
    // Neither kind, both kinds, or half of one are refused.
    const refused: Array<[string, string, string | null, string | null, number]> = [
      ["inv_none", "b@example.com", null, null, 0],
      ["inv_both", "b@example.com", "ws1", "staff", 1],
      ["inv_no_role", "b@example.com", "ws1", null, 0],
      ["inv_pa_role", "b@example.com", null, "manager", 1],
    ];
    for (const [id, email, workspaceId, role, platformAdmin] of refused) {
      expect(() => insert.run(id, email, workspaceId, role, platformAdmin, "user1", 1), id).toThrow(/CHECK/);
    }
  });

  it("allows one pending platform-admin invite per email", () => {
    const insert = db.prepare(
      "INSERT INTO pending_invites (id, email, workspace_id, role, platform_admin, invited_by, created_at) VALUES (?, ?, NULL, NULL, 1, ?, ?)",
    );
    insert.run("pa1", "c@example.com", "user1", 1);
    expect(() => insert.run("pa2", "c@example.com", "user1", 2)).toThrow(/UNIQUE/);
  });

  it("keeps one roster entry per workspace and email", () => {
    const insert = db.prepare(
      "INSERT INTO shopify_roster (id, workspace_id, email, role, shopify_customer_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("r1", "ws1", "d@example.com", "staff", "c1", 1);
    expect(() => insert.run("r2", "ws1", "d@example.com", "manager", "c2", 2)).toThrow(/UNIQUE/);
  });

  // A storefront form can tag a customer, so a tag only asks for access: a
  // new roster row is unapproved until a manager approves it (migration 0006).
  it("creates roster entries unapproved and not denied", () => {
    db.prepare(
      "INSERT INTO shopify_roster (id, workspace_id, email, role, shopify_customer_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("r_new", "ws1", "e@example.com", "manager", "c9", 1);
    expect(
      db.prepare("SELECT approved_role, approved_at, approved_by, denied_at FROM shopify_roster WHERE id = ?").get("r_new"),
    ).toEqual({ approved_role: null, approved_at: null, approved_by: null, denied_at: null });
  });

  // Migration 0007: orders start unclaimed for the new-order notification,
  // and a push subscription records the host it was made on (null = hub).
  it("stores orders unnotified and push subscriptions with an optional host", () => {
    db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("o_notify", "ws1", "7001", "#7001", "{}", "new", 1, 1);
    expect(db.prepare("SELECT notified_at FROM orders WHERE id = ?").get("o_notify")).toEqual({ notified_at: null });

    const insert = db.prepare(
      "INSERT INTO push_subscriptions (id, user_id, endpoint, keys, created_at, host) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("ps1", "user1", "https://push.example/1", "{}", 1, null);
    insert.run("ps2", "user1", "https://push.example/2", "{}", 1, "orders.example.com");
    expect(db.prepare("SELECT host FROM push_subscriptions ORDER BY id").all()).toEqual([
      { host: null },
      { host: "orders.example.com" },
    ]);
    expect(() => insert.run("ps3", "user2", "https://push.example/1", "{}", 1, null)).toThrow(/UNIQUE/);
  });

  // Migration 0008: a store connection starts with no order history import
  // (status null, nothing imported), and rows written before it read the
  // same way.
  it("starts store connections with no order history import", () => {
    db.prepare("INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(
      "ws_backfill",
      "Backfill",
      "backfill",
      "user1",
      1,
    );
    db.prepare("INSERT INTO store_connections (workspace_id, shop_domain, encrypted_token) VALUES (?, ?, ?)").run(
      "ws_backfill",
      "backfill.myshopify.com",
      "v1.x",
    );
    expect(
      db
        .prepare(
          "SELECT backfill_status, backfill_since, backfill_cursor, backfill_imported, backfill_started_at, backfill_finished_at, backfill_error FROM store_connections WHERE workspace_id = ?",
        )
        .get("ws_backfill"),
    ).toEqual({
      backfill_status: null,
      backfill_since: null,
      backfill_cursor: null,
      backfill_imported: 0,
      backfill_started_at: null,
      backfill_finished_at: null,
      backfill_error: null,
    });
  });

  // Migration 0009: a purchase order written without the send columns (as
  // before it) reads as never sent, in USD, with no failure and no lease;
  // PO numbers stay unique per workspace.
  it("defaults the purchase order send columns and keeps PO numbers unique per workspace", () => {
    const insert = db.prepare(
      "INSERT INTO purchase_orders (id, workspace_id, order_id, vendor_id, po_number, line_items, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("po1", "ws1", "o1", "v1", "PO-2026-0001", "[]", "user1", 1);
    expect(
      db
        .prepare(
          "SELECT status, currency, last_error, send_started_at, send_attempt, sent_to, sent_by, send_count, updated_at FROM purchase_orders WHERE id = ?",
        )
        .get("po1"),
    ).toEqual({
      status: "draft",
      currency: "USD",
      last_error: null,
      send_started_at: null,
      send_attempt: null,
      sent_to: null,
      sent_by: null,
      send_count: 0,
      updated_at: null,
    });
    expect(() => insert.run("po2", "ws1", "o1", "v1", "PO-2026-0001", "[]", "user1", 1)).toThrow(/UNIQUE/);
  });

  it("keeps custom domains unique and allows any number of workspaces without one", () => {
    const insert = db.prepare(
      "INSERT INTO workspaces (id, name, slug, created_by, created_at, custom_domain) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("ws_d1", "D1", "d1", "user1", 1, "orders.example.com");
    insert.run("ws_n1", "N1", "n1", "user1", 1, null);
    insert.run("ws_n2", "N2", "n2", "user1", 1, null);
    expect(() => insert.run("ws_d2", "D2", "d2", "user1", 1, "orders.example.com")).toThrow(/UNIQUE/);
  });

  it("defaults new columns for rows written without them", () => {
    db.prepare(
      "INSERT INTO store_connections (workspace_id, shop_domain, encrypted_token) VALUES (?, ?, ?)",
    ).run("ws1", "impact.myshopify.com", "v1.x");
    expect(
      db
        .prepare("SELECT auth_mode, client_id, scopes, shop_name FROM store_connections WHERE workspace_id = ?")
        .get("ws1"),
    ).toEqual({ auth_mode: "legacy_token", client_id: null, scopes: null, shop_name: null });

    db.prepare(
      "INSERT INTO events (id, workspace_id, type, text, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("e1", "ws1", "note", "hello", 1);
    expect(db.prepare("SELECT source FROM events WHERE id = ?").get("e1")).toEqual({ source: "app" });

    db.prepare(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)",
    ).run("m1", "ws1", "user1", "staff");
    expect(db.prepare("SELECT source FROM workspace_members WHERE id = ?").get("m1")).toEqual({
      source: "manual",
    });
  });

  // Schema-vs-migration drift guard: selects every column of every exported
  // table (app + auth) through drizzle against the migrated database. A
  // column that exists in schema.ts but not in the migrations throws "no
  // such column"; a table missing from the migrations throws "no such table".
  it("matches every exported table and column to the migrations", () => {
    const tables = (Object.values(schema) as unknown[]).filter(
      (value): value is SQLiteTable => is(value, SQLiteTable),
    );
    // 17 app tables (invite_sends since 0005, locations since 0012) +
    // user/session/account/verification + rate_limit.
    expect(tables.length).toBe(22);
    const orm = drizzle(db);
    for (const table of tables) {
      expect(() => orm.select().from(table).all()).not.toThrow();
    }
    // And the other way: every physical column, in the physical order, is a
    // column of the schema (a hand-written migration step cannot add one the
    // schema does not declare). Order matters for the orders table: its
    // positional insert-selects rely on it (rebuilt in 0010).
    for (const table of tables) {
      const name = getTableName(table);
      const physical = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((column) => column.name);
      const declared = Object.values(getTableColumns(table)).map((column) => column.name);
      expect(physical, name).toEqual(name === "orders" || name === "events" ? declared : expect.arrayContaining(declared));
      expect(physical.length, name).toBe(declared.length);
    }
  });

  // Migration 0010 (draft orders): a draft card has no order id yet, and
  // every row names at least one of the two ids.
  it("stores draft cards without an order id and refuses rows with neither id", () => {
    const insert = db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, shopify_draft_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("o_draft_1", "ws1", null, "8001", "#D1", "{}", "new", 1, 1);
    insert.run("o_draft_2", "ws1", null, "8002", "#D2", "{}", "new", 1, 1);
    expect(() => insert.run("o_draft_dup", "ws1", null, "8001", "#D1", "{}", "new", 1, 1)).toThrow(/UNIQUE/);
    expect(() => insert.run("o_neither", "ws1", null, null, "#X", "{}", "new", 1, 1)).toThrow(/CHECK/);
    expect(
      db
        .prepare("SELECT draft_last_sync_at, draft_checked_at, draft_sync_cursor, canonical_shop_domain FROM store_connections WHERE workspace_id = ?")
        .get("ws1"),
    ).toEqual({ draft_last_sync_at: 0, draft_checked_at: 0, draft_sync_cursor: null, canonical_shop_domain: null });
  });

  // Migration 0012 (locations, editing requests, cancel): one row per
  // Shopify company location and workspace, active unless Shopify dropped
  // it, cards that do not know their location yet, and connections whose
  // location sync never ran.
  it("stores company locations once per workspace and starts cards without a location", () => {
    expect(db.prepare("SELECT locations_synced_at FROM store_connections WHERE workspace_id = ?").get("ws1")).toEqual({
      locations_synced_at: null,
    });
    const insert = db.prepare(
      "INSERT INTO locations (id, workspace_id, shopify_location_id, company_id, name, address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("loc1", "ws1", "101", "7", "Buford HQ", JSON.stringify({ address1: "100 Example Way" }), 1);
    insert.run("loc2", "ws1", "102", "7", "Mableton", null, 1);
    expect(() => insert.run("loc3", "ws1", "101", "7", "Buford again", null, 2)).toThrow(/UNIQUE/);
    expect(() => insert.run("loc4", "ws_missing", "103", null, "Nowhere", null, 2)).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT active, company_id FROM locations WHERE id = ?").get("loc1")).toEqual({ active: 1, company_id: "7" });
    db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("o_loc", "ws1", "7101", "#7101", "{}", "new", 1, 1);
    expect(db.prepare("SELECT location_id FROM orders WHERE id = ?").get("o_loc")).toEqual({ location_id: null });
  });
});

// The platform migration converts production data in place: the one
// workspace, its owner, its statuses and any pending invites. This replays
// that on a database migrated only through 0003 and holding rows in the old
// shape, then applies everything newer.
describe("platform migration of existing rows", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, (file) => file.slice(0, 4) <= "0003");

    db.prepare(
      "INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws_impact", "Impact Rentals", "impact-rentals", "u_ryan", 1);
    db.prepare(
      "INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("ws_custom", "Custom", "custom", "u_ryan", 1);
    const member = db.prepare(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)",
    );
    member.run("m_owner", "ws_impact", "u_ryan", "owner");
    member.run("m_admin", "ws_impact", "u_admin", "admin");
    member.run("m_member", "ws_impact", "u_member", "member");
    const invite = db.prepare(
      "INSERT INTO pending_invites (id, email, workspace_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    invite.run("i_admin", "lead@example.com", "ws_impact", "admin", "u_ryan", 5);
    invite.run("i_member", "crew@example.com", "ws_impact", "member", "u_ryan", 6);
    const status = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort, triggers_po) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const defaults = [
      ["new", "New", "lime", 0, 0],
      ["processing", "Processing", "blue", 1, 0],
      ["on_hold", "On Hold", "amber", 2, 0],
      ["approved", "Approved", "green", 3, 1],
      ["shipped", "Shipped", "violet", 4, 0],
      ["delivered", "Delivered", "slate", 5, 0],
      ["issue", "Issue", "red", 6, 0],
    ] as const;
    for (const [key, label, color, sort, triggersPo] of defaults) {
      status.run(`ws_impact_${key}`, "ws_impact", key, label, color, sort, triggersPo);
    }
    // A workspace that renamed its statuses: only the keys decide.
    status.run("ws_custom_sent", "ws_custom", "sent", "Shipped", "violet", 0, 0);
    db.prepare(
      "INSERT INTO workspace_settings (workspace_id, notification_emails, po_prefix, reply_to, from_name) VALUES (?, ?, ?, ?, ?)",
    ).run("ws_impact", '["ops@example.com"]', "IMP", "ops@example.com", "IMPACT Rentals");
    db.prepare(
      "INSERT INTO store_connections (workspace_id, shop_domain, encrypted_token, last_sync_at) VALUES (?, ?, ?, ?)",
    ).run("ws_impact", "impactrentals.myshopify.com", "v1.ciphertext", 1234);
    const event = db.prepare(
      "INSERT INTO events (id, workspace_id, order_id, type, text, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    event.run("e_new", "ws_impact", "o1", "order_new", "New order #1", null, 1);
    event.run("e_err", "ws_impact", null, "sync_error", "Shopify said no", null, 2);
    event.run("e_status", "ws_impact", "o1", "status", "Moved to Shipped", "u_ryan", 3);

    applyMigrations(db, (file) => file.slice(0, 4) > "0003");
  });

  afterAll(() => {
    db.close();
  });

  it("maps owner and admin to manager and member to staff, as manual memberships", () => {
    expect(
      db.prepare("SELECT id, role, source FROM workspace_members ORDER BY id").all(),
    ).toEqual([
      { id: "m_admin", role: "manager", source: "manual" },
      { id: "m_member", role: "staff", source: "manual" },
      { id: "m_owner", role: "manager", source: "manual" },
    ]);
  });

  it("maps pending invite roles and keeps them as workspace invites", () => {
    expect(
      db
        .prepare(
          "SELECT id, email, workspace_id, role, platform_admin, invited_by, created_at FROM pending_invites ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "i_admin",
        email: "lead@example.com",
        workspace_id: "ws_impact",
        role: "manager",
        platform_admin: 0,
        invited_by: "u_ryan",
        created_at: 5,
      },
      {
        id: "i_member",
        email: "crew@example.com",
        workspace_id: "ws_impact",
        role: "staff",
        platform_admin: 0,
        invited_by: "u_ryan",
        created_at: 6,
      },
    ]);
  });

  // 0004 links the shipped and delivered keys; 0010 (draft orders) links
  // the approved key to draft_completed and adds a Rejected status last;
  // 0011 closes Delivered and Rejected; 0012 adds a closed Cancelled last.
  it("links the shipped and delivered status keys to their Shopify states, and the draft outcomes", () => {
    expect(
      db
        .prepare("SELECT workspace_id, key, label, sort, shopify_link, closed FROM statuses ORDER BY workspace_id, sort")
        .all(),
    ).toEqual([
      { workspace_id: "ws_custom", key: "sent", label: "Shipped", sort: 0, shopify_link: null, closed: 0 },
      { workspace_id: "ws_custom", key: "rejected", label: "Rejected", sort: 1, shopify_link: "draft_rejected", closed: 1 },
      { workspace_id: "ws_custom", key: "cancelled", label: "Cancelled", sort: 2, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_impact", key: "new", label: "New", sort: 0, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "processing", label: "Processing", sort: 1, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "on_hold", label: "On Hold", sort: 2, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "approved", label: "Approved", sort: 3, shopify_link: "draft_completed", closed: 0 },
      { workspace_id: "ws_impact", key: "shipped", label: "Shipped", sort: 4, shopify_link: "fulfilled", closed: 0 },
      { workspace_id: "ws_impact", key: "delivered", label: "Delivered", sort: 5, shopify_link: "delivered", closed: 1 },
      { workspace_id: "ws_impact", key: "issue", label: "Issue", sort: 6, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "rejected", label: "Rejected", sort: 7, shopify_link: "draft_rejected", closed: 1 },
      { workspace_id: "ws_impact", key: "cancelled", label: "Cancelled", sort: 8, shopify_link: "cancelled", closed: 1 },
    ]);
  });

  // 0011 (work queue) closes Delivered and Rejected; 0012 adds a closed
  // Cancelled.
  it("closes the delivered and rejected statuses", () => {
    expect(db.prepare("SELECT workspace_id, key FROM statuses WHERE closed = 1 ORDER BY workspace_id, key").all()).toEqual([
      { workspace_id: "ws_custom", key: "cancelled" },
      { workspace_id: "ws_custom", key: "rejected" },
      { workspace_id: "ws_impact", key: "cancelled" },
      { workspace_id: "ws_impact", key: "delivered" },
      { workspace_id: "ws_impact", key: "rejected" },
    ]);
  });

  it("keeps the workspace settings as they were", () => {
    expect(db.prepare("SELECT * FROM workspace_settings").all()).toEqual([
      {
        workspace_id: "ws_impact",
        notification_emails: '["ops@example.com"]',
        po_prefix: "IMP",
        reply_to: "ops@example.com",
        from_name: "IMPACT Rentals",
        age_amber_days: 2,
        age_red_days: 4,
        price_display: "auto",
      },
    ]);
  });

  it("keeps the store connection as a legacy token connection", () => {
    expect(
      db
        .prepare(
          "SELECT shop_domain, encrypted_token, auth_mode, encrypted_access_token, last_sync_at, backfill_status, backfill_imported FROM store_connections",
        )
        .all(),
    ).toEqual([
      {
        shop_domain: "impactrentals.myshopify.com",
        encrypted_token: "v1.ciphertext",
        auth_mode: "legacy_token",
        encrypted_access_token: null,
        last_sync_at: 1234,
        backfill_status: null,
        backfill_imported: 0,
      },
    ]);
  });

  it("labels existing events by where they came from", () => {
    expect(db.prepare("SELECT id, source FROM events ORDER BY id").all()).toEqual([
      { id: "e_err", source: "system" },
      { id: "e_new", source: "shopify" },
      { id: "e_status", source: "app" },
    ]);
  });

  it("leaves the workspace branding, domain and sender unset", () => {
    expect(
      db
        .prepare(
          "SELECT custom_domain, custom_domain_status, sending_address, sending_verified_at, roster_tags, branding FROM workspaces WHERE id = ?",
        )
        .get("ws_impact"),
    ).toEqual({
      custom_domain: null,
      custom_domain_status: null,
      sending_address: null,
      sending_verified_at: null,
      roster_tags: null,
      branding: null,
    });
  });
});
