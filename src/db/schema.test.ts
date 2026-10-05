import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
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

  it("creates all 15 app tables", () => {
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
    // 16 app tables (invite_sends since 0005) + user/session/account/
    // verification + rate_limit.
    expect(tables.length).toBe(21);
    const orm = drizzle(db);
    for (const table of tables) {
      expect(() => orm.select().from(table).all()).not.toThrow();
    }
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

  it("links the shipped and delivered status keys to their Shopify states, and nothing else", () => {
    expect(
      db.prepare("SELECT id, label, shopify_link FROM statuses ORDER BY workspace_id, sort").all(),
    ).toEqual([
      { id: "ws_custom_sent", label: "Shipped", shopify_link: null },
      { id: "ws_impact_new", label: "New", shopify_link: null },
      { id: "ws_impact_processing", label: "Processing", shopify_link: null },
      { id: "ws_impact_on_hold", label: "On Hold", shopify_link: null },
      { id: "ws_impact_approved", label: "Approved", shopify_link: null },
      { id: "ws_impact_shipped", label: "Shipped", shopify_link: "fulfilled" },
      { id: "ws_impact_delivered", label: "Delivered", shopify_link: "delivered" },
      { id: "ws_impact_issue", label: "Issue", shopify_link: null },
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
