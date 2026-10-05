import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import { openTestDb } from "../desk/test-helpers";
import { FIRST_DRAFT_SEARCH } from "../shopify/client";
import { normalizeDrafts, normalizeOrders, type NormalizedDraft } from "../shopify/normalize";
import { loadStatusRows } from "../shopify/status-sync";
import {
  attachOrderToDraft,
  checkOpenDrafts,
  claimAndLoadDrafts,
  DRAFT_CHECK_EVERY_MS,
  ENSURE_ORDER_MAX,
  ensureOrderSnapshots,
  markDraftDeleted,
  mergeOrderIntoDraft,
  upsertFetchedDraft,
  writeDraftSnapshot,
  type KnownDraft,
} from "./drafts";
import { claimAndLoad, runSync, upsertFetchedOrder, type KnownOrder } from "./run";

// Draft orders in the sync engine (draft orders spec sections 5 and 6),
// against the real migrations on better-sqlite3 and a stubbed Shopify.

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_drafts_token_never_leak";
const WS = "ws_drafts";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const HOUR = 3600000;
const DRAFT_SCOPES_GRANTED = ["read_orders", "write_orders", "read_customers", "write_draft_orders"];

const iso = (ms: number) => new Date(ms).toISOString();

type DraftSpec = {
  id: string;
  name?: string;
  status?: "OPEN" | "INVOICE_SENT" | "COMPLETED";
  createdAt?: number;
  updatedAt?: number;
  order?: { id: string; name: string } | null;
  tags?: string[];
  customer?: string;
  note?: string;
  deleted?: boolean;
};

type OrderSpec = {
  id: string;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  tags?: string[];
  fulfilled?: boolean;
};

function draftNode(spec: DraftSpec) {
  return {
    id: `gid://shopify/DraftOrder/${spec.id}`,
    legacyResourceId: spec.id,
    name: spec.name ?? `#D${spec.id}`,
    status: spec.status ?? "OPEN",
    createdAt: iso(spec.createdAt ?? NOW - 2 * HOUR),
    updatedAt: iso(spec.updatedAt ?? spec.createdAt ?? NOW - 2 * HOUR),
    completedAt: spec.status === "COMPLETED" ? iso(spec.updatedAt ?? NOW - HOUR) : null,
    email: "jordan@example.com",
    tags: spec.tags ?? [],
    note2: spec.note ?? null,
    customAttributes: [{ key: "Ship to Branch", value: "Buford HQ" }],
    order: spec.order
      ? { id: `gid://shopify/Order/${spec.order.id}`, legacyResourceId: spec.order.id, name: spec.order.name }
      : null,
    customer: { displayName: spec.customer ?? "Jordan Vale" },
    purchasingEntity: {
      __typename: "PurchasingCompany",
      company: { id: "gid://shopify/Company/1", name: "Impact Rentals" },
      location: { id: "gid://shopify/CompanyLocation/1", name: "Buford, GA" },
    },
    totalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
    lineItems: {
      nodes: [{ title: "IMPACT Mousepad", quantity: 1, customAttributes: [{ key: "Full Name", value: "Casey Lin" }] }],
      pageInfo: { hasNextPage: false },
    },
  };
}

function orderNode(spec: OrderSpec) {
  return {
    id: `gid://shopify/Order/${spec.id}`,
    legacyResourceId: spec.id,
    name: spec.name ?? `#${spec.id}`,
    createdAt: iso(spec.createdAt ?? NOW - HOUR),
    updatedAt: iso(spec.updatedAt ?? spec.createdAt ?? NOW - HOUR),
    email: "jordan@example.com",
    sourceName: "shopify_draft_order",
    tags: spec.tags ?? [],
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: spec.fulfilled ? "FULFILLED" : "UNFULFILLED",
    customer: { displayName: "Jordan Vale" },
    currentTotalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
    fulfillments: [],
    lineItems: {
      nodes: [{ title: "IMPACT Mousepad", quantity: 1, customAttributes: [{ key: "Full Name", value: "Casey Lin" }] }],
      pageInfo: { hasNextPage: false },
    },
  };
}

const draftOf = (spec: DraftSpec): NormalizedDraft => normalizeDrafts([draftNode(spec)])[0];
const orderOf = (spec: OrderSpec) => normalizeOrders([orderNode(spec)])[0];

type Call = { op: string; variables: Record<string, unknown> };

