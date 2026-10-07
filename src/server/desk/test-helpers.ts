// Test-only support for the desk service tests; never import this from app
// code. Same approach as src/server/sync/run.test.ts: the real drizzle/*.sql
// migrations are applied to an in-memory better-sqlite3 database, which is
// injected as Db (it has no batch method, so applyBatch takes its sequential
// path).

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
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
  { key: "new", label: "New", color: "lime", triggersPo: false, shopifyLink: null, closed: false },
  { key: "processing", label: "Processing", color: "blue", triggersPo: false, shopifyLink: null, closed: false },
  { key: "approved", label: "Approved", color: "green", triggersPo: true, shopifyLink: null, closed: false },
  { key: "shipped", label: "Shipped", color: "violet", triggersPo: false, shopifyLink: "fulfilled" as const, closed: false },
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

// A draft card (draft orders spec section 2): no Shopify order id yet, the
// draft's legacy id and name, and a draft snapshot. Plain records again.
export function draftSnapshotOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "draft",
    shopifyDraftId: "12",
    name: "#D12",
    status: "open",
    createdAt: 1000,
    completedAt: null,
    orderId: null,
    orderName: null,
    customerName: "Jordan Vale",
    email: "jordan@example.com",
    company: "Impact Rentals",
    location: "Buford, GA",
    attributes: [],
    discountCodes: [],
    discount: null,
    subtotal: "0.00",
    discounts: "0.00",
    total: "0.00",
    currency: "USD",
    items: [{ title: "Business cards", qty: 1, price: "0.00", sku: "BC-1", variant: "", props: [], custom: false }],
    itemsTruncated: false,
    shipping: null,
    tags: "",
    note: "",
    poNumber: "",
    ...overrides,
  };
}

export async function seedDraft(
  db: Db,
  workspaceId: string,
  opts: {
    id: string;
    draftId?: string;
    name?: string;
    statusKey?: string;
    createdAt?: number;
    syncedAt?: number;
    shopify?: unknown;
    draftDeletedAt?: number | null;
    notifiedAt?: number | null;
  },
) {
  const draftId = opts.draftId ?? "d-" + opts.id;
  const name = opts.name ?? "#D" + opts.id;
  await db.insert(schema.orders).values({
    id: opts.id,
    workspaceId,
    shopifyOrderId: null,
    name,
    shopify: "shopify" in opts ? opts.shopify : draftSnapshotOf({ shopifyDraftId: draftId, name }),
    statusKey: opts.statusKey ?? "new",
    createdAt: opts.createdAt ?? 1000,
    syncedAt: opts.syncedAt ?? 2000,
    notifiedAt: opts.notifiedAt ?? null,
    shopifyDraftId: draftId,
    draftName: name,
    draftDeletedAt: opts.draftDeletedAt ?? null,
  });
}

// Links Approved to draft_completed and adds Issue and Rejected
// (draft_rejected) after the TEST_STATUSES, as migration 0010 does for an
// existing workspace.
export async function seedDraftStatuses(db: Db, workspaceId: string) {
  await db
    .update(schema.statuses)
    .set({ shopifyLink: "draft_completed" })
    .where(and(eq(schema.statuses.workspaceId, workspaceId), eq(schema.statuses.key, "approved")));
  await db.insert(schema.statuses).values([
    { id: `${workspaceId}_st_issue`, workspaceId, key: "issue", label: "Issue", color: "red", sort: 4 },
    {
      id: `${workspaceId}_st_rejected`,
      workspaceId,
      key: "rejected",
      label: "Rejected",
      color: "pink",
      sort: 5,
      shopifyLink: "draft_rejected",
      closed: true,
    },
  ]);
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

// A synced company location (src/server/sync/locations.ts), active unless
// told otherwise. Ids are Shopify legacy ids, like the sync writes them.
export async function seedLocation(
  db: Db,
  workspaceId: string,
  opts: {
    shopifyLocationId: string;
    name: string;
    companyId?: string | null;
    address?: import("@/lib/address").LocationAddress | null;
    active?: boolean;
    updatedAt?: number;
  },
) {
  await db.insert(schema.locations).values({
    id: `${workspaceId}_loc_${opts.shopifyLocationId}`,
    workspaceId,
    shopifyLocationId: opts.shopifyLocationId,
    companyId: opts.companyId ?? "7",
    name: opts.name,
    address: opts.address ?? null,
    active: opts.active ?? true,
    updatedAt: opts.updatedAt ?? 1,
  });
}

// The Cancelled status migration 0012 adds to an existing workspace: closed,
// linked to Shopify's cancelled state, after the statuses already there.
// (closed as Wave 1a declared it: true in boolean mode, 1 in number mode.)
export async function seedCancelledStatus(db: Db, workspaceId: string, sort = 9) {
  await db.insert(schema.statuses).values({
    id: `${workspaceId}_st_cancelled`,
    workspaceId,
    key: "cancelled",
    label: "Cancelled",
    color: "slate",
    sort,
    shopifyLink: "cancelled",
    closed: true,
  });
}

// Marks a status closed or open (Wave 1a's statuses.closed).
export async function setStatusClosed(db: Db, workspaceId: string, key: string, closed: boolean) {
  await db
    .update(schema.statuses)
    .set({ closed })
    .where(and(eq(schema.statuses.workspaceId, workspaceId), eq(schema.statuses.key, key)));
}

// Puts a card at a company location: the Shopify location id, as Wave 1b's
// snapshot writers store it in orders.location_id.
export async function setOrderLocation(db: Db, orderId: string, shopifyLocationId: string | null) {
  await db.update(schema.orders).set({ locationId: shopifyLocationId }).where(eq(schema.orders.id, orderId));
}
