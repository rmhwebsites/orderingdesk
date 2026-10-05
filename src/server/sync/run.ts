// One workspace's Shopify sync pass: lease, fetch, normalize, upsert, record.
// Relative imports on purpose: this module is bundled into the custom worker
// entrypoint (cron), not only the Next.js build.

import { and, desc, eq, inArray, lt, lte } from "drizzle-orm";
import type { Db } from "../../db";
import { applyBatch, rowsAffected } from "../../db/batch";
import { events, orders, storeConnections } from "../../db/schema";
import { fetchOrdersUpdatedSince } from "../shopify/client";
import { accessTokenFor } from "../shopify/token";
import { normalizeOrders, type NormalizedOrder } from "../shopify/normalize";
import {
  evaluateShopifyTransitions,
  initialStatusFor,
  loadStatusRows,
  type SnapshotTransition,
  type StatusChange,
  type StatusRow,
} from "../shopify/status-sync";

export type SyncResult = {
  added: number;
  updated: number;
  // Order row ids inserted / snapshot-updated this run. Phase 5/6 call sites
  // broadcast to the workspace room and fan out notifications from these.
  // Both lists are rows-affected truth: an id appears only when this run's
  // own write changed exactly one row, also on a superseded or failed run.
  addedOrderIds: string[];
  updatedOrderIds: string[];
  skipped?: "running" | "no-connection" | "disabled";
  error?: string;
  // True when another run took over the lease mid-flight; this run wrote no
  // terminal connection state and its lastError/status must not be trusted.
  // added / updated still list exactly the order rows this run landed.
  superseded?: boolean;
  // Status moves made by the Shopify -> app rules (status-sync.ts) for the
  // snapshot changes this run landed. Present only when there are any. The
  // caller broadcasts them and writes the new status tag to Shopify.
  statusChanges?: StatusChange[];
};

export type SyncOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

// Exported for the order history import (backfill.ts), which takes the same
// lease so it never runs at the same time as a sync of the same workspace.
export const LEASE_MS = 120000;
// Re-fetch a 5 minute overlap so clock skew between this worker and Shopify
// cannot drop orders updated right around the previous lastSyncAt.
const OVERLAP_MS = 300000;
// Also how far back Shopify lets an app read orders without the
// read_all_orders scope (the order history import checks against it).
export const FIRST_SYNC_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const LAST_ERROR_MAX = 300;
const SYNC_ERROR_EVENT_WINDOW_MS = 3600000;
// D1 allows at most 100 bound parameters per statement; each chunk binds its
// ids plus the workspaceId, so 50 leaves comfortable headroom.
// Exported for the regression test that pins the parameter math.
export const EXISTENCE_CHUNK = 50;

const TOKEN_UNREADABLE = "Token unreadable, re-enter it in Settings";
const CREDENTIALS_UNREADABLE = "Store credentials unreadable, reconnect the store in Settings";
const TOKEN_REJECTED = "Shopify rejected the token. Update the connection in Settings.";
const credentialsRejected = (detail: string) =>
  `Shopify rejected the app's Client ID and secret (${detail}). Reconnect the store in Settings.`;

function clip(text: string): string {
  return text.slice(0, LAST_ERROR_MAX);
}

// Rows affected by a write, across drivers (see rowsAffected in
// src/db/batch.ts). An unknown shape counts as 1 and is logged as "[sync]":
// a double-run is idempotent, a never-run is an outage.
function changesOf(result: unknown): number {
  return rowsAffected(result, "sync");
}

// Two statements that must land together: db.batch on D1 (atomic), sequential
// awaits on the better-sqlite3 test driver. A two-statement applyBatch (see
// src/db/batch.ts for the semantics); returns the per-statement results so
// callers can read rows-affected. Exported for its own unit tests.
export async function applyPair(
  db: Db,
  a: PromiseLike<unknown>,
  b: PromiseLike<unknown>,
): Promise<unknown[]> {
  return applyBatch(db, [a, b]);
}

type ConnectionWrite = Partial<typeof storeConnections.$inferInsert>;

