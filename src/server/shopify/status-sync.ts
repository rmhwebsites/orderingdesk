// Two-way status between the app and Shopify (platform amendment section 4).
// Relative imports on purpose: the sync engine and the cron path use this,
// and they are bundled into the custom worker entrypoint.
//
// App -> Shopify (pushOrderStatus), after a status change has committed:
// - the order carries exactly one tag "Ordering Desk: <Status label>": any
//   other tag starting with "Ordering Desk: " is removed (tagsRemove), then
//   the current one is added (tagsAdd). The tags are read first and nothing
//   is written when Shopify already shows the status. Labels are capped so
//   the tag fits Shopify's 40 characters (src/lib/status-label.ts).
// - a status linked to fulfilled also fulfills the order's open
//   fulfillment orders, with notifyCustomer false. Only for a change made in
//   the app: a move that came from Shopify never fulfills. A refused tag
//   write does not stop the fulfillment (the tag only shows the status).
// - the outcome is a shopify_write event (source system) on the order's
//   timeline, with Shopify's own words when it refused. The app's status is
//   never rolled back because Shopify failed.
//
// Shopify -> app (decideShopifyMove, applied by evaluateShopifyTransitions
// whenever the sync or a webhook lands a changed order snapshot). Only a
// CHANGE between the stored snapshot and the fresh one counts, never a state
// that was already there, so a person's later choice in the app is not
// overruled by a state Shopify reported long ago, and a failed push (Shopify
// still showing an old tag) can never pull the app's status back.
// - Tag edit: the fresh snapshot names exactly one status in an "Ordering
//   Desk: <label>" tag that the stored snapshot did not, and it is not the
//   order's current status: the order moves there, forward or backward (a
//   person chose it in Shopify). Labels match case-insensitively.
// - Fulfillment: Shopify's state rose (none < fulfilled < delivered): the
//   order moves to the status linked to the new state, only if that status
//   sorts after the current one (never backward past a later status). With
//   no status linked to delivered, a delivered order counts as fulfilled.
//   A tag edit in the same change wins over the fulfillment.
// - The Shopify state mapping (shopifyStateOf, over the stored snapshot):
//     delivered: displayFulfillmentStatus FULFILLED, and every fulfillment
//       that was not canceled shows DELIVERED or PICKED_UP (see deliveredOf
//       in normalize.ts for the exact rule, including the 3 fulfillment cap);
//     fulfilled: displayFulfillmentStatus FULFILLED otherwise;
//     none: anything else (UNFULFILLED, PARTIALLY_FULFILLED, IN_PROGRESS,
//       ON_HOLD, OPEN, PENDING_FULFILLMENT, SCHEDULED, RESTOCKED,
//       REQUEST_DECLINED).
// - Each move is a status event with source shopify and no actor.
//
// Echo safety. The app's own writes come back as webhooks:
// - its tag names the order's current status, and its fulfillment's linked
//   status is the current one, so applying them changes nothing;
// - a tag naming a status the order held within ECHO_WINDOW_MS is treated as
//   an older write of the app's own that landed late (two quick changes
//   push in parallel), never as a person's choice;
// - a push re-reads the status after writing and corrects the tag when the
//   status moved on meanwhile, so out-of-order pushes still leave Shopify
//   showing the current status;
// - every move is a compare-and-set on the status the decision was made
//   from, and evaluation runs only for snapshot writes that landed (the sync
//   engine's claim rule makes each snapshot change land exactly once).

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { applyBatch, rowsAffected } from "../../db/batch";
import { events, orders, statuses, storeConnections, type ShopifyLinkValue } from "../../db/schema";
import type { LiveOrderStatus } from "../../lib/live-events";
import { STATUS_TAG_PREFIX } from "../../lib/status-label";
import { eventView, type EventView } from "../desk/shapes";
import {
  addOrderTags,
  createFulfillment,
  failureText,
  fetchFulfillableOrderIds,
  fetchStatusTags,
  removeOrderTags,
  type AdminFailure,
} from "./admin";
import { getAccessToken, type AccessTokenResult } from "./token";

export { STATUS_TAG_PREFIX };
// How long a status the order held counts as a possible echo of the app's
// own tag write.
export const ECHO_WINDOW_MS = 10 * 60 * 1000;
// Rounds of re-reading and correcting the tag in one push.
const MAX_PUSH_ROUNDS = 3;
// D1 allows at most 100 bound parameters per statement.
const ID_CHUNK = 50;