// A Shopify store in miniature: drafts and orders served by the search and
// page size each query asks for, the draft link lookup, and the single
// order and draft queries. fail.<operation> answers that operation with a
// failure instead.
function fakeShop(
  state: { drafts?: DraftSpec[]; orders?: OrderSpec[] },
  fail: Partial<Record<string, () => Response>> = {},
) {
  const calls: Call[] = [];
  const drafts = () => state.drafts ?? [];
  const orders = () => state.orders ?? [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const page = <T extends { id: string; updatedAt?: number; createdAt?: number }>(
    query: string,
    variables: { cursor: string | null; search: string },
    all: T[],
    filter: (row: T, search: string) => boolean,
  ) => {
    const size = Number(query.match(/\(first: (\d+)/)![1]);
    const matching = all
      .filter((row) => filter(row, variables.search))
      .sort(
        (a, b) =>
          (a.updatedAt ?? a.createdAt ?? 0) - (b.updatedAt ?? b.createdAt ?? 0) || Number(a.id) - Number(b.id),
      );
    const start = variables.cursor ? Number(variables.cursor.split(":")[1]) : 0;
    const slice = matching.slice(start, start + size);
    const end = start + slice.length;
    return { slice, pageInfo: { hasNextPage: end < matching.length, endCursor: `c:${end}` } };
  };
  const since = (search: string) => Date.parse(search.match(/'(.*)'/)![1]);
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "unknown";
    calls.push({ op, variables: body.variables });
    const failure = fail[op];
    if (failure) {
      return failure();
    }
    switch (op) {
      case "DraftOrdersUpdatedSince": {
        const live = drafts().filter((d) => !d.deleted);
        const { slice, pageInfo } = page(body.query, body.variables as never, live, (d, search) =>
          search === FIRST_DRAFT_SEARCH
            ? (d.status ?? "OPEN") !== "COMPLETED"
            : (d.updatedAt ?? d.createdAt ?? NOW - 2 * HOUR) >= since(search),
        );
        return json({ data: { draftOrders: { nodes: slice.map(draftNode), pageInfo } } });
      }
      case "OrdersUpdatedSince": {
        const { slice, pageInfo } = page(
          body.query,
          body.variables as never,
          orders(),
          (o, search) => (o.updatedAt ?? o.createdAt ?? NOW - HOUR) >= since(search),
        );
        return json({ data: { orders: { nodes: slice.map(orderNode), pageInfo } } });
      }
      case "DraftLinks": {
        const ids = body.variables.ids as string[];
        return json({
          data: {
            nodes: ids.map((gid) => {
              const draft = drafts().find((d) => `gid://shopify/DraftOrder/${d.id}` === gid && !d.deleted);
              return draft ? draftNode(draft) : null;
            }),
          },
        });
      }
      case "OrderById": {
        const order = orders().find((o) => `gid://shopify/Order/${o.id}` === body.variables.id);
        return json({ data: { order: order ? orderNode(order) : null } });
      }
      case "DraftOrderById": {
        const draft = drafts().find((d) => `gid://shopify/DraftOrder/${d.id}` === body.variables.id && !d.deleted);
        return json({ data: { draftOrder: draft ? draftNode(draft) : null } });
      }
      default:
        throw new Error("unexpected Shopify request: " + op);
    }
  }) as typeof fetch;
  return { impl, calls, ops: () => calls.map((call) => call.op) };
}

const STATUSES = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null },
  { key: "processing", label: "Processing", color: "blue", sort: 1, triggersPo: false, shopifyLink: null },
  { key: "approved", label: "Approved", color: "green", sort: 2, triggersPo: true, shopifyLink: "draft_completed" as const },
  { key: "shipped", label: "Shipped", color: "violet", sort: 3, triggersPo: false, shopifyLink: "fulfilled" as const },
  { key: "rejected", label: "Rejected", color: "pink", sort: 4, triggersPo: false, shopifyLink: "draft_rejected" as const },
];

async function setup(
  opts: { scopes?: string[] | null; connection?: Partial<typeof schema.storeConnections.$inferInsert> } = {},
) {
  const { db, raw } = openTestDb();
  await db.insert(schema.workspaces).values({ id: WS, name: "Impact", slug: WS, createdBy: "u1", createdAt: 1 });
  await db
    .insert(schema.statuses)
    .values(STATUSES.map((status) => ({ id: `${WS}_${status.key}`, workspaceId: WS, ...status })));
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes: opts.scopes === undefined ? DRAFT_SCOPES_GRANTED : opts.scopes,
    lastSyncAt: NOW - HOUR,
    ...opts.connection,
  });
  const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
  return { db, raw, env };
}

async function rows(db: Db) {
  return db.select().from(schema.orders).where(eq(schema.orders.workspaceId, WS));
}

async function rowByDraft(db: Db, draftId: string) {
  const found = await db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.workspaceId, WS), eq(schema.orders.shopifyDraftId, draftId)));
  return found[0];
}

async function eventsOf(db: Db, orderId?: string) {
  const all = await db.select().from(schema.events).where(eq(schema.events.workspaceId, WS));
  return orderId === undefined ? all : all.filter((event) => event.orderId === orderId);
}

async function connectionOf(db: Db) {
  return (await db.select().from(schema.storeConnections).where(eq(schema.storeConnections.workspaceId, WS)))[0];
}

type Raw = { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };

// A D1-style atomic batch on the better-sqlite3 test driver (a real
// transaction), with a hook that runs just before the statements.
function atomic(db: Db, raw: Raw, before?: () => void): Db {
  const batch = async (statements: PromiseLike<unknown>[]) => {
    before?.();
    raw.prepare("BEGIN").run();
    try {
      const out: unknown[] = [];
      for (const statement of statements) {
        out.push(await statement);
      }
      raw.prepare("COMMIT").run();
      return out;
    } catch (e) {
      raw.prepare("ROLLBACK").run();
      throw e;
    }
  };
  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "batch") {
        return batch;
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Db;
}

async function insertDraft(db: Db, spec: DraftSpec, at = NOW - HOUR, opts?: { silent?: boolean }) {
  const statusRows = await loadStatusRows(db, WS);
  const known = new Map<string, KnownDraft>();
  await claimAndLoadDrafts(db, WS, [spec.id], at, known);
  const outcome = await writeDraftSnapshot(db, WS, draftOf(spec), at, statusRows, known, {
    silent: opts?.silent ?? false,
  });
  expect(outcome.kind).toBe("added");
  return (await rowByDraft(db, spec.id))!;
}

async function insertPlainOrder(db: Db, spec: OrderSpec, at = NOW - HOUR) {
  const outcome = await upsertFetchedOrder(db, WS, orderOf(spec), at);
  expect(outcome.kind).toBe("added");
  return outcome.kind === "added" ? outcome.orderId : "";
}

async function claimed(db: Db, draftId: string): Promise<KnownDraft> {
  const known = new Map<string, KnownDraft>();
  await claimAndLoadDrafts(db, WS, [draftId], 0, known);
  return known.get(draftId)!;
}