// Terminal connection writes are fenced on the exact lease value this run
// set: if another run has re-leased (or released) the row since, zero rows
// match, nothing is written, and the caller reports superseded.
//
// What the fence protects: the store_connections row only (status, lastError,
// lastSyncAt, the sync cursor fields, and the lease release itself). A run
// that outlived its lease can never overwrite a newer run's connection state
// or free a lease it no longer owns.
//
// What the fence does NOT cover: writes to orders and events, which are not
// lease-conditional statements. Instead runSync re-reads its lease
// (holdsLease) right after its fetch returns, before each further existence
// chunk, and once more after the last chunk, just before its write loop. A
// run that has lost the lease by then (another run took it over, a
// connection save or a disconnect released it) returns
// superseded and writes no order and no event. The only rows such a run may
// have touched are the claim stamps of chunks it read before losing the
// lease (synced_at moved forward to its now), which are harmless: any later
// run starts with a larger now and claims past them.
//
// What can still land: a run superseded after its last check, that is during
// its write loop, finishes that loop. Its first write follows its last check
// within one round trip. Those rows are made safe on their own terms:
// - order + order_new event inserts are conflict no-ops with a deterministic
//   event id, so a replay or a racing run inserts nothing twice;
// - stored snapshots follow claim-then-read (see claimAndLoad): the run that
//   started latest owns every order row it has looked at, whether or not it
//   had anything to write there, and an older run's snapshot UPDATE matches
//   no such row;
// - added / updated counts and ids come from rows-affected, so a write that
//   was a no-op or was guarded away is never reported.
// For a store change the gap is narrower still: saveConnection refuses to
// change the shop of a workspace that has orders (the check is inside its
// upsert), so another store's orders can only land if that upsert falls
// between a run's last lease check and its first insert.
// Ownership orders runs by start time, not by fetch time: a zombie's snapshot
// is dropped even when it was fetched after the newer run's. That is safe
// because such a change happened after the newer run's now, so the next
// window (lastSyncAt minus overlap) picks it up again.
async function fencedConnectionWrite(
  db: Db,
  workspaceId: string,
  myLease: number,
  set: ConnectionWrite,
): Promise<boolean> {
  const result = await db
    .update(storeConnections)
    .set(set)
    .where(
      and(
        eq(storeConnections.workspaceId, workspaceId),
        eq(storeConnections.runningUntil, myLease),
      ),
    );
  return changesOf(result) > 0;
}

// Whether this run still holds the lease it set: false once another run has
// re-leased the row, or a connection save or a disconnect (which disables
// the row) has released it; also false if the row is gone. Order and event
// writes are not lease-conditional, so runSync
// asks this before it writes any (see the fence comment above).
async function holdsLease(db: Db, workspaceId: string, myLease: number): Promise<boolean> {
  const rows = await db
    .select({ runningUntil: storeConnections.runningUntil })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  return rows[0]?.runningUntil === myLease;
}

// What a truncated run leaves in store_connections.sync_cursor: the Shopify
// cursor to resume from, prefixed with the run start (now) of the tick that
// opened the cursor chain, as "<ms>|<cursor>". The chain start is the anchor
// a finished chain needs (see the terminal write in runSync), and it rides in
// the same value as the cursor so the two are written, carried forward and
// cleared together, and so the engine needs no column beyond the two that
// migration 0003 added. A bare cursor with no prefix (a row written before
// the chain start was recorded) reads as a chain whose start is unknown.
const RESUME_TOKEN = /^(\d{1,15})\|([\s\S]+)$/;

function resumeToken(openedAt: number, cursor: string): string {
  return `${Math.max(0, Math.trunc(openedAt))}|${cursor}`;
}

function parseResumeToken(stored: unknown): { cursor: string; openedAt: number | null } | null {
  if (typeof stored !== "string" || stored.length === 0) {
    return null;
  }
  const parts = stored.match(RESUME_TOKEN);
  return parts
    ? { cursor: parts[2], openedAt: Number(parts[1]) }
    : { cursor: stored, openedAt: null };
}

export type KnownOrder = { id: string; shopify: unknown };