export type StatusRow = {
  key: string;
  label: string;
  sort: number;
  shopifyLink: ShopifyLinkValue | null;
};

export type ShopifyState = "fulfilled" | "delivered" | null;
export type MoveReason = "tag" | "fulfilled" | "delivered";
export type StatusChange = { event: EventView; order: LiveOrderStatus };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Shopify splits tags on commas, so a comma in a label becomes a space
// (runs of spaces collapse to one).
export function statusTag(label: string): string {
  return (
    STATUS_TAG_PREFIX +
    label
      .split(",")
      .join(" ")
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .join(" ")
  );
}

function tagKey(tag: string): string {
  return tag.trim().toLowerCase();
}

function isStatusTag(tag: string): boolean {
  return tagKey(tag).startsWith(tagKey(STATUS_TAG_PREFIX));
}

// The snapshot's tags (stored joined with ", ").
function tagsOf(snapshot: unknown): string[] {
  const tags = isRecord(snapshot) ? snapshot.tags : undefined;
  return typeof tags === "string"
    ? tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    : [];
}

// Keys of the statuses that a status tag in the list names.
function statusesNamed(tags: string[], rows: readonly StatusRow[]): Set<string> {
  const wanted = new Set(tags.filter(isStatusTag).map(tagKey));
  return new Set(rows.filter((row) => wanted.has(tagKey(statusTag(row.label)))).map((row) => row.key));
}

export function shopifyStateOf(snapshot: unknown): ShopifyState {
  if (!isRecord(snapshot) || snapshot.fulfillmentStatus !== "fulfilled") {
    return null;
  }
  return snapshot.delivered === true ? "delivered" : "fulfilled";
}

const STATE_RANK = { none: 0, fulfilled: 1, delivered: 2 } as const;
const rankOf = (state: ShopifyState) => STATE_RANK[state ?? "none"];

function linkedTo(state: "fulfilled" | "delivered", rows: readonly StatusRow[]): StatusRow | undefined {
  return [...rows].sort((a, b) => a.sort - b.sort).find((row) => row.shopifyLink === state);
}

// The status for a Shopify state: its own link, or for delivered the
// fulfilled link when nothing is linked to delivered.
function statusForState(state: ShopifyState, rows: readonly StatusRow[]): StatusRow | undefined {
  if (state === "delivered") {
    return linkedTo("delivered", rows) ?? linkedTo("fulfilled", rows);
  }
  return state === "fulfilled" ? linkedTo("fulfilled", rows) : undefined;
}

// Where an order the app has never seen starts: the status its one status
// tag names, else the status linked to its Shopify state, else the first
// status. A new order gets no move event and no push (nothing changed in
// the app); its order_new event is the record.
export function initialStatusFor(snapshot: unknown, rows: readonly StatusRow[], defaultKey: string): string {
  const named = statusesNamed(tagsOf(snapshot), rows);
  if (named.size === 1) {
    return [...named][0];
  }
  return statusForState(shopifyStateOf(snapshot), rows)?.key ?? defaultKey;
}

export function decideShopifyMove(input: {
  before: unknown;
  after: unknown;
  currentKey: string;
  statuses: readonly StatusRow[];
  // Statuses this order was moved to within ECHO_WINDOW_MS.
  recentlyHeld: ReadonlySet<string>;
}): { to: StatusRow; reason: MoveReason } | null {
  const byKey = new Map(input.statuses.map((row) => [row.key, row]));

  const namedBefore = statusesNamed(tagsOf(input.before), input.statuses);
  const added = [...statusesNamed(tagsOf(input.after), input.statuses)].filter((key) => !namedBefore.has(key));
  if (added.length === 1 && added[0] !== input.currentKey && !input.recentlyHeld.has(added[0])) {
    const to = byKey.get(added[0]);
    if (to) {
      return { to, reason: "tag" };
    }
  }

  const was = shopifyStateOf(input.before);
  const now = shopifyStateOf(input.after);
  if (now !== null && rankOf(now) > rankOf(was)) {
    const to = statusForState(now, input.statuses);
    // A delivered order whose only link is fulfilled moves there only if it
    // was not fulfilled already.
    const usable = to && !(now === "delivered" && to.shopifyLink === "fulfilled" && rankOf(was) >= STATE_RANK.fulfilled);
    const current = byKey.get(input.currentKey);
    if (to && usable && to.key !== input.currentKey && (current === undefined || to.sort > current.sort)) {
      return { to, reason: now };
    }
  }
  return null;
}