describe("writeDraftSnapshot", () => {
  it("inserts an open draft as a card with its request entry, announced later unless silent", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12", name: "#D12", customer: "Jordan Vale", createdAt: NOW - 3 * HOUR });
    expect(row).toMatchObject({
      shopifyOrderId: null,
      shopifyDraftId: "12",
      draftName: "#D12",
      name: "#D12",
      statusKey: "new",
      createdAt: NOW - 3 * HOUR,
      syncedAt: NOW - HOUR,
      notifiedAt: null,
      draftSnapshot: null,
      draftDeletedAt: null,
    });
    expect((row.shopify as NormalizedDraft).kind).toBe("draft");
    expect(await eventsOf(db, row.id)).toEqual([
      expect.objectContaining({
        id: `evt-draft-new-${WS}-12`,
        type: "order_new",
        text: "New request #D12 from Jordan Vale",
        meta: { orderName: "#D12", kind: "draft" },
        source: "shopify",
        actorId: null,
        createdAt: NOW - HOUR,
      }),
    ]);
    const quiet = await insertDraft(db, { id: "13", customer: "" }, NOW - HOUR, { silent: true });
    expect(quiet.notifiedAt).toBe(NOW - HOUR);
    expect((await eventsOf(db, quiet.id))[0].text).toBe("New request #D13");
    // Marked, so the bell leaves it out (src/server/activity.ts).
    expect((await eventsOf(db, quiet.id))[0].meta).toEqual({ orderName: "#D13", kind: "draft", silent: true });
  });

  it("refreshes a changed open draft under the claim rule and leaves an unchanged one alone", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12" });
    const statusRows = await loadStatusRows(db, WS);
    const write = async (spec: DraftSpec, at: number) => {
      const known = new Map<string, KnownDraft>();
      await claimAndLoadDrafts(db, WS, [spec.id], at, known);
      return writeDraftSnapshot(db, WS, draftOf(spec), at, statusRows, known);
    };
    expect((await write({ id: "12" }, NOW)).kind).toBe("none");
    const changed = await write({ id: "12", note: "Rush" }, NOW + 1);
    expect(changed).toMatchObject({ kind: "updated", orderId: row.id });
    if (changed.kind === "updated") {
      expect((changed.before as NormalizedDraft).note).toBe("");
      expect((changed.after as NormalizedDraft).note).toBe("Rush");
    }
    // An older run (smaller now) can no longer write over it.
    const stale = new Map<string, KnownDraft>([["12", { ...(await claimed(db, "12")), shopify: {} }]]);
    expect((await writeDraftSnapshot(db, WS, draftOf({ id: "12", note: "old" }), NOW, statusRows, stale)).kind).toBe(
      "none",
    );
    expect(((await rowByDraft(db, "12"))!.shopify as NormalizedDraft).note).toBe("Rush");
  });

  it("clears the deleted mark when Shopify answers for the draft again", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12" });
    await db.update(schema.orders).set({ draftDeletedAt: NOW - 1 }).where(eq(schema.orders.id, row.id));
    const statusRows = await loadStatusRows(db, WS);
    const known = new Map<string, KnownDraft>();
    await claimAndLoadDrafts(db, WS, ["12"], NOW, known);
    expect((await writeDraftSnapshot(db, WS, draftOf({ id: "12" }), NOW, statusRows, known)).kind).toBe("updated");
    expect((await rowByDraft(db, "12"))!.draftDeletedAt).toBeNull();
  });

  it("attaches a completed draft to its order, keeping the card's id, status and claim", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12", name: "#D12" });
    await db.update(schema.orders).set({ statusKey: "processing", notifiedAt: 5 }).where(eq(schema.orders.id, row.id));
    const statusRows = await loadStatusRows(db, WS);
    const known = new Map<string, KnownDraft>();
    await claimAndLoadDrafts(db, WS, ["12"], NOW, known);
    const completed = draftOf({ id: "12", name: "#D12", status: "COMPLETED", order: { id: "9001", name: "#1031" } });
    const outcome = await writeDraftSnapshot(db, WS, completed, NOW, statusRows, known);
    expect(outcome).toMatchObject({ kind: "attached", orderId: row.id });
    const after = (await rowByDraft(db, "12"))!;
    expect(after).toMatchObject({
      id: row.id,
      shopifyOrderId: "9001",
      name: "#1031",
      draftName: "#D12",
      statusKey: "processing",
      notifiedAt: 5,
      createdAt: row.createdAt,
      shopify: completed,
      draftSnapshot: completed,
    });
    const completedEvents = (await eventsOf(db, row.id)).filter((event) => event.type === "draft_completed");
    expect(completedEvents).toEqual([
      expect.objectContaining({
        id: `evt-draft-order-${WS}-12`,
        text: "Order #1031 created from draft #D12",
        meta: { orderName: "#1031", draftName: "#D12", shopifyOrderId: "9001" },
        source: "shopify",
        actorId: null,
      }),
    ]);
    // A later update of the completed draft touches draft_snapshot only.
    const known2 = new Map<string, KnownDraft>();
    await claimAndLoadDrafts(db, WS, ["12"], NOW + 1, known2);
    const edited = draftOf({
      id: "12",
      name: "#D12",
      status: "COMPLETED",
      order: { id: "9001", name: "#1031" },
      note: "later",
    });
    expect((await writeDraftSnapshot(db, WS, edited, NOW + 1, statusRows, known2)).kind).toBe("none");
    const final = (await rowByDraft(db, "12"))!;
    expect(final.draftSnapshot).toEqual(edited);
    expect(final.shopify).toEqual(completed);
  });

  it("skips a completed draft it never saw open, and backfills the draft onto its order's card", async () => {
    const { db } = await setup();
    const statusRows = await loadStatusRows(db, WS);
    const completed = draftOf({ id: "14", status: "COMPLETED", order: { id: "9002", name: "#1032" } });
    expect(
      (await writeDraftSnapshot(db, WS, completed, NOW, statusRows, new Map(), { knownOrders: new Map() })).kind,
    ).toBe("none");
    expect(await rows(db)).toEqual([]);

    const orderRowId = await insertPlainOrder(db, { id: "9002", name: "#1032" });
    const knownOrders = new Map<string, KnownOrder>();
    await claimAndLoad(db, WS, ["9002"], NOW, knownOrders);
    const outcome = await writeDraftSnapshot(db, WS, completed, NOW, statusRows, new Map(), { knownOrders });
    expect(outcome).toEqual({ kind: "backfilled", orderId: orderRowId });
    expect(await rowByDraft(db, "14")).toMatchObject({
      id: orderRowId,
      shopifyOrderId: "9002",
      shopifyDraftId: "14",
      draftName: "#D14",
      draftSnapshot: completed,
    });
  });

  it("refuses a draft snapshot write once the row is attached, even from a stale read", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12" });
    const statusRows = await loadStatusRows(db, WS);
    const known = new Map<string, KnownDraft>();
    await claimAndLoadDrafts(db, WS, ["12"], NOW, known);
    // Attached by another signal after this read.
    await attachOrderToDraft(db, WS, { draftRowId: row.id, orderId: "9001", orderName: "#1031", now: NOW, source: "shopify" });
    expect((await writeDraftSnapshot(db, WS, draftOf({ id: "12", note: "late" }), NOW, statusRows, known)).kind).toBe(
      "none",
    );
    expect(((await rowByDraft(db, "12"))!.shopify as NormalizedDraft).note).toBe("");
  });
});

