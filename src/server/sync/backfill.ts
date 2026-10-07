// Order history import: a platform admin's one-off import of a store's older
// orders ("All orders" or "Orders since <date>"), which the regular sync
// never fetches (its first window is the last 60 days). Relative imports on
// purpose: the cron path bundles this into the custom worker.
//
// How it runs:
// - startBackfill records the request on the store_connections row
//   (backfill_* columns, migration 0008). Nothing is fetched then: the cron
//   advances a running import by at most BACKFILL_PAGES_PER_TICK pages of
//   ORDERS_PER_PAGE orders per tick (runBackfillTick), after the regular
//   sync, so a tick stays far inside the Workers subrequest and CPU budgets
//   (about 20 Shopify requests and under 200 D1 statements).
// - Shopify is read with the sync's own order fields and cost, sorted by
//   creation date, newest first (fetchOrderHistory). The import keeps its
//   own cursor in backfill_cursor; the regular sync's cursor, window and
//   last_sync_at are never read or written here.
// - The range ends a day before the import started (backfillUntil). Orders
//   newer than that belong to the regular sync, which covers every order
//   created in the 60 days before its first run and everything since, and
//   is the path that announces new orders. Orders Shopify returns outside
//   the range anyway are skipped.
// - A tick takes the sync lease (store_connections.running_until) like a
//   sync run, so it never runs at the same time as a sync of the same
//   workspace; while the regular sync is still draining a cursor chain the
//   import waits. Every progress write is fenced on the lease and on the
//   import still running with the same start time, so a cancel, a new
//   import, a connection save or a disconnect in between wins.
// - Only orders the app has never stored are written, through
//   insertNewOrder (run.ts) with imported set: conflict no-op inserts, the
//   status their tag or Shopify state implies, the notification claimed at
//   once (so no path ever announces them), and an order_new event that says
//   it was imported and carries meta.imported (left out of the bell). A
//   stored order is never claimed, compared or rewritten here: keeping it
//   current is the regular sync's job. Nothing is written to Shopify.
// - Ranges reaching back more than 60 days need the read_all_orders scope:
//   without it Shopify silently returns only the last 60 days, so such an
//   import is refused at the start, and fails if a reconnect drops it.