// A cheap first look, with no database read: whether this snapshot change
// could move a status at all (a status tag changed, or Shopify's state rose).
function mightMove(before: unknown, after: unknown): boolean {
  const statusTags = (snapshot: unknown) => new Set(tagsOf(snapshot).filter(isStatusTag).map(tagKey));
  const was = statusTags(before);
  const now = statusTags(after);
  const tagsChanged = was.size !== now.size || [...now].some((tag) => !was.has(tag));
  return tagsChanged || rankOf(shopifyStateOf(after)) > rankOf(shopifyStateOf(before));
}

function moveText(label: string, reason: MoveReason): string {
  switch (reason) {
    case "tag":
      return `Status set to ${label} from the Ordering Desk tag in Shopify`;
    case "fulfilled":
      return `Status set to ${label}: Shopify reports the order fulfilled`;
    case "delivered":
      return `Status set to ${label}: Shopify reports the order delivered`;
  }
}

// Moves the order from fromKey to `to` with a status event (source shopify,
// no actor), both in one batch. A compare-and-set on fromKey: if someone
// changed the status since the decision, nothing is written and the result
// is null. The event is an insert-select that only yields its row when the
// order now carries exactly this move, so the two land together.
export async function applyShopifyMove(
  db: Db,
  workspaceId: string,
  orderId: string,
  fromKey: string,
  to: StatusRow,
  reason: MoveReason,
  now: number,
): Promise<StatusChange | null> {
  const event = {
    id: crypto.randomUUID(),
    workspaceId,
    orderId,
    type: "status" as const,
    text: moveText(to.label, reason),
    actorId: null,
    meta: { from: fromKey, to: to.key, reason },
    createdAt: now,
    source: "shopify" as const,
  };
  const statusExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${workspaceId} and ${statuses.key} = ${to.key})`;
  const moved = sql`exists (select 1 from ${orders} where ${orders.id} = ${orderId} and ${orders.statusKey} = ${to.key} and ${orders.statusSetAt} = ${now} and ${orders.statusSetBy} is null)`;
  const [update] = await applyBatch(db, [
    db
      .update(orders)
      .set({ statusKey: to.key, statusSetBy: null, statusSetAt: now })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.workspaceId, workspaceId),
          eq(orders.statusKey, fromKey),
          statusExists,
        ),
      ),
    // Values in the events table's column order (as in changeOrderStatus).
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${moved}`,
      ),
  ]);
  if (rowsAffected(update, "status-sync") === 0) {
    return null;
  }
  return {
    event: eventView(event),
    order: { id: orderId, statusKey: to.key, statusSetBy: null, statusSetAt: now },
  };
}

export type SnapshotTransition = { orderId: string; before: unknown; after: unknown };

export async function loadStatusRows(db: Db, workspaceId: string): Promise<StatusRow[]> {
  return db
    .select({ key: statuses.key, label: statuses.label, sort: statuses.sort, shopifyLink: statuses.shopifyLink })
    .from(statuses)
    .where(eq(statuses.workspaceId, workspaceId))
    .orderBy(asc(statuses.sort));
}