describe("attachOrderToDraft", () => {
  it("attaches once: a second signal sees already, another order sees other", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12" });
    const first = await attachOrderToDraft(db, WS, {
      draftRowId: row.id,
      orderId: "9001",
      orderName: "#1031",
      now: NOW,
      source: "shopify",
    });
    expect(first.kind).toBe("attached");
    // No completed snapshot: the stored draft snapshot stays as both.
    const after = (await rowByDraft(db, "12"))!;
    expect(after.shopify).toEqual(row.shopify);
    expect(after.draftSnapshot).toEqual(row.shopify);
    expect(after.syncedAt).toBe(NOW);
    expect(
      await attachOrderToDraft(db, WS, {
        draftRowId: row.id,
        orderId: "9001",
        orderName: "#1031",
        now: NOW + 1,
        source: "app",
        actorId: "u1",
      }),
    ).toEqual({ kind: "already", orderRowId: row.id });
    expect(
      await attachOrderToDraft(db, WS, { draftRowId: row.id, orderId: "9999", orderName: "#1099", now: NOW, source: "shopify" }),
    ).toEqual({ kind: "other", orderRowId: row.id });
    expect(
      await attachOrderToDraft(db, WS, { draftRowId: "nope", orderId: "9001", orderName: "#1031", now: NOW, source: "shopify" }),
    ).toEqual({ kind: "missing" });
    expect((await eventsOf(db, row.id)).filter((event) => event.type === "draft_completed")).toHaveLength(1);
  });

  it("never moves the claim stamp backwards and records the person who approved", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12" });
    await db.update(schema.orders).set({ syncedAt: NOW + 50 }).where(eq(schema.orders.id, row.id));
    await attachOrderToDraft(db, WS, {
      draftRowId: row.id,
      orderId: "9001",
      orderName: "#1031",
      now: NOW,
      source: "app",
      actorId: "u_manager",
    });
    expect((await rowByDraft(db, "12"))!.syncedAt).toBe(NOW + 50);
    const [event] = (await eventsOf(db, row.id)).filter((e) => e.type === "draft_completed");
    expect(event).toMatchObject({ source: "app", actorId: "u_manager" });
  });
});

describe("mergeOrderIntoDraft", () => {
  async function withOrphan() {
    const ctx = await setup();
    const { db } = ctx;
    const draftRow = await insertDraft(db, { id: "12", name: "#D12" }, NOW - 3 * HOUR);
    await db.update(schema.orders).set({ statusKey: "processing" }).where(eq(schema.orders.id, draftRow.id));
    const orphanId = await insertPlainOrder(db, { id: "9001", name: "#1031" }, NOW - 2 * HOUR);
    await db.update(schema.orders).set({ notifiedAt: 77 }).where(eq(schema.orders.id, orphanId));
    await db
      .insert(schema.events)
      .values({ id: "e_note", workspaceId: WS, orderId: orphanId, type: "note", text: "Called the branch", createdAt: 1 });
    await db.insert(schema.purchaseOrders).values({
      id: "po1",
      workspaceId: WS,
      orderId: orphanId,
      vendorId: "v1",
      poNumber: "draft:po1",
      lineItems: [],
      createdBy: "u1",
      createdAt: 1,
    });
    return { ...ctx, draftRow, orphanId };
  }

  it("folds the orphan order row into the draft card", async () => {
    const { db, draftRow, orphanId } = await withOrphan();
    const orphanSnapshot = (await db.select().from(schema.orders).where(eq(schema.orders.id, orphanId)))[0].shopify;
    const result = await attachOrderToDraft(db, WS, {
      draftRowId: draftRow.id,
      orderId: "9001",
      orderName: "#1031",
      now: NOW,
      source: "shopify",
    });
    expect(result).toMatchObject({
      kind: "attached",
      orderRowId: draftRow.id,
      merged: { fromId: orphanId, toId: draftRow.id },
    });
    if (result.kind === "attached") {
      expect(result.before).toEqual(draftRow.shopify);
      expect(result.after).toEqual(orphanSnapshot);
    }
    const all = await rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: draftRow.id,
      shopifyOrderId: "9001",
      name: "#1031",
      statusKey: "processing",
      notifiedAt: 77,
      shopify: orphanSnapshot,
      draftSnapshot: draftRow.shopify,
    });
    const events = await eventsOf(db);
    expect(events.find((event) => event.id === `evt-order-new-${WS}-9001`)).toBeUndefined();
    expect(events.find((event) => event.id === "e_note")?.orderId).toBe(draftRow.id);
    expect(events.filter((event) => event.type === "draft_completed").map((event) => event.orderId)).toEqual([
      draftRow.id,
    ]);
    expect((await db.select().from(schema.purchaseOrders))[0].orderId).toBe(draftRow.id);
  });

  it("rolls the whole merge back when the orphan changed in between", async () => {
    const { db, raw, draftRow, orphanId } = await withOrphan();
    const before = {
      orders: await rows(db),
      events: await eventsOf(db),
      pos: await db.select().from(schema.purchaseOrders),
    };
    // Just before the batch runs, the orphan becomes another draft's card.
    const guarded = atomic(db, raw as unknown as Raw, () =>
      raw.prepare("UPDATE orders SET shopify_draft_id = '77' WHERE id = ?").run(orphanId),
    );
    const result = await mergeOrderIntoDraft(guarded, WS, {
      draftRowId: draftRow.id,
      orderId: "9001",
      orderName: "#1031",
      now: NOW,
      source: "shopify",
    });
    expect(result.kind).toBe("retry");
    raw.prepare("UPDATE orders SET shopify_draft_id = NULL WHERE id = ?").run(orphanId);
    expect(await rows(db)).toEqual(before.orders);
    expect(await eventsOf(db)).toEqual(before.events);
    expect(await db.select().from(schema.purchaseOrders)).toEqual(before.pos);
  });
});

