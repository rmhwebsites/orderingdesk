// Test-only support for the desk service tests; never import this from app
// code. Same approach as src/server/sync/run.test.ts: the real drizzle/*.sql
// migrations are applied to an in-memory better-sqlite3 database, which is
// injected as Db (it has no batch method, so applyBatch takes its sequential
// path).

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Db } from "@/db";
import * as schema from "@/db/schema";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");

export function openTestDb() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        raw.prepare(trimmed).run();
      }
    }
  }
  const db = drizzle(raw, { schema }) as unknown as Db;
  return { db, raw };
}

// Adds a D1-style batch to the better-sqlite3 Db so the atomic path of
// applyBatch runs; every batch call is recorded (its statements, in order).
export function withBatch(db: Db, record: unknown[][]): Db {
  const batch = async (statements: PromiseLike<unknown>[]) => {
    record.push([...statements]);
    const out: unknown[] = [];
    for (const statement of statements) {
      out.push(await statement);
    }
    return out;
  };
  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "batch") {
        return batch;
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Db;
}

export const TEST_STATUSES = [
  { key: "new", label: "New", color: "lime", triggersPo: false, shopifyLink: null },
  { key: "processing", label: "Processing", color: "blue", triggersPo: false, shopifyLink: null },
  { key: "approved", label: "Approved", color: "green", triggersPo: true, shopifyLink: null },
  { key: "shipped", label: "Shipped", color: "violet", triggersPo: false, shopifyLink: "fulfilled" as const },
];

// A better-auth user row (emails are stored lowercased, as better-auth does).
export async function seedUser(db: Db, id: string, email: string, name = "") {
  await db.insert(schema.user).values({ id, email: email.toLowerCase(), name, emailVerified: true });
}

// A membership row; source defaults to manual like the column.
export async function seedMember(
  db: Db,
  workspaceId: string,
  userId: string,
  role: "manager" | "staff",
  source: "manual" | "shopify" = "manual",
) {
  await db.insert(schema.workspaceMembers).values({
    id: `${workspaceId}_${userId}`,
    workspaceId,
    userId,
    role,
    source,
  });
}

// A shopify_roster row as a Shopify tag creates it: waiting for approval.
// approved: a manager approved it for its role (approvedRole = role);
// denied: a manager denied it.
export async function seedRosterEntry(
  db: Db,
  entry: {
    id?: string;
    workspaceId: string;
    email: string;
    role: "manager" | "staff";
    customerId?: string;
    state?: "waiting" | "approved" | "denied";
  },
) {
  const id = entry.id ?? `r_${entry.workspaceId}_${entry.email}`;
  const state = entry.state ?? "waiting";
  await db.insert(schema.shopifyRoster).values({
    id,
    workspaceId: entry.workspaceId,
    email: entry.email.toLowerCase(),
    role: entry.role,
    shopifyCustomerId: entry.customerId ?? id,
    updatedAt: 1,
    approvedRole: state === "approved" ? entry.role : null,
    approvedAt: state === "approved" ? 2 : null,
    approvedBy: state === "approved" ? "u_approver" : null,
    deniedAt: state === "denied" ? 3 : null,
  });
  return id;
}

// A workspace with its settings row and TEST_STATUSES (sort = list position),
// the way POST /api/workspaces creates one.
export async function seedWorkspace(db: Db, id: string) {
  await db.insert(schema.workspaces).values({
    id,
    name: "Workspace " + id,
    slug: id,
    createdBy: "user_owner",
    createdAt: 1,
  });
  await db.insert(schema.workspaceSettings).values({ workspaceId: id });
  await db.insert(schema.statuses).values(
    TEST_STATUSES.map((status, sort) => ({
      id: `${id}_st_${status.key}`,
      workspaceId: id,
      sort,
      ...status,
    })),
  );
}

// Snapshots are plain records on purpose (not NormalizedOrder literals), so
// these tests do not break when the normalizer gains a field.
export function snapshotOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shopifyOrderId: "5001",
    name: "#1001",
    createdAt: 1000,
    customerName: "Riley Oakes",
    email: "riley.oakes@example.com",
    total: "120.00",
    currency: "CAD",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    items: [{ title: "Hard Hat", qty: 2, price: "10.00", sku: "HH-1", variant: "White" }],
    itemsTruncated: false,
    shipping: null,
    tags: "",
    note: "",
    ...overrides,
  };
}

export async function seedOrder(
  db: Db,
  workspaceId: string,
  opts: {
    id: string;
    name?: string;
    statusKey?: string;
    createdAt?: number;
    syncedAt?: number;
    shopify?: unknown;
  },
) {
  await db.insert(schema.orders).values({
    id: opts.id,
    workspaceId,
    shopifyOrderId: "shop-" + opts.id,
    name: opts.name ?? "#" + opts.id,
    shopify: "shopify" in opts ? opts.shopify : snapshotOf(),
    statusKey: opts.statusKey ?? "new",
    createdAt: opts.createdAt ?? 1000,
    syncedAt: opts.syncedAt ?? 2000,
  });
}