import { and, eq, inArray, ne, or, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { applyBatch, rowsAffected } from "../../db/batch";
import { orders, storeConnections } from "../../db/schema";
import { NEW_ORDER_MAX_AGE_MS } from "../notify";
import { companiesEnabled } from "../shopify/admin";
import { fetchOrderHistory, ORDERS_PER_PAGE } from "../shopify/client";
import { normalizeOrders } from "../shopify/normalize";
import { loadStatusRows } from "../shopify/status-sync";
import { accessTokenFor } from "../shopify/token";
import { EXISTENCE_CHUNK, FIRST_SYNC_WINDOW_MS, insertNewOrder, LEASE_MS, type SyncOptions } from "./run";

export const BACKFILL_PAGES_PER_TICK = 20;
export const ORDERS_PER_TICK = BACKFILL_PAGES_PER_TICK * ORDERS_PER_PAGE;
export const READ_ALL_ORDERS = "read_all_orders";
// Shopify opened in 2006; an earlier start date is a typo.
export const EARLIEST_SINCE = Date.UTC(2006, 0, 1);
const ERROR_MAX = 300;

export const SCOPE_MISSING =
  "Importing orders older than 60 days needs the read_all_orders permission, which this store's Shopify app does not have. Add read_all_orders to the app's access scopes, approve the new version on the store, connect the store again here, then start the import.";
const CREDENTIALS_REJECTED =
  "Shopify rejected the store's credentials. Fix the store connection, then start the import again.";
const CREDENTIALS_UNREADABLE =
  "The store's credentials could not be read. Connect the store again, then start the import again.";

export type BackfillStatus = "idle" | "running" | "done" | "cancelled" | "failed";

export type BackfillView = {
  status: BackfillStatus;
  // Orders created at or after this time; null for all orders.
  since: number | null;
  imported: number;
  startedAt: number | null;
  finishedAt: number | null;
  // The failure of a failed import, or the last blip of a running one.
  error: string | null;
  // Why a running import is not advancing: the regular sync is still
  // catching up (it goes first), or the store is disconnected.
  paused: "sync" | "disconnected" | null;
  // Whether the store's app was granted read_all_orders (as recorded at
  // connect time): needed for anything older than 60 days.
  canReadAllOrders: boolean;
};

type ConnectionRow = typeof storeConnections.$inferSelect;

function clip(text: string): string {
  return text.slice(0, ERROR_MAX);
}

function changesOf(result: unknown): number {
  return rowsAffected(result, "backfill");
}

// The end of an import's range: a day before it started (see the header).
export function backfillUntil(startedAt: number): number {
  return startedAt - NEW_ORDER_MAX_AGE_MS;
}

// Whether a range starting at `since` (null: all orders) reaches back more
// than the 60 days Shopify serves without read_all_orders, as of `at`.
export function needsReadAllOrders(since: number | null, at: number): boolean {
  return since === null || since < at - FIRST_SYNC_WINDOW_MS;
}

// An unknown grant (a connection saved before scopes were recorded) counts
// as not granted: connecting again records it.
export function canReadAllOrders(scopes: unknown): boolean {
  return Array.isArray(scopes) && scopes.includes(READ_ALL_ORDERS);
}

export function backfillViewOf(
  row: Pick<
    ConnectionRow,
    | "status"
    | "scopes"
    | "syncCursor"
    | "backfillStatus"
    | "backfillSince"
    | "backfillImported"
    | "backfillStartedAt"
    | "backfillFinishedAt"
    | "backfillError"
  >,
): BackfillView {
  const running = row.backfillStatus === "running";
  return {
    status: row.backfillStatus ?? "idle",
    since: row.backfillSince ?? null,
    imported: row.backfillImported,
    startedAt: row.backfillStartedAt ?? null,
    finishedAt: row.backfillFinishedAt ?? null,
    error: row.backfillError ?? null,
    paused: !running ? null : row.status === "disabled" ? "disconnected" : row.syncCursor !== null ? "sync" : null,
    canReadAllOrders: canReadAllOrders(row.scopes),
  };
}

async function readConnection(db: Db, workspaceId: string): Promise<ConnectionRow | undefined> {
  const rows = await db.select().from(storeConnections).where(eq(storeConnections.workspaceId, workspaceId)).limit(1);
  return rows[0];
}

export async function getBackfillView(db: Db, workspaceId: string): Promise<BackfillView | null> {
  const row = await readConnection(db, workspaceId);
  return row ? backfillViewOf(row) : null;
}

// ---- Start and cancel ----------------------------------------------------

export type StartBackfillResult =
  | { kind: "started"; backfill: BackfillView }
  // Bad input (400).
  | { kind: "invalid"; error: string }
  // No store, a disconnected store or one that needs attention, or an
  // import already running (409).
  | { kind: "conflict"; error: string }
  // The range needs read_all_orders and the app does not have it (422).
  | { kind: "scope"; error: string };

const RANGE_ERROR = 'Choose "All orders" or a start date.';
const DATE_ERROR = "Pick a start date at least one day ago. Newer orders come in with the regular sync.";

// Body {range: "all"} or {range: "since", since: <ms, the start of the chosen
// day in the admin's time zone>}.
export function parseBackfillRequest(body: unknown, now: number): { since: number | null } | { error: string } {
  const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (fields.range === "all") {
    return { since: null };
  }
  if (fields.range !== "since") {
    return { error: RANGE_ERROR };
  }
  const since = fields.since;
  if (typeof since !== "number" || !Number.isSafeInteger(since)) {
    return { error: "Pick a start date." };
  }
  if (since < EARLIEST_SINCE) {
    return { error: "Pick a start date after 2006." };
  }
  if (since >= backfillUntil(now)) {
    return { error: DATE_ERROR };
  }
  return { since };
}

export async function startBackfill(db: Db, workspaceId: string, body: unknown, now = Date.now()): Promise<StartBackfillResult> {
  const parsed = parseBackfillRequest(body, now);
  if ("error" in parsed) {
    return { kind: "invalid", error: parsed.error };
  }
  const row = await readConnection(db, workspaceId);
  if (!row || row.status === "disabled") {
    return { kind: "conflict", error: "Connect the store before importing its order history." };
  }
  if (row.status === "error") {
    return { kind: "conflict", error: "The store connection needs attention. Fix it, then start the import." };
  }
  if (row.backfillStatus === "running") {
    return { kind: "conflict", error: "An import is already running. Stop it to start another." };
  }
  if (needsReadAllOrders(parsed.since, now) && !canReadAllOrders(row.scopes)) {
    return { kind: "scope", error: SCOPE_MISSING };
  }
  // One statement decides: the store must still be connected and no import
  // running when it lands, so two starts cannot both win.
  const started = await db
    .update(storeConnections)
    .set({
      backfillStatus: "running",
      backfillSince: parsed.since,
      backfillCursor: null,
      backfillImported: 0,
      backfillStartedAt: now,
      backfillFinishedAt: null,
      backfillError: null,
    })
    .where(
      and(
        eq(storeConnections.workspaceId, workspaceId),
        eq(storeConnections.status, "ok"),
        or(isNull(storeConnections.backfillStatus), ne(storeConnections.backfillStatus, "running")),
      ),
    )
    .returning();
  if (!started[0]) {
    return { kind: "conflict", error: "The store changed while starting. Reload the page and try again." };
  }
  return { kind: "started", backfill: backfillViewOf(started[0]) };
}

export type CancelBackfillResult = { kind: "cancelled"; backfill: BackfillView } | { kind: "conflict"; error: string };

// Stops a running import; what it imported stays. A tick in flight sees the
// change at its next check and writes nothing more (see runBackfillTick).
export async function cancelBackfill(db: Db, workspaceId: string, now = Date.now()): Promise<CancelBackfillResult> {
  const rows = await db
    .update(storeConnections)
    .set({ backfillStatus: "cancelled", backfillCursor: null, backfillFinishedAt: now })
    .where(and(eq(storeConnections.workspaceId, workspaceId), eq(storeConnections.backfillStatus, "running")))
    .returning();
  if (!rows[0]) {
    return { kind: "conflict", error: "No import is running." };
  }
  return { kind: "cancelled", backfill: backfillViewOf(rows[0]) };
}

// ---- One cron tick -------------------------------------------------------

export type BackfillTickResult = {
  imported: number;
  // The rows this tick inserted, for the desk's refresh (never announced).
  importedOrderIds: string[];
  // Nothing was fetched: no import running, no store, a disconnected store,
  // the regular sync still catching up, or a sync holding the lease.
  skipped?: "idle" | "no-connection" | "disabled" | "waiting" | "running";
  // The import ended with this tick.
  finished?: "done" | "failed";
  error?: string;
  // The lease or the import changed hands mid-tick (a cancel, a new import,
  // a connection save, a disconnect): no further write was made.
  superseded?: boolean;
};

type Progress = {
  status: "running" | "done" | "failed";
  cursor?: string | null;
  error: string | null;
};

export async function runBackfillTick(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  opts?: SyncOptions,
): Promise<BackfillTickResult> {
  const now = opts?.now?.() ?? Date.now();
  const result: BackfillTickResult = { imported: 0, importedOrderIds: [] };

  const pre = await readConnection(db, workspaceId);
  if (!pre) {
    return { ...result, skipped: "no-connection" };
  }
  if (pre.backfillStatus !== "running" || pre.backfillStartedAt === null) {
    return { ...result, skipped: "idle" };
  }
  if (pre.status === "disabled") {
    return { ...result, skipped: "disabled" };
  }
  // The regular sync goes first: while its cursor chain drains (a first
  // sync, a backlog) the import waits, so one tick never does both.
  if (pre.syncCursor !== null) {
    return { ...result, skipped: "waiting" };
  }
  const startedAt = pre.backfillStartedAt;
  const thisImport = and(
    eq(storeConnections.workspaceId, workspaceId),
    eq(storeConnections.backfillStatus, "running"),
    eq(storeConnections.backfillStartedAt, startedAt),
  );

  // A reconnect may have dropped read_all_orders since the start: Shopify
  // would then return only the last 60 days and the summary would mislead.
  if (needsReadAllOrders(pre.backfillSince, startedAt) && !canReadAllOrders(pre.scopes)) {
    await db
      .update(storeConnections)
      .set({ backfillStatus: "failed", backfillCursor: null, backfillFinishedAt: now, backfillError: SCOPE_MISSING })
      .where(thisImport);
    return { ...result, finished: "failed", error: SCOPE_MISSING };
  }

  // The sync's lease, taken the same way runSync takes it.
  const myLease = now + LEASE_MS;
  const leased = await db
    .update(storeConnections)
    .set({ runningUntil: myLease })
    .where(and(eq(storeConnections.workspaceId, workspaceId), lte(storeConnections.runningUntil, now)));
  if (changesOf(leased) === 0) {
    return { ...result, skipped: "running" };
  }

  // Whether this tick still holds the lease and its import is still the
  // running one. Order writes are not lease-conditional, so this is asked
  // after the fetch and before the write loop, like runSync's holdsLease.
  const stillOurs = async (): Promise<boolean> => {
    const row = await readConnection(db, workspaceId);
    return (
      row !== undefined &&
      row.runningUntil === myLease &&
      row.status !== "disabled" &&
      row.backfillStatus === "running" &&
      row.backfillStartedAt === startedAt
    );
  };

  // The tick's last write: the count of what it inserted (kept even if the
  // import was cancelled meanwhile, so a cancelled import's summary is
  // right), the progress (only while this import still runs), then the
  // lease release. Each is fenced on this tick's lease.
  const settle = async (progress: Progress | null): Promise<boolean> => {
    const ours = and(eq(storeConnections.workspaceId, workspaceId), eq(storeConnections.runningUntil, myLease));
    const statements: PromiseLike<unknown>[] = [];
    if (result.imported > 0) {
      statements.push(
        db
          .update(storeConnections)
          .set({ backfillImported: sql`${storeConnections.backfillImported} + ${result.imported}` })
          .where(and(ours, eq(storeConnections.backfillStartedAt, startedAt))),
      );
    }
    if (progress) {
      const ended = progress.status !== "running";
      statements.push(
        db
          .update(storeConnections)
          .set({
            backfillStatus: progress.status,
            backfillError: progress.error === null ? null : clip(progress.error),
            ...(ended ? { backfillCursor: null, backfillFinishedAt: now } : {}),
            ...(!ended && progress.cursor !== undefined ? { backfillCursor: progress.cursor } : {}),
          })
          .where(and(ours, thisImport)),
      );
    }
    statements.push(db.update(storeConnections).set({ runningUntil: 0 }).where(ours));
    const results = await applyBatch(db, statements);
    return changesOf(results[results.length - 1]) > 0;
  };

  const end = async (progress: Progress | null, extra: Partial<BackfillTickResult> = {}): Promise<BackfillTickResult> => {
    const held = await settle(progress);
    return { ...result, ...extra, ...(held ? {} : { superseded: true }) };
  };

  try {
    const connection = await readConnection(db, workspaceId);
    if (!connection || !(await stillOurs())) {
      return await end(null, { superseded: true });
    }

    const access = await accessTokenFor(db, env, connection, { fetchImpl: opts?.fetchImpl, now: () => now });
    if (access.kind === "unavailable") {
      return await end(null, { skipped: access.reason === "disabled" ? "disabled" : "no-connection" });
    }
    if (access.kind === "unreadable" || access.kind === "rejected") {
      const message = access.kind === "rejected" ? CREDENTIALS_REJECTED : CREDENTIALS_UNREADABLE;
      return await end({ status: "failed", error: message }, { finished: "failed", error: message });
    }
    if (access.kind === "transient") {
      return await end({ status: "running", error: access.detail }, { error: clip(access.detail) });
    }

    const since = connection.backfillSince;
    const until = backfillUntil(startedAt);
    const fetched = await fetchOrderHistory(
      connection.shopDomain,
      access.token,
      { sinceIso: since === null ? null : new Date(since).toISOString(), untilIso: new Date(until).toISOString() },
      opts?.fetchImpl ?? fetch,
      {
        startCursor: connection.backfillCursor ?? undefined,
        maxPages: BACKFILL_PAGES_PER_TICK,
        companies: companiesEnabled(connection.scopes),
      },
    );
    if (fetched.kind === "auth") {
      return await end({ status: "failed", error: CREDENTIALS_REJECTED }, { finished: "failed", error: CREDENTIALS_REJECTED });
    }
    if (fetched.kind === "transient") {
      // The cursor stays: the next tick retries the same stretch.
      return await end({ status: "running", error: fetched.detail }, { error: clip(fetched.detail) });
    }
    if (fetched.kind === "fatal") {
      // An error Shopify will repeat (a stale cursor, a refused query):
      // the admin sees it and can start again.
      return await end({ status: "failed", error: fetched.detail }, { finished: "failed", error: clip(fetched.detail) });
    }

    if (!(await stillOurs())) {
      return await end(null, { superseded: true });
    }

    // Only orders inside the range: anything newer is the regular sync's
    // (and announced there), whatever Shopify returned.
    const inRange = normalizeOrders(fetched.nodes).filter(
      (order) => order.createdAt > 0 && order.createdAt < until && (since === null || order.createdAt >= since),
    );
    const statusRows = await loadStatusRows(db, workspaceId);

    // Which of them are stored already: a plain read, no claim, because a
    // stored order is never written here.
    const known = new Set<string>();
    const ids = [...new Set(inRange.map((order) => order.shopifyOrderId))];
    for (let i = 0; i < ids.length; i += EXISTENCE_CHUNK) {
      const rows = await db
        .select({ shopifyOrderId: orders.shopifyOrderId })
        .from(orders)
        .where(and(eq(orders.workspaceId, workspaceId), inArray(orders.shopifyOrderId, ids.slice(i, i + EXISTENCE_CHUNK))));
      for (const row of rows) {
        if (row.shopifyOrderId !== null) {
          known.add(row.shopifyOrderId);
        }
      }
    }
    if (inRange.length > 0 && !(await stillOurs())) {
      return await end(null, { superseded: true });
    }

    for (const order of inRange) {
      if (known.has(order.shopifyOrderId)) {
        continue;
      }
      known.add(order.shopifyOrderId);
      const inserted = await insertNewOrder(db, workspaceId, order, now, statusRows, { imported: true });
      if (inserted.inserted) {
        result.imported++;
        result.importedOrderIds.push(inserted.orderId);
      }
    }

    if (fetched.truncated) {
      return await end({ status: "running", cursor: fetched.endCursor, error: null });
    }
    return await end({ status: "done", error: null }, { finished: "done" });
  } catch (e) {
    // Unexpected: the import keeps running from its cursor next tick, and
    // the counts so far go back so the caller can still refresh the desk.
    const message = clip(e instanceof Error ? e.message : "The import failed unexpectedly");
    return await end({ status: "running", error: message }, { error: message });
  }
}