describe("markDraftDeleted", () => {
  it("marks an open draft card deleted once, keeps its status, and ignores attached and unknown drafts", async () => {
    const { db } = await setup();
    const row = await insertDraft(db, { id: "12", name: "#D12" });
    const marked = await markDraftDeleted(db, WS, "12", NOW);
    expect(marked).toMatchObject({ kind: "deleted", orderId: row.id });
    if (marked.kind === "deleted") {
      expect(marked.event).toMatchObject({
        id: `evt-draft-deleted-${WS}-12`,
        type: "draft_deleted",
        text: "Draft #D12 was deleted in Shopify. This card and its history are kept.",
        source: "shopify",
        orderId: row.id,
      });
    }
    expect(await rowByDraft(db, "12")).toMatchObject({ draftDeletedAt: NOW, statusKey: "new" });
    expect(await markDraftDeleted(db, WS, "12", NOW + 1)).toEqual({ kind: "none" });
    expect((await eventsOf(db, row.id)).filter((event) => event.type === "draft_deleted")).toHaveLength(1);
    expect(await markDraftDeleted(db, WS, "404", NOW)).toEqual({ kind: "none" });

    const attached = await insertDraft(db, { id: "13" });
    await attachOrderToDraft(db, WS, { draftRowId: attached.id, orderId: "9001", orderName: "#1031", now: NOW, source: "shopify" });
    expect(await markDraftDeleted(db, WS, "13", NOW)).toEqual({ kind: "none" });
    expect((await rowByDraft(db, "13"))!.draftDeletedAt).toBeNull();
  });
});