// Applies the Shopify -> app rules to snapshot changes that landed (old and
// new snapshot per order), against each order's current status. Returns the
// moves made, for the caller to broadcast and push (tag only).
export async function evaluateShopifyTransitions(
  db: Db,
  workspaceId: string,
  transitions: readonly SnapshotTransition[],
  now: number,
): Promise<StatusChange[]> {
  const candidates = transitions.filter((t) => mightMove(t.before, t.after));
  if (candidates.length === 0) {
    return [];
  }
  const rows = await loadStatusRows(db, workspaceId);
  const ids = [...new Set(candidates.map((t) => t.orderId))];
  const current = new Map<string, string>();
  const held = new Map<string, Set<string>>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const orderRows = await db
      .select({ id: orders.id, statusKey: orders.statusKey })
      .from(orders)
      .where(and(eq(orders.workspaceId, workspaceId), inArray(orders.id, chunk)));
    for (const row of orderRows) {
      current.set(row.id, row.statusKey);
    }
    const recent = await db
      .select({ orderId: events.orderId, meta: events.meta })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          inArray(events.orderId, chunk),
          eq(events.type, "status"),
          gte(events.createdAt, now - ECHO_WINDOW_MS),
        ),
      );
    for (const row of recent) {
      const to = isRecord(row.meta) && typeof row.meta.to === "string" ? row.meta.to : null;
      if (row.orderId && to) {
        const set = held.get(row.orderId) ?? new Set<string>();
        set.add(to);
        held.set(row.orderId, set);
      }
    }
  }

  const changes: StatusChange[] = [];
  for (const transition of candidates) {
    const currentKey = current.get(transition.orderId);
    if (currentKey === undefined) {
      continue;
    }
    const decision = decideShopifyMove({
      before: transition.before,
      after: transition.after,
      currentKey,
      statuses: rows,
      recentlyHeld: held.get(transition.orderId) ?? new Set(),
    });
    if (!decision) {
      continue;
    }
    const change = await applyShopifyMove(db, workspaceId, transition.orderId, currentKey, decision.to, decision.reason, now);
    if (change) {
      changes.push(change);
      current.set(transition.orderId, decision.to.key);
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// App -> Shopify

export type PushOptions = {
  // Fulfill the order when its status is linked to fulfilled. True for a
  // change made in the app, false for a move that came from Shopify.
  fulfill: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type PushOutcome = { done: string[]; fulfillments: number; failure: string | null };

function tokenFailureText(token: Exclude<AccessTokenResult, { kind: "ok" | "unavailable" }>): string {
  switch (token.kind) {
    case "unreadable":
      return "the store credentials cannot be read; reconnect the store in Settings";
    case "rejected":
      return `Shopify rejected the store credentials (${token.detail}); reconnect the store in Settings`;
    case "transient":
      return token.detail;
  }
}

// One round of writing the status to Shopify: read the tags, fix them, and
// fulfill when asked. The tag and the fulfillment are separate steps: a
// refused tag write still lets the fulfillment run, and the outcome names
// what landed and every refusal. Only an order Shopify no longer has stops
// everything.
async function writeStatus(
  shopDomain: string,
  token: string,
  orderGid: string,
  status: { label: string; shopifyLink: StatusRow["shopifyLink"] },
  fulfill: boolean,
  fetchImpl: typeof fetch,
): Promise<PushOutcome> {
  const done: string[] = [];
  const failures: string[] = [];
  let fulfillments = 0;
  const text = (failure: AdminFailure | string) => (typeof failure === "string" ? failure : failureText(failure));
  const outcome = (): PushOutcome => ({
    done,
    fulfillments,
    failure: failures.length > 0 ? failures.map((failure) => failure.replace(/[.\s]+$/, "")).join("; ") : null,
  });
  const desired = statusTag(status.label);

  const current = await fetchStatusTags(shopDomain, token, orderGid, fetchImpl);
  if (current.kind === "ok" && current.tags === null) {
    failures.push("Shopify no longer has this order");
    return outcome();
  }
  if (current.kind !== "ok") {
    failures.push(text(current));
  } else {
    const tags = current.tags ?? [];
    const stale = tags.filter((tag) => isStatusTag(tag) && tag !== desired);
    let tagged = true;
    if (stale.length > 0) {
      const removed = await removeOrderTags(shopDomain, token, orderGid, stale, fetchImpl);
      if (removed.kind !== "ok") {
        failures.push(text(removed));
        tagged = false;
      }
    }
    if (tagged && !tags.includes(desired)) {
      const added = await addOrderTags(shopDomain, token, orderGid, [desired], fetchImpl);
      if (added.kind !== "ok") {
        failures.push(text(added));
        tagged = false;
      }
    }
    if (tagged && (stale.length > 0 || !tags.includes(desired))) {
      done.push(`tagged ${desired}`);
    }
  }

  if (fulfill && status.shopifyLink === "fulfilled") {
    const open = await fetchFulfillableOrderIds(shopDomain, token, orderGid, fetchImpl);
    if (open.kind !== "ok") {
      failures.push(text(open));
    } else if (open.ids === null) {
      failures.push("Shopify no longer has this order");
    } else {
      for (const fulfillmentOrderId of open.ids) {
        const created = await createFulfillment(shopDomain, token, fulfillmentOrderId, fetchImpl);
        if (created.kind !== "ok") {
          failures.push(text(created));
          break;
        }
        fulfillments++;
      }
      if (fulfillments > 0) {
        done.push("marked fulfilled without emailing the customer");
      }
    }
  }
  return outcome();
}

function outcomeText(outcome: PushOutcome): string {
  if (outcome.failure === null) {
    return `Shopify updated: ${outcome.done.join(", ")}`;
  }
  // Shopify's own sentence may end in a period already.
  const reason = outcome.failure.replace(/[.\s]+$/, "");
  return outcome.done.length > 0
    ? `Shopify was only partly updated (${outcome.done.join(", ")}): ${reason}. The status here is kept.`
    : `Shopify was not updated: ${reason}. The status here is kept.`;
}

async function recordOutcome(
  db: Db,
  workspaceId: string,
  orderId: string,
  outcome: PushOutcome,
  status: { key: string; label: string },
  now: number,
): Promise<EventView> {
  const event = {
    id: crypto.randomUUID(),
    workspaceId,
    orderId,
    type: "shopify_write" as const,
    text: outcomeText(outcome),
    actorId: null,
    meta: {
      ok: outcome.failure === null,
      tag: statusTag(status.label),
      statusKey: status.key,
      fulfillments: outcome.fulfillments,
    },
    createdAt: now,
    source: "system" as const,
  };
  await db.insert(events).values(event);
  return eventView(event);
}

// The innermost error message, unless it is drizzle's "Failed query" text
// (which lists bound params). Never a payload. Shared with the webhook
// receiver's logging.
export function safeErrorReason(e: unknown): string {
  let current = e;
  for (let depth = 0; depth < 10 && current instanceof Error && current.cause instanceof Error; depth++) {
    current = current.cause;
  }
  const message = current instanceof Error ? current.message : "";
  return message.length > 0 && !message.startsWith("Failed query:") ? message.slice(0, 200) : "unexpected error";
}

// Writes the order's current status to Shopify and records the outcome
// (see the header). Returns the shopify_write events it recorded, for the
// caller to broadcast. Nothing happens for a workspace without a connected
// store, or when Shopify already shows the status. Never throws: this runs
// after the status change has committed and its response has gone.
export async function pushOrderStatus(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  orderId: string,
  opts: PushOptions,
): Promise<EventView[]> {
  const recorded: EventView[] = [];
  try {
    const connections = await db
      .select({ status: storeConnections.status })
      .from(storeConnections)
      .where(eq(storeConnections.workspaceId, workspaceId))
      .limit(1);
    if (!connections[0] || connections[0].status === "disabled") {
      return recorded;
    }
    const clock = opts.now ?? Date.now;
    const fetchImpl = opts.fetchImpl ?? fetch;
    let fulfill = opts.fulfill;
    let token: AccessTokenResult | null = null;

    for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
      const orderRows = await db
        .select({ shopifyId: orders.shopifyOrderId, statusKey: orders.statusKey, statusSetAt: orders.statusSetAt })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
        .limit(1);
      const order = orderRows[0];
      if (!order) {
        break;
      }
      const statusRows = await db
        .select({ key: statuses.key, label: statuses.label, shopifyLink: statuses.shopifyLink })
        .from(statuses)
        .where(and(eq(statuses.workspaceId, workspaceId), eq(statuses.key, order.statusKey)))
        .limit(1);
      const status = statusRows[0];
      if (!status) {
        break;
      }

      token ??= await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
      if (token.kind === "unavailable") {
        break;
      }
      if (token.kind !== "ok") {
        recorded.push(
          await recordOutcome(
            db,
            workspaceId,
            orderId,
            { done: [], fulfillments: 0, failure: tokenFailureText(token) },
            status,
            clock(),
          ),
        );
        break;
      }

      const outcome = await writeStatus(
        token.shopDomain,
        token.token,
        `gid://shopify/Order/${order.shopifyId}`,
        status,
        fulfill,
        fetchImpl,
      );
      if (outcome.done.length > 0 || outcome.failure !== null) {
        recorded.push(await recordOutcome(db, workspaceId, orderId, outcome, status, clock()));
      }
      if (outcome.failure !== null) {
        break;
      }

      // Did the status move on while Shopify was being written? Then this
      // round may have landed after a newer push: write the current status
      // again (tag only; the newer change does its own fulfilling).
      const after = await db
        .select({ statusKey: orders.statusKey, statusSetAt: orders.statusSetAt })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!after[0] || (after[0].statusKey === order.statusKey && after[0].statusSetAt === order.statusSetAt)) {
        break;
      }
      fulfill = false;
    }
  } catch (e) {
    console.warn("[shopify-push] " + JSON.stringify({ workspaceId, orderId, error: safeErrorReason(e) }));
  }
  return recorded;
}