// Claim, then read. orders.synced_at is the start time (now) of the latest
// run that has looked at the row. Before a run reads stored snapshots to
// compare them with what it fetched, it stamps its own now on those rows,
// forward only (never over a later run's stamp). From that statement on, no
// run that started earlier can change them: its claim needs synced_at below,
// and its snapshot UPDATE synced_at at or below, its own smaller now. So
// what this run reads afterwards is stable against every older run, and a
// row it then leaves alone because the snapshots match stays protected
// exactly like a row it rewrites. Stamping only after the compare would not
// do: an older run's write could land between the read and the stamp and be
// blessed by it.
// One claim UPDATE plus one SELECT per chunk of ids, both inside the D1
// bound-parameter cap.
export async function claimAndLoad(
  db: Db,
  workspaceId: string,
  shopifyIds: string[],
  now: number,
  into: Map<string, KnownOrder>,
): Promise<void> {
  const inChunk = and(
    eq(orders.workspaceId, workspaceId),
    inArray(orders.shopifyOrderId, shopifyIds),
  );
  await db
    .update(orders)
    .set({ syncedAt: now })
    .where(and(inChunk, lt(orders.syncedAt, now)));
  const rows = await db
    .select({ id: orders.id, shopifyOrderId: orders.shopifyOrderId, shopify: orders.shopify })
    .from(orders)
    .where(inChunk);
  for (const row of rows) {
    into.set(row.shopifyOrderId, { id: row.id, shopify: row.shopify });
  }
}

export type OrderWriteOutcome =
  | { kind: "added"; orderId: string }
  // before: the stored snapshot this write replaced.
  | { kind: "updated"; orderId: string; before: unknown }
  | { kind: "none" };

// Inserts an order the app has never stored, with its initial status
// (initialStatusFor: its one status tag, else the status linked to its
// Shopify state, else the first status) and its order_new event. Both
// inserts are conflict no-ops and the event id is deterministic across runs
// (workspace + Shopify order), so a racing run that lost inserts nothing;
// inserted is rows-affected truth. Nothing is written to Shopify.
//
// imported: the order comes from the order history import (backfill.ts).
// Its notification is claimed at once (notified_at set), so no path ever
// announces it as a new order, and its order_new event says it was
// imported and carries meta.imported, which keeps it out of the bell.
export async function insertNewOrder(
  db: Db,
  workspaceId: string,
  order: NormalizedOrder,
  now: number,
  statusRows: readonly StatusRow[],
  opts?: { imported?: boolean },
): Promise<{ inserted: boolean; orderId: string }> {
  const orderId = crypto.randomUUID();
  const imported = opts?.imported === true;
  const insertOrder = db
    .insert(orders)
    .values({
      id: orderId,
      workspaceId,
      shopifyOrderId: order.shopifyOrderId,
      name: order.name,
      shopify: order,
      statusKey: initialStatusFor(order, statusRows, statusRows[0]?.key ?? "new"),
      createdAt: order.createdAt || now,
      syncedAt: now,
      ...(imported ? { notifiedAt: now } : {}),
    })
    .onConflictDoNothing();
  const insertEvent = db
    .insert(events)
    .values({
      id: `evt-order-new-${workspaceId}-${order.shopifyOrderId}`,
      workspaceId,
      orderId,
      type: "order_new",
      text: imported
        ? `Order ${order.name} imported from the store's order history`
        : `New order ${order.name}${order.customerName ? " from " + order.customerName : ""}`,
      meta: imported ? { orderName: order.name, imported: true } : { orderName: order.name },
      createdAt: now,
      source: "shopify",
    })
    .onConflictDoNothing();
  const [orderInsertResult] = await applyPair(db, insertOrder, insertEvent);
  return { inserted: changesOf(orderInsertResult) === 1, orderId };
}