describe("runSync with draft orders", () => {
  it("asks Shopify for no drafts at all when the app lacks the draft scopes", async () => {
    const { db, env } = await setup({ scopes: ["read_orders", "write_orders", "read_draft_orders"] });
    const shop = fakeShop({ drafts: [{ id: "12" }] });
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBeUndefined();
    expect(shop.ops()).toEqual(["OrdersUpdatedSince"]);
    expect(await rows(db)).toEqual([]);
  });

  it("inserts every open draft silently on the first draft sync and anchors the window", async () => {
    const { db, env } = await setup();
    const shop = fakeShop({
      drafts: [
        { id: "19", createdAt: NOW - 30 * 24 * HOUR },
        { id: "20", status: "INVOICE_SENT" },
        { id: "18", status: "COMPLETED", order: { id: "9018", name: "#1021" } },
      ],
    });
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBeUndefined();
    expect(shop.ops().slice(0, 2)).toEqual(["DraftOrdersUpdatedSince", "DraftLinks"]);
    expect(shop.calls[0].variables).toEqual({ cursor: null, search: FIRST_DRAFT_SEARCH });
    const cards = await rows(db);
    expect(cards.map((card) => card.shopifyDraftId).sort()).toEqual(["19", "20"]);
    expect(cards.every((card) => card.notifiedAt === NOW)).toBe(true);
    expect([...result.addedOrderIds].sort()).toEqual(cards.map((card) => card.id).sort());
    expect(result.added).toBe(2);
    const connection = await connectionOf(db);
    expect(connection.draftLastSyncAt).toBe(NOW);
    expect(connection.draftSyncCursor).toBeNull();
    expect(connection.draftCheckedAt).toBe(NOW);
  });

  it("resumes a truncated first draft sync with the same search, then anchors at the chain start", async () => {
    const { db, env } = await setup({ connection: { draftCheckedAt: NOW + HOUR } });
    const drafts = Array.from({ length: 402 }, (_, i) => ({ id: String(1000 + i), createdAt: NOW - 5 * HOUR + i }));
    const shop = fakeShop({ drafts });
    const first = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(first.error).toBeUndefined();
    expect(first.added).toBe(400);
    let connection = await connectionOf(db);
    expect(connection.draftLastSyncAt).toBe(0);
    expect(connection.draftSyncCursor).toBe(`${NOW}|c:400`);
    expect(connection.draftSyncCursorSince).toBe(0);

    const second = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 600000 });
    expect(second.added).toBe(2);
    const resumed = shop.calls.filter((call) => call.op === "DraftOrdersUpdatedSince").at(-1)!;
    expect(resumed.variables).toEqual({ cursor: "c:400", search: FIRST_DRAFT_SEARCH });
    connection = await connectionOf(db);
    expect(connection.draftLastSyncAt).toBe(NOW);
    expect(connection.draftSyncCursor).toBeNull();
    expect((await rows(db)).every((card) => card.notifiedAt !== null)).toBe(true);
  });

  it("adds, refreshes and leaves drafts alone in later windows, announcing new ones later", async () => {
    const { db, env } = await setup({ connection: { draftLastSyncAt: NOW - HOUR, draftCheckedAt: NOW + HOUR } });
    const state = { drafts: [{ id: "12", createdAt: NOW - 10 * 60000 }] as DraftSpec[] };
    const shop = fakeShop(state);
    const r1 = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(shop.calls[0].variables).toEqual({ cursor: null, search: `updated_at:>='${iso(NOW - HOUR - 300000)}'` });
    expect(r1.added).toBe(1);
    const card = (await rowByDraft(db, "12"))!;
    expect(card.notifiedAt).toBeNull();

    const r2 = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 600000 });
    expect(r2.added + r2.updated).toBe(0);

    state.drafts = [{ id: "12", createdAt: NOW - 10 * 60000, updatedAt: NOW + 700000, note: "Rush" }];
    const r3 = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 1200000 });
    expect(r3.updatedOrderIds).toEqual([card.id]);
  });

  it("attaches a completed draft, fetches its order, and never adds a new card for it", async () => {
    const { db, env } = await setup({ connection: { draftLastSyncAt: NOW - HOUR, draftCheckedAt: NOW } });
    const card = await insertDraft(db, { id: "12", name: "#D12" }, NOW - 2 * HOUR);
    // The order itself is older than this window, so only the draft brings it.
    const shop = fakeShop({
      drafts: [
        { id: "12", name: "#D12", status: "COMPLETED", updatedAt: NOW - 60000, order: { id: "9001", name: "#1031" } },
      ],
      orders: [{ id: "9001", name: "#1031", createdAt: NOW - 3 * HOUR, updatedAt: NOW - 3 * HOUR }],
    });
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBeUndefined();
    expect(result.addedOrderIds).toEqual([]);
    expect(result.updatedOrderIds).toEqual([card.id]);
    expect(shop.ops()).toEqual(["DraftOrdersUpdatedSince", "OrdersUpdatedSince", "OrderById"]);
    const after = (await rowByDraft(db, "12"))!;
    expect(after).toMatchObject({ id: card.id, shopifyOrderId: "9001", name: "#1031" });
    expect((after.shopify as { kind: string }).kind).toBe("order");
    expect((after.draftSnapshot as NormalizedDraft).status).toBe("completed");
    // The completion moves the card to the status linked to Draft approved,
    // once (the order written onto it afterwards moves nothing).
    expect(after.statusKey).toBe("approved");
    expect((result.statusChanges ?? []).map((change) => change.event.text)).toEqual([
      "Status set to Approved: the draft was completed in Shopify as order #1031",
    ]);
    expect((await eventsOf(db, card.id)).map((event) => event.type).sort()).toEqual([
      "draft_completed",
      "order_new",
      "status",
    ]);
  });

  it("keeps syncing orders when the drafts feed fails, leaving the draft cursor alone", async () => {
    const { db, env } = await setup({
      connection: {
        draftLastSyncAt: NOW - HOUR,
        draftSyncCursor: `${NOW - HOUR}|c:4`,
        draftSyncCursorSince: NOW - 2 * HOUR,
      },
    });
    const shop = fakeShop(
      { orders: [{ id: "9005" }] },
      { DraftOrdersUpdatedSince: () => new Response("{}", { status: 503 }) },
    );
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.added).toBe(1);
    const connection = await connectionOf(db);
    expect(connection.lastError).toBe("Drafts: Shopify responded with HTTP 503");
    expect(connection.status).toBe("ok");
    expect(connection.lastSyncAt).toBe(NOW);
    expect(connection.draftLastSyncAt).toBe(NOW - HOUR);
    expect(connection.draftSyncCursor).toBe(`${NOW - HOUR}|c:4`);
    expect(connection.draftSyncCursorSince).toBe(NOW - 2 * HOUR);
  });

  it("records a fatal drafts error once an hour and drops a resumed draft cursor", async () => {
    const { db, env } = await setup({
      connection: {
        draftLastSyncAt: NOW - HOUR,
        draftSyncCursor: `${NOW - HOUR}|c:4`,
        draftSyncCursorSince: NOW - 2 * HOUR,
      },
    });
    const denied = () =>
      new Response(JSON.stringify({ errors: [{ message: "Access denied for draftOrders field." }] }), { status: 200 });
    const shop = fakeShop({}, { DraftOrdersUpdatedSince: denied });
    await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 600000 });
    const connection = await connectionOf(db);
    expect(connection.lastError).toBe("Drafts: Access denied for draftOrders field.");
    expect(connection.draftSyncCursor).toBeNull();
    expect(connection.draftSyncCursorSince).toBeNull();
    const errors = (await eventsOf(db)).filter((event) => event.type === "sync_error");
    expect(errors.map((event) => event.text)).toEqual(["Drafts: Access denied for draftOrders field."]);
  });

  it("ends the run like the orders feed when Shopify rejects the token on the drafts feed", async () => {
    const { db, env } = await setup();
    const shop = fakeShop(
      { orders: [{ id: "9005" }] },
      { DraftOrdersUpdatedSince: () => new Response("{}", { status: 401 }) },
    );
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBe("Shopify rejected the token. Update the connection in Settings.");
    expect(shop.ops()).toEqual(["DraftOrdersUpdatedSince"]);
    expect((await connectionOf(db)).status).toBe("error");
    expect(await rows(db)).toEqual([]);
  });

  it("writes nothing when the lease is lost during the drafts phase", async () => {
    const { db, raw, env } = await setup();
    const shop = fakeShop({ drafts: [{ id: "12" }] });
    const stealing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await shop.impl(input, init);
      raw.prepare("UPDATE store_connections SET running_until = 1 WHERE workspace_id = ?").run(WS);
      return response;
    }) as typeof fetch;
    const result = await runSync(db, env, WS, { fetchImpl: stealing, now: () => NOW });
    expect(result.superseded).toBe(true);
    expect(await rows(db)).toEqual([]);
    expect((await connectionOf(db)).draftLastSyncAt).toBe(0);
  });

  it("links an order that arrives first to its draft card, with no new card and no new order entry", async () => {
    const { db, env } = await setup({ connection: { draftLastSyncAt: NOW - HOUR, draftCheckedAt: NOW } });
    const card = await insertDraft(db, { id: "12", name: "#D12" }, NOW - 2 * HOUR);
    const shop = fakeShop({
      // The drafts feed has not caught up with the completion yet.
      drafts: [
        { id: "12", name: "#D12", status: "COMPLETED", updatedAt: NOW - 3 * HOUR, order: { id: "9001", name: "#1031" } },
      ],
      orders: [{ id: "9001", name: "#1031", createdAt: NOW - 30 * 60000 }],
    });
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBeUndefined();
    expect(result.addedOrderIds).toEqual([]);
    expect(result.updatedOrderIds).toEqual([card.id]);
    expect(shop.ops()).toEqual(["DraftOrdersUpdatedSince", "OrdersUpdatedSince", "DraftLinks"]);
    expect(await rows(db)).toHaveLength(1);
    const after = (await rowByDraft(db, "12"))!;
    expect(after.shopifyOrderId).toBe("9001");
    expect((after.shopify as { kind: string }).kind).toBe("order");
    expect((await eventsOf(db)).filter((event) => event.type === "order_new").map((event) => event.id)).toEqual([
      `evt-draft-new-${WS}-12`,
    ]);
    // The completion move fires once, from the stored draft to the order.
    expect(after.statusKey).toBe("approved");
    expect((await eventsOf(db, card.id)).filter((event) => event.type === "status")).toHaveLength(1);
    expect(result.statusChanges ?? []).toHaveLength(1);
  });

  it("writes no order when the draft lookup fails, keeping the orders cursor and the draft progress", async () => {
    const { db, env } = await setup({ connection: { draftLastSyncAt: NOW - HOUR, draftCheckedAt: NOW } });
    await insertDraft(db, { id: "12" }, NOW - 2 * HOUR);
    const shop = fakeShop(
      { drafts: [{ id: "13", updatedAt: NOW - 60000 }], orders: [{ id: "9001", createdAt: NOW - 30 * 60000 }] },
      { DraftLinks: () => new Response("{}", { status: 502 }) },
    );
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBe("Could not check which draft an order came from: Shopify responded with HTTP 502");
    expect((await rows(db)).map((card) => card.shopifyDraftId).sort()).toEqual(["12", "13"]);
    expect((await rows(db)).some((card) => card.shopifyOrderId === "9001")).toBe(false);
    const connection = await connectionOf(db);
    expect(connection.lastSyncAt).toBe(NOW - HOUR);
    expect(connection.draftLastSyncAt).toBe(NOW);
    expect(connection.lastError).toBe("Could not check which draft an order came from: Shopify responded with HTTP 502");
  });

  it("merges an order card stored before its draft was known, and reports the merge", async () => {
    const { db, env } = await setup({ connection: { draftLastSyncAt: NOW - HOUR, draftCheckedAt: NOW } });
    const card = await insertDraft(db, { id: "12", name: "#D12" }, NOW - 3 * HOUR);
    const orphanId = await insertPlainOrder(db, { id: "9001", name: "#1031" }, NOW - 2 * HOUR);
    const shop = fakeShop({
      drafts: [
        { id: "12", name: "#D12", status: "COMPLETED", updatedAt: NOW - 60000, order: { id: "9001", name: "#1031" } },
      ],
    });
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBeUndefined();
    expect(result.mergedOrders).toEqual([{ fromId: orphanId, toId: card.id }]);
    expect((await rows(db)).map((row) => row.id)).toEqual([card.id]);
    expect(result.updatedOrderIds).toContain(card.id);
    // The card kept its status through the merge, then the completion moved it.
    expect((await rowByDraft(db, "12"))!.statusKey).toBe("approved");
    expect((await eventsOf(db, card.id)).filter((event) => event.type === "status")).toHaveLength(1);
  });

  it("checks every open draft card hourly: deleted ones are marked, missed completions attached", async () => {
    const { db, env } = await setup({
      connection: { draftLastSyncAt: NOW - HOUR, draftCheckedAt: NOW - DRAFT_CHECK_EVERY_MS },
    });
    const gone = await insertDraft(db, { id: "12" }, NOW - 5 * HOUR);
    const done = await insertDraft(db, { id: "13" }, NOW - 5 * HOUR);
    await insertDraft(db, { id: "14" }, NOW - 5 * HOUR);
    const state = {
      drafts: [
        { id: "12", deleted: true },
        { id: "13", status: "COMPLETED", updatedAt: NOW - 10 * HOUR, order: { id: "9013", name: "#1043" } },
        { id: "14", updatedAt: NOW - 10 * HOUR },
      ] as DraftSpec[],
      orders: [{ id: "9013", name: "#1043", createdAt: NOW - 10 * HOUR, updatedAt: NOW - 10 * HOUR }],
    };
    const shop = fakeShop(state);
    const result = await runSync(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result.error).toBeUndefined();
    expect((await rowByDraft(db, "12"))!.draftDeletedAt).toBe(NOW);
    expect((await rowByDraft(db, "13"))!.shopifyOrderId).toBe("9013");
    expect(((await rowByDraft(db, "13"))!.shopify as { kind: string }).kind).toBe("order");
    expect((await rowByDraft(db, "13"))!.statusKey).toBe("approved");
    expect((await rowByDraft(db, "12"))!.statusKey).toBe("new");
    expect((await rowByDraft(db, "14"))!.shopifyOrderId).toBeNull();
    expect([...result.updatedOrderIds].sort()).toEqual([gone.id, done.id].sort());
    expect((await connectionOf(db)).draftCheckedAt).toBe(NOW);

    const again = fakeShop(state);
    await runSync(db, env, WS, { fetchImpl: again.impl, now: () => NOW + 600000 });
    expect(again.ops()).not.toContain("DraftLinks");
  });
});

