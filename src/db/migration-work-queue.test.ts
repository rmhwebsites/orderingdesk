import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Migration 0011 (work queue, comprehensive desk design section 1): statuses
// gain closed, with Delivered and Rejected closed in every existing
// workspace (by Shopify link, or by key where a workspace unlinked them),
// and workspace_settings gains the age thresholds and the price display.
// Replayed on rows in the 0010 shape.

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

describe("migration 0011 on rows in the 0010 shape", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    expect(migrationFiles().some((file) => file.startsWith("0011_"))).toBe(true);
    applyMigrations(db, (file) => file.slice(0, 4) <= "0010");

    const workspace = db.prepare("INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)");
    workspace.run("ws_impact", "Impact", "impact", "u1", 1);
    workspace.run("ws_custom", "Custom", "custom", "u1", 1);
    const status = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort, triggers_po, shopify_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const impact = [
      ["new", "New", "lime", 0, 0, null],
      ["approved", "Approved", "green", 1, 1, "draft_completed"],
      ["shipped", "Shipped", "violet", 2, 0, "fulfilled"],
      ["delivered", "Delivered", "slate", 3, 0, "delivered"],
      ["rejected", "Rejected", "pink", 4, 0, "draft_rejected"],
    ] as const;
    for (const [key, label, color, sort, po, link] of impact) {
      status.run(`ws_impact_${key}`, "ws_impact", key, label, color, sort, po, link);
    }
    // A workspace that renamed and relinked: "done" follows delivered,
    // "rejected" lost its link, "archive" is closed by nothing.
    status.run("ws_custom_done", "ws_custom", "done", "Done", "slate", 0, 0, "delivered");
    status.run("ws_custom_rejected", "ws_custom", "rejected", "Declined", "pink", 1, 0, null);
    status.run("ws_custom_archive", "ws_custom", "archive", "Archive", "slate", 2, 0, null);
    db.prepare("INSERT INTO workspace_settings (workspace_id, notification_emails, po_prefix) VALUES (?, ?, ?)").run(
      "ws_impact",
      "[]",
      "IMP",
    );

    applyMigrations(db, (file) => file.slice(0, 4) === "0011");
  });

  afterAll(() => {
    db.close();
  });

  it("closes Delivered and Rejected by Shopify link or by key, and nothing else", () => {
    expect(db.prepare("SELECT workspace_id, key, closed FROM statuses ORDER BY workspace_id, sort").all()).toEqual([
      { workspace_id: "ws_custom", key: "done", closed: 1 },
      { workspace_id: "ws_custom", key: "rejected", closed: 1 },
      { workspace_id: "ws_custom", key: "archive", closed: 0 },
      { workspace_id: "ws_impact", key: "new", closed: 0 },
      { workspace_id: "ws_impact", key: "approved", closed: 0 },
      { workspace_id: "ws_impact", key: "shipped", closed: 0 },
      { workspace_id: "ws_impact", key: "delivered", closed: 1 },
      { workspace_id: "ws_impact", key: "rejected", closed: 1 },
    ]);
  });

  it("gives existing settings rows the default age thresholds and automatic prices", () => {
    expect(
      db.prepare("SELECT workspace_id, po_prefix, age_amber_days, age_red_days, price_display FROM workspace_settings").all(),
    ).toEqual([{ workspace_id: "ws_impact", po_prefix: "IMP", age_amber_days: 2, age_red_days: 4, price_display: "auto" }]);
  });

  it("starts a status written without closed as open", () => {
    db.prepare("INSERT INTO statuses (id, workspace_id, key, label, color, sort) VALUES (?, ?, ?, ?, ?, ?)").run(
      "ws_custom_fresh",
      "ws_custom",
      "fresh",
      "Fresh",
      "blue",
      3,
    );
    expect(db.prepare("SELECT closed FROM statuses WHERE id = ?").get("ws_custom_fresh")).toEqual({ closed: 0 });
  });

  it("only adds: no drop, delete or rename", () => {
    const file = migrationFiles().find((name) => name.startsWith("0011_"));
    const sql = readFileSync(join(migrationsDir, file as string), "utf8");
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bRENAME\b/i);
  });
});