// Writes one fetched order under the claim rule (see claimAndLoad and the
// fence comment above), the one write path for the sync and for webhooks:
// - not known: insert it with its initial status (initialStatusFor: its one
//   status tag, else the status linked to its Shopify state, else the first
//   status) and its order_new event, both conflict no-ops with a
//   deterministic event id. If another run stored it first, that row is
//   claimed, loaded and treated as known.
// - known with a different snapshot: refresh the snapshot only, guarded on
//   synced_at so a row claimed by a run that started later is left alone.
// `known` is the claimed existence map; it is kept current so a duplicate
// later in the same batch takes the update path. Outcomes are rows-affected
// truth.
export async function writeOrderSnapshot(
  db: Db,
  workspaceId: string,
  order: NormalizedOrder,
  now: number,
  statusRows: readonly StatusRow[],
  known: Map<string, KnownOrder>,
): Promise<OrderWriteOutcome> {
  let existing = known.get(order.shopifyOrderId);

  if (!existing) {
    // A racing run that stored this order first is detected by
    // rows-affected (see insertNewOrder).
    const { inserted, orderId } = await insertNewOrder(db, workspaceId, order, now, statusRows);
    if (inserted) {
      known.set(order.shopifyOrderId, { id: orderId, shopify: order });
      return { kind: "added", orderId };
    }
    // The insert was a conflict no-op: another run stored this order after
    // our existence read, possibly from an older fetch than ours. Claim
    // and load that row, then treat it like any other existing order.
    await claimAndLoad(db, workspaceId, [order.shopifyOrderId], now, known);
    existing = known.get(order.shopifyOrderId);
    if (!existing) {
      return { kind: "none" };
    }
  }

  if (JSON.stringify(existing.shopify) === JSON.stringify(order)) {
    return { kind: "none" };
  }
  // Stable diff: normalizeOrders builds keys in one fixed order and JSON
  // parse/stringify round-trips preserve it, so equal snapshots always
  // stringify identically.
  // Refresh the snapshot only. statusKey / statusSetBy / statusSetAt are
  // the team's own fields and a snapshot write never clobbers them (the
  // Shopify -> app rules move a status separately, as their own event), and
  // an updated snapshot gets no new event (order_new is for new orders only).
  // Guarded on synced_at: the orders table is outside the lease fence, so a
  // run that outlived its lease may still get here. A row claimed or written
  // by a run that started later carries a larger synced_at and does not
  // match; rows-affected says whether the write landed.
  const snapshotResult = await db
    .update(orders)
    .set({ shopify: order, syncedAt: now })
    .where(and(eq(orders.id, existing.id), lte(orders.syncedAt, now)));
  if (changesOf(snapshotResult) !== 1) {
    return { kind: "none" };
  }
  known.set(order.shopifyOrderId, { id: existing.id, shopify: order });
  return { kind: "updated", orderId: existing.id, before: existing.shopify };
}

// One order outside a sync run (a webhook re-fetched it): claim, load and
// write it through writeOrderSnapshot, then apply the Shopify -> app status
// rules to a snapshot change that landed. `now` must be taken before the
// order was fetched, exactly like a run's now: ownership of the row goes by
// that start time, so a webhook and a sync run can never write an older
// snapshot over a newer one, whichever lands last. The webhook takes no
// sync lease (it would skip or stall behind a run); the lease guards the
// connection state, and the caller re-checks the connection before calling
// this, like a run's holdsLease (see src/server/shopify/webhooks.ts).
export async function upsertFetchedOrder(
  db: Db,
  workspaceId: string,
  order: NormalizedOrder,
  now: number,
): Promise<
  | { kind: "added"; orderId: string; statusChanges: StatusChange[] }
  | { kind: "updated"; orderId: string; statusChanges: StatusChange[] }
  | { kind: "unchanged" }
> {
  const statusRows = await loadStatusRows(db, workspaceId);
  const known = new Map<string, KnownOrder>();
  await claimAndLoad(db, workspaceId, [order.shopifyOrderId], now, known);
  const outcome = await writeOrderSnapshot(db, workspaceId, order, now, statusRows, known);
  if (outcome.kind === "added") {
    return { kind: "added", orderId: outcome.orderId, statusChanges: [] };
  }
  if (outcome.kind === "none") {
    return { kind: "unchanged" };
  }
  const statusChanges = await evaluateShopifyTransitions(
    db,
    workspaceId,
    [{ orderId: outcome.orderId, before: outcome.before, after: order }],
    now,
  );
  return { kind: "updated", orderId: outcome.orderId, statusChanges };
}