describe("ensureOrderSnapshots", () => {
  it("fetches at most 20 orders for cards still showing their draft", async () => {
    const { db } = await setup();
    const ids: string[] = [];
    const orders: OrderSpec[] = [];
    for (let i = 0; i < ENSURE_ORDER_MAX + 3; i++) {
      const row = await insertDraft(db, { id: String(100 + i) });
      await attachOrderToDraft(db, WS, {
        draftRowId: row.id,
        orderId: String(9100 + i),
        orderName: `#${1100 + i}`,
        now: NOW,
        source: "shopify",
      });
      ids.push(row.id);
      orders.push({ id: String(9100 + i) });
    }
    const shop = fakeShop({ orders });
    const result = await ensureOrderSnapshots(db, WS, ids, { shopDomain: SHOP, token: TOKEN, fetchImpl: shop.impl }, NOW);
    expect(ENSURE_ORDER_MAX).toBe(20);
    expect(shop.ops()).toEqual(Array(20).fill("OrderById"));
    expect(result.updatedOrderIds).toHaveLength(20);
  });
});

describe("checkOpenDrafts", () => {
  it("reports a failed lookup without writing anything", async () => {
    const { db } = await setup();
    await insertDraft(db, { id: "12" });
    const shop = fakeShop({}, { DraftLinks: () => new Response("{}", { status: 500 }) });
    const result = await checkOpenDrafts(db, WS, { shopDomain: SHOP, token: TOKEN, fetchImpl: shop.impl }, NOW);
    expect(result).toEqual({ kind: "failed", detail: "Shopify responded with HTTP 500" });
    expect((await rowByDraft(db, "12"))!.draftDeletedAt).toBeNull();
  });
});