export async function runSync(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  opts?: SyncOptions,
): Promise<SyncResult> {
  const now = opts?.now?.() ?? Date.now();
  const empty = (): SyncResult => ({
    added: 0,
    updated: 0,
    addedOrderIds: [],
    updatedOrderIds: [],
  });

  const preLeaseRows = await db
    .select()
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const preLease = preLeaseRows[0];
  if (!preLease) {
    return { ...empty(), skipped: "no-connection" };
  }
  if (preLease.status === "disabled") {
    return { ...empty(), skipped: "disabled" };
  }

  // Lease CAS: only a run that finds the lease free (or expired) moves
  // running_until forward; a concurrent run matches zero rows and skips.
  // Should a run die mid-way, the lease expires after LEASE_MS and the
  // conflict-safe insert pairs below make the replay a no-op.
  const myLease = now + LEASE_MS;
  const leaseResult = await db
    .update(storeConnections)
    .set({ runningUntil: myLease })
    .where(
      and(eq(storeConnections.workspaceId, workspaceId), lte(storeConnections.runningUntil, now)),
    );
  if (changesOf(leaseResult) === 0) {
    return { ...empty(), skipped: "running" };
  }

  let added = 0;
  let updated = 0;
  const addedOrderIds: string[] = [];
  const updatedOrderIds: string[] = [];

  // The lease is held from here on: everything that can throw stays inside
  // this try so the catch path releases it through the fenced write.
  try {
    // The pre-lease row may be stale by the time the lease is ours (another
    // run may have finished in between); work from a fresh read.
    const connRows = await db
      .select()
      .from(storeConnections)
      .where(eq(storeConnections.workspaceId, workspaceId))
      .limit(1);
    const connection = connRows[0] ?? preLease;

    // legacy_token: the stored token. client_credentials: the cached token,
    // renewed first when it is near expiry (src/server/shopify/token.ts).
    const access = await accessTokenFor(db, env, connection, {
      fetchImpl: opts?.fetchImpl,
      now: () => now,
    });
    if (access.kind === "unavailable") {
      // Disconnected since the pre-lease read (a disconnect also releases
      // the lease, so this write normally matches nothing).
      const held = await fencedConnectionWrite(db, workspaceId, myLease, { runningUntil: 0 });
      return {
        ...empty(),
        skipped: access.reason === "disabled" ? "disabled" : "no-connection",
        ...(held ? {} : { superseded: true }),
      };
    }
    if (access.kind === "unreadable" || access.kind === "rejected") {
      const message = clip(
        access.kind === "rejected"
          ? credentialsRejected(access.detail)
          : connection.authMode === "client_credentials"
            ? CREDENTIALS_UNREADABLE
            : TOKEN_UNREADABLE,
      );
      const held = await fencedConnectionWrite(db, workspaceId, myLease, {
        status: "error",
        lastError: message,
        runningUntil: 0,
      });
      return { ...empty(), error: message, ...(held ? {} : { superseded: true }) };
    }
    if (access.kind === "transient") {
      // Like a transient fetch failure: status, lastSyncAt and any cursor
      // chain stay as they are, and the next tick tries again.
      const detail = clip(access.detail);
      const held = await fencedConnectionWrite(db, workspaceId, myLease, {
        lastError: detail,
        runningUntil: 0,
      });
      return { ...empty(), error: detail, ...(held ? {} : { superseded: true }) };
    }
    const token = access.token;

    // A persisted cursor means an earlier run stopped before the end of its
    // window: resume that exact window from the cursor instead of opening a
    // new one.
    const resume = parseResumeToken(connection.syncCursor);
    const resumeSince = connection.syncCursorSince;
    const resuming = resume !== null && typeof resumeSince === "number";
    const sinceMs = resuming
      ? resumeSince
      : connection.lastSyncAt === 0
        ? now - FIRST_SYNC_WINDOW_MS
        : Math.max(connection.lastSyncAt - OVERLAP_MS, 0);
    const sinceIso = new Date(sinceMs).toISOString();

    const fetched = await fetchOrdersUpdatedSince(
      connection.shopDomain,
      token,
      sinceIso,
      opts?.fetchImpl ?? fetch,
      resuming ? { startCursor: resume.cursor } : undefined,
    );

    if (fetched.kind === "auth") {
      const held = await fencedConnectionWrite(db, workspaceId, myLease, {
        status: "error",
        lastError: TOKEN_REJECTED,
        runningUntil: 0,
      });
      return { ...empty(), error: TOKEN_REJECTED, ...(held ? {} : { superseded: true }) };
    }

    if (fetched.kind === "transient" || fetched.kind === "fatal") {
      // Status, lastSyncAt and any cursor chain stay untouched so the next
      // cron tick retries from the same place; record what happened and
      // release the lease. A fatal while resuming also drops the chain
      // (Shopify cursors go stale), falling back to the plain window path
      // next tick.
      const detail = clip(fetched.detail);
      const held = await fencedConnectionWrite(db, workspaceId, myLease, {
        lastError: detail,
        runningUntil: 0,
        ...(fetched.kind === "fatal" && resuming
          ? { syncCursor: null, syncCursorSince: null }
          : {}),
      });
      if (!held) {
        return { ...empty(), error: fetched.detail, superseded: true };
      }
      if (fetched.kind === "fatal") {
        // One activity event per failure text per hour, judged against the
        // event stream itself: lastError flaps on interleaved transient blips
        // and must not be the dedup key.
        const recent = await db
          .select({ createdAt: events.createdAt })
          .from(events)
          .where(
            and(
              eq(events.workspaceId, workspaceId),
              eq(events.type, "sync_error"),
              eq(events.text, detail),
            ),
          )
          .orderBy(desc(events.createdAt))
          .limit(1);
        if (!recent[0] || recent[0].createdAt < now - SYNC_ERROR_EVENT_WINDOW_MS) {
          await db.insert(events).values({
            id: crypto.randomUUID(),
            workspaceId,
            orderId: null,
            type: "sync_error",
            text: detail,
            createdAt: now,
            source: "system",
          });
        }
      }
      return { ...empty(), error: fetched.detail };
    }

    // The fetch can take minutes. If the lease changed hands meanwhile (a
    // newer run, a connection save, a disconnect), what was fetched may
    // belong to a store this workspace no longer syncs: stop without writing
    // anything. Nothing the workspace still syncs is lost, because a
    // superseded run never advances lastSyncAt or the cursor; the next run
    // covers the same window (after a store change, a fresh first-sync one).
    if (!(await holdsLease(db, workspaceId, myLease))) {
      return { ...empty(), superseded: true };
    }

    const normalized = normalizeOrders(fetched.nodes);

    // Every status, in sort order: the first is where a new order starts
    // unless its tag or Shopify state says otherwise (initialStatusFor).
    const statusRows = await loadStatusRows(db, workspaceId);

    // Existence map in chunks instead of one SELECT per order (each chunk is
    // claimed before it is read, see claimAndLoad); maintained inside the loop
    // so a duplicate within the batch takes the update path.
    const existingByShopifyId = new Map<string, KnownOrder>();
    const shopifyIds = normalized.map((order) => order.shopifyOrderId);
    for (let i = 0; i < shopifyIds.length; i += EXISTENCE_CHUNK) {
      // The first chunk follows the check above; every later one re-checks.
      if (i > 0 && !(await holdsLease(db, workspaceId, myLease))) {
        return { ...empty(), superseded: true };
      }
      const chunk = shopifyIds.slice(i, i + EXISTENCE_CHUNK);
      await claimAndLoad(db, workspaceId, chunk, now, existingByShopifyId);
    }
    // Last check: the loop below is where this run writes order and event
    // rows, and a run superseded from here on finishes it (see the fence
    // comment for why those rows are safe).
    if (shopifyIds.length > 0 && !(await holdsLease(db, workspaceId, myLease))) {
      return { ...empty(), superseded: true };
    }

    const addedSet = new Set<string>();
    const updatedSet = new Set<string>();
    // Snapshot changes this run landed, for the Shopify -> app status rules.
    const transitions: SnapshotTransition[] = [];

    for (const order of normalized) {
      const outcome = await writeOrderSnapshot(db, workspaceId, order, now, statusRows, existingByShopifyId);
      if (outcome.kind === "added") {
        added++;
        addedOrderIds.push(outcome.orderId);
        addedSet.add(outcome.orderId);
      } else if (outcome.kind === "updated") {
        // An id added this run stays out of updatedOrderIds: a later
        // duplicate in the same payload refines the new order, it does not
        // "update" it.
        if (!addedSet.has(outcome.orderId) && !updatedSet.has(outcome.orderId)) {
          updated++;
          updatedOrderIds.push(outcome.orderId);
          updatedSet.add(outcome.orderId);
        }
        transitions.push({ orderId: outcome.orderId, before: outcome.before, after: order });
      }
    }

    // Shopify -> app status rules for the snapshot changes that landed. They
    // run even if the lease was lost during the loop: each change landed
    // exactly once (claim rule), so skipping it here would lose it for good.
    // A failure here costs only the moves, never the run's progress.
    let statusChanges: StatusChange[] = [];
    try {
      statusChanges = await evaluateShopifyTransitions(db, workspaceId, transitions, now);
    } catch (e) {
      console.warn(
        "[sync] " +
          JSON.stringify({ workspaceId, statusRules: e instanceof Error ? e.name : "failed" }),
      );
    }

    // When the window this run worked on was opened: this run's own now for
    // a fresh window, the now of the opening tick for a resumed cursor chain.
    // A chain whose start is unknown (a bare cursor) or impossible (later
    // than this run's own now, which no opening tick can have been) degrades
    // to the untouched lastSyncAt, which is never later than the true start.
    const chainOpenedAt =
      resuming && resume.openedAt !== null && resume.openedAt <= now ? resume.openedAt : null;
    const windowOpenedAt = resuming ? (chainOpenedAt ?? connection.lastSyncAt) : now;

    let terminal: ConnectionWrite;
    if (fetched.truncated) {
      // The run stopped before the end of its window (page cap, a page
      // without a cursor, a throttle or blip part-way). The client always
      // names the cursor to resume from, so progress is carried by the
      // cursor alone: persist it with the chain start and the window it
      // belongs to, and leave lastSyncAt untouched until the window is fully
      // drained. Nothing here is derived from the fetched nodes. In
      // particular the newest updatedAt among them is not an anchor: Shopify
      // hydrates a node fresh while still sorting it by a lagging index, so
      // that value can sit far ahead of orders the run never reached.
      terminal = {
        syncCursor: resumeToken(windowOpenedAt, fetched.endCursor),
        syncCursorSince: sinceMs,
        runningUntil: 0,
        status: "ok",
        lastError: null,
      };
    } else {
      // Window complete. One rule holds for both cases: lastSyncAt never
      // moves past the moment the window was opened. Shopify's updated_at
      // search can surface an order late, so a fetch only vouches for orders
      // that were searchable when it passed their sort position, and no
      // fetch of this window ran before it was opened. The next window
      // starts at the anchor minus the overlap, so an order is re-read
      // unless it surfaced more than the overlap after its update.
      // - completed plain window: this run's now, captured before the fetch;
      // - completed cursor chain: the opening tick's now, not the finishing
      //   tick's. The cursor never returns to an order that surfaced behind
      //   it, so anchoring at the finishing tick would skip such an order for
      //   good. Not a watermark of the fetched nodes either: besides not
      //   being a sort position, it re-fetches a dense burst inside the
      //   overlap on every other tick forever, whereas the chain start costs
      //   at most a bounded re-scan, because each new chain opens strictly
      //   later than the one before.
      const anchor = resuming ? Math.max(connection.lastSyncAt, windowOpenedAt) : now;
      terminal = {
        lastSyncAt: anchor,
        syncCursor: null,
        syncCursorSince: null,
        runningUntil: 0,
        status: "ok",
        lastError: null,
      };
    }
    const held = await fencedConnectionWrite(db, workspaceId, myLease, terminal);
    return {
      added,
      updated,
      addedOrderIds,
      updatedOrderIds,
      ...(held ? {} : { superseded: true }),
      ...(statusChanges.length > 0 ? { statusChanges } : {}),
    };
  } catch (e) {
    // Unexpected throw: release the lease and surface the message; the counts
    // so far go back so callers can still broadcast what landed.
    const message = clip(e instanceof Error ? e.message : "sync failed unexpectedly");
    const held = await fencedConnectionWrite(db, workspaceId, myLease, {
      lastError: message,
      runningUntil: 0,
    });
    return {
      added,
      updated,
      addedOrderIds,
      updatedOrderIds,
      error: message,
      ...(held ? {} : { superseded: true }),
    };
  }
}