describe("webhook paths", () => {
  it("upsertFetchedDraft adds, updates, attaches and leaves unchanged drafts alone", async () => {
    const { db } = await setup();
    const added = await upsertFetchedDraft(db, WS, draftOf({ id: "12", name: "#D12" }), NOW);
    expect(added.kind).toBe("added");
    expect(await upsertFetchedDraft(db, WS, draftOf({ id: "12", name: "#D12" }), NOW + 1)).toEqual({ kind: "unchanged" });
    expect((await upsertFetchedDraft(db, WS, draftOf({ id: "12", name: "#D12", note: "x" }), NOW + 2)).kind).toBe(
      "updated",
    );
    const attached = await upsertFetchedDraft(
      db,
      WS,
      draftOf({ id: "12", name: "#D12", status: "COMPLETED", order: { id: "9001", name: "#1031" } }),
      NOW + 3,
    );
    expect(attached).toMatchObject({ kind: "attached", orderGid: "gid://shopify/Order/9001" });
    expect(attached.kind === "attached" ? attached.statusChanges.map((change) => change.order.statusKey) : []).toEqual([
      "approved",
    ]);
    const silent = await upsertFetchedDraft(db, WS, draftOf({ id: "13" }), NOW, { silent: true });
    expect(silent.kind).toBe("added");
    expect((await rowByDraft(db, "13"))!.notifiedAt).toBe(NOW);
  });

  it("upsertFetchedOrder links a draft-born order through the lookup, or defers when it fails", async () => {
    const { db } = await setup();
    const card = await insertDraft(db, { id: "12" }, NOW - 2 * HOUR);
    const shop = fakeShop({ drafts: [{ id: "12", status: "COMPLETED", order: { id: "9001", name: "#1031" } }] });
    const access = { shopDomain: SHOP, token: TOKEN, fetchImpl: shop.impl };
    const failing = fakeShop({}, { DraftLinks: () => new Response("{}", { status: 503 }) });
    expect(
      await upsertFetchedOrder(db, WS, orderOf({ id: "9001", name: "#1031" }), NOW, {
        ...access,
        fetchImpl: failing.impl,
      }),
    ).toEqual({ kind: "deferred", detail: "Shopify responded with HTTP 503" });
    expect(await rows(db)).toHaveLength(1);

    const linked = await upsertFetchedOrder(db, WS, orderOf({ id: "9001", name: "#1031" }), NOW, access);
    expect(linked).toMatchObject({ kind: "attached", orderId: card.id });
    expect(linked.kind === "attached" ? linked.statusChanges.map((change) => change.order.statusKey) : []).toEqual([
      "approved",
    ]);
    expect(await rows(db)).toHaveLength(1);
    expect((await rowByDraft(db, "12"))!.shopifyOrderId).toBe("9001");

    // Without drafts (no access passed) an unknown order is a new card.
    const plain = await upsertFetchedOrder(db, WS, orderOf({ id: "9002" }), NOW);
    expect(plain.kind).toBe("added");
  });
});
