// Approve and Reject a request (draft orders spec section 9), behind
// POST /api/orders/[orderId]/approve and /reject. Managers and platform
// admins only: the routes check the role, and so does every function here.
//
// Approve completes the $0 draft in Shopify (draftOrderComplete with only
// its id, the same as Mark as paid) and the card becomes that order: the
// attach compare-and-set (src/server/sync/drafts.ts) keeps the card's id,
// notes, history, purchase orders and notified_at, so the order is never
// announced as new. Rules, in order:
// - a card that already is an order answers already-approved (a double
//   click, a retry);
// - refused (409) for a draft Shopify deleted, with no status linked to
//   draft_completed, or without the draft scopes;
// - the draft is read fresh: gone marks the card deleted; COMPLETED means
//   someone completed it in Shopify, so the card follows that order (the
//   completion move from Shopify) and nothing is sent; a total that is not
//   exactly 0, or a draft Shopify is still calculating (asked again up to
//   REVIEW_READY_TRIES times), is refused, and the mutation is never sent;
// - only an OPEN or INVOICE_SENT draft is completed;
// - the mutation is sent ONCE. "Not finished calculating" waits, reads the
//   draft again with every check above (gone, completed, state, a total of
//   exactly 0, ready) and tries once more: that refusal means the draft
//   changed after the first read, so its total may have too. Any other
//   refusal, a timeout or a transport failure is followed by a read, never
//   a blind retry: COMPLETED counts as done (another approval or a person
//   in Shopify won the race), still open reports what happened, and an
//   unanswered read says to check in Shopify. A completion Shopify reports
//   with a total that is not 0 is still recorded (it cannot be undone) and
//   logged with its ids;
// - the commit is one batch: the attach, the status (no from-key compare:
//   approval is decisive, including from Rejected), its status event and
//   the draft_completed event, each guarded or deterministic, so two
//   managers approving at once write nothing twice. An order card that
//   landed first is merged into the card (mergeOrderIntoDraft) and the
//   batch runs again once.
//
// Reject needs a reason (saved as a note), moves the card to the status
// linked to draft_rejected and changes nothing in Shopify by itself: the
// status tag "Ordering Desk: Rejected" is written to the DraftOrder after
// the response, like any status change. Nothing is deleted, nobody is
// emailed. A draft Shopify already deleted can still be rejected (the
// team's decision is recorded; no tag is written).
//
// After the response (followApproval, followRejection): open desks hear
// about it, members who follow all activity get one push, the order is
// fetched and written onto the card (never announced), and the status tag
// is written to Shopify. Best effort; never throws.

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch, rowsAffected } from "@/db/batch";
import { events, orders, statuses, storeConnections } from "@/db/schema";
import { formatMoney } from "@/lib/format";
import { NOTE_MAX } from "@/lib/limits";
import { roleAtLeast, type Role } from "@/lib/roles";
import { broadcast, broadcastMerges, broadcastSync } from "@/server/broadcast";
import { notifyActivity } from "@/server/notify";
import {
  completeDraft,
  draftGid,
  draftsEnabled,
  failureText,
  fetchDraftForApprove,
  fetchDraftNode,
  type DraftForApprove,
} from "@/server/shopify/admin";
import { pushAndShare, shareShopifyMoves } from "@/server/shopify/fanout";
import { normalizeDrafts, type NormalizedDraft } from "@/server/shopify/normalize";
import { evaluateShopifyTransitions, safeErrorReason, type StatusChange } from "@/server/shopify/status-sync";
import { getAccessToken } from "@/server/shopify/token";
import {
  attachOrderToDraft,
  completedEvent,
  ensureOrderSnapshots,
  insertCompletedEvent,
  isOrderIdTaken,
  markDraftDeleted,
  mergeOrderIntoDraft,
  type AttachInput,
  type DraftRow,
  type OrderMerge,
} from "@/server/sync/drafts";
import { eventView, isRecord, type EventView } from "./shapes";

// Times the draft is read again while Shopify is still calculating it, and
// the wait before each read (and before the one retry of the mutation).
export const REVIEW_READY_TRIES = 3;
export const REVIEW_RETRY_MS = 500;

export const REVIEW_COPY = {
  forbidden: "Only a manager can approve or reject requests.",
  deleted: "Shopify no longer has this draft. It may have been deleted there, so it cannot be approved.",
  noApprovedStatus: "No status follows Draft approved. A manager can set one in Settings > Statuses.",
  noRejectedStatus: "No status follows Draft rejected. A manager can set one in Settings > Statuses.",
  draftsOff:
    "Draft orders are not enabled for this store's Shopify app. A platform admin can grant read_draft_orders and write_draft_orders, then refresh the connection.",
  notReady: "Shopify is still calculating this draft. Try again in a few seconds.",
  unknownState: "Shopify reports this draft in a state Ordering Desk cannot approve. Check the draft in Shopify.",
  completedElsewhere: "This draft was already completed in Shopify. The card updates on the next sync.",
  notConfirmed: "Shopify did not confirm the approval. Nothing changed. Try again.",
  noAnswer: "Shopify did not answer. Check the draft in Shopify before trying again. The card updates on the next sync.",
  reason: "Give a reason (up to 4000 characters). It is saved as a note.",
  notConnected: "The store is not connected. A platform admin can connect it in Settings > Store connection.",
  unreadable: "The store credentials cannot be read. Reconnect the store in Settings.",
} as const;

export type ReviewDeps = {
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type ReviewContext = { workspaceId: string; orderId: string; userId: string; role: Role };

export type ReviewOrder = { id: string; statusKey: string; statusSetBy: string | null; statusSetAt: number | null };

// What the after-response work needs (followApproval).
export type ApprovalFollowUp = {
  order: ReviewOrder;
  // The approval's own status move, when it moved the card.
  statusEvent: EventView | null;
  // The draft_completed entry (whichever signal wrote it).
  completedEvent: EventView | null;
  // Moves that came from Shopify (a draft completed there).
  statusChanges: StatusChange[];
  merged: OrderMerge | null;
  // Write the card's status tag to Shopify (an approval made here; a move
  // from Shopify is pushed with statusChanges instead).
  pushStatus: boolean;
};

export type ApproveResult =
  | { kind: "not-found" }
  | { kind: "forbidden"; error: string }
  // 409 or 502 with the copy to show. deleted: the card was just marked
  // deleted (the route shares it).
  | { kind: "refused"; status: 409 | 502; error: string; deleted?: { orderId: string; event: EventView } }
  | { kind: "already-approved"; order: ReviewOrder; orderName: string }
  | {
      kind: "completed-in-shopify";
      message: string;
      orderName: string;
      order: ReviewOrder;
      follow: ApprovalFollowUp;
    }
  | {
      kind: "approved";
      order: ReviewOrder;
      orderName: string;
      shopifyOrderId: string;
      events: EventView[];
      // The approved status asks for a purchase order (the card is an order
      // now, so the review can open right away).
      triggersPo: boolean;
      merged?: OrderMerge;
      follow: ApprovalFollowUp;
    };

export type RejectResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "forbidden"; error: string }
  | { kind: "refused"; status: 409; error: string }
  | { kind: "unchanged" }
  | { kind: "rejected"; order: ReviewOrder; events: EventView[]; statusEvent: EventView; noteEvent: EventView };

type Card = DraftRow & {
  statusKey: string;
  statusSetBy: string | null;
  statusSetAt: number | null;
  draftDeletedAt: number | null;
};

type StatusInfo = { key: string; label: string; triggersPo: boolean };

type Access = { shopDomain: string; token: string; fetchImpl: typeof fetch };

const refused = <S extends 409 | 502>(status: S, error: string) => ({ kind: "refused" as const, status, error });

function sentence(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

function orderView(card: Pick<Card, "id" | "statusKey" | "statusSetBy" | "statusSetAt">): ReviewOrder {
  return { id: card.id, statusKey: card.statusKey, statusSetBy: card.statusSetBy, statusSetAt: card.statusSetAt };
}

async function loadCard(db: Db, workspaceId: string, orderId: string): Promise<Card | undefined> {
  const rows = await db
    .select({
      id: orders.id,
      shopifyOrderId: orders.shopifyOrderId,
      shopifyDraftId: orders.shopifyDraftId,
      draftName: orders.draftName,
      name: orders.name,
      shopify: orders.shopify,
      statusKey: orders.statusKey,
      statusSetBy: orders.statusSetBy,
      statusSetAt: orders.statusSetAt,
      draftDeletedAt: orders.draftDeletedAt,
    })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
    .limit(1);
  return rows[0];
}

// The status linked to a draft outcome (the first by sort; the statuses
// editor allows one).
async function linkedStatus(
  db: Db,
  workspaceId: string,
  link: "draft_completed" | "draft_rejected",
): Promise<StatusInfo | undefined> {
  const rows = await db
    .select({ key: statuses.key, label: statuses.label, triggersPo: statuses.triggersPo })
    .from(statuses)
    .where(and(eq(statuses.workspaceId, workspaceId), eq(statuses.shopifyLink, link)))
    .orderBy(asc(statuses.sort))
    .limit(1);
  return rows[0];
}

async function draftsOn(db: Db, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: storeConnections.scopes })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  return draftsEnabled(rows[0]?.scopes);
}

async function shopifyAccess(
  db: Db,
  workspaceId: string,
  deps: ReviewDeps,
): Promise<{ kind: "ok"; access: Access } | { kind: "refused"; status: 409 | 502; error: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await getAccessToken(db, deps.env, workspaceId, { fetchImpl, now: deps.now });
  switch (token.kind) {
    case "ok":
      return { kind: "ok", access: { shopDomain: token.shopDomain, token: token.token, fetchImpl } };
    case "unavailable":
      return refused(409, REVIEW_COPY.notConnected);
    case "unreadable":
      return refused(409, REVIEW_COPY.unreadable);
    case "rejected":
      return refused(409, `Shopify rejected the store credentials (${sentence(token.detail)}). Reconnect the store in Settings.`);
    case "transient":
      return refused(502, `Shopify did not answer (${sentence(token.detail)}). Nothing changed. Try again.`);
  }
}

function totalRefusal(draft: DraftForApprove): string | null {
  const total = draft.total;
  if (total !== null && total.trim().length > 0 && Number(total) === 0) {
    return null;
  }
  const amount = total !== null && total.trim().length > 0 ? formatMoney(total, draft.currency) : null;
  return amount
    ? `This draft totals ${amount}. Ordering Desk only approves drafts that total $0.00, so no payment is recorded by mistake. Complete it in Shopify instead.`
    : "Shopify did not report this draft's total. Ordering Desk only approves drafts that total $0.00, so no payment is recorded by mistake. Complete it in Shopify instead.";
}

// Shopify's draft states the mutation may be sent for.
const APPROVABLE_STATES = new Set(["OPEN", "INVOICE_SENT"]);

// Why a draft as just read must not be completed, or null. Every read that
// precedes a draftOrderComplete goes through this, the read before the
// "not finished calculating" retry included: that refusal means the draft
// changed after the first read (a line added or repriced in Shopify admin),
// so its total may no longer be 0, and a priced draft completed without a
// payment is marked paid for money nobody took.
function approvalRefusal(draft: DraftForApprove): string | null {
  if (draft.status === "COMPLETED") {
    return REVIEW_COPY.completedElsewhere;
  }
  if (!APPROVABLE_STATES.has(draft.status)) {
    return REVIEW_COPY.unknownState;
  }
  return totalRefusal(draft);
}

// The completed draft as the sync stores it, read in full (the approve
// pre-check carries only a few fields). Undefined when it cannot be read;
// the stored draft snapshot then stays until the order is written.
async function completedSnapshot(access: Access, gid: string, orderId: string): Promise<NormalizedDraft | undefined> {
  const fetched = await fetchDraftNode(access.shopDomain, access.token, gid, access.fetchImpl);
  if (fetched.kind !== "ok" || !fetched.node) {
    return undefined;
  }
  const [draft] = normalizeDrafts([fetched.node]);
  return draft && draft.status === "completed" && draft.orderId === orderId ? draft : undefined;
}

type Completion = { orderId: string; orderName: string | null; completedDraft?: NormalizedDraft };

// ---------------------------------------------------------------------------
// Approve

export async function approveRequest(db: Db, ctx: ReviewContext, deps: ReviewDeps): Promise<ApproveResult> {
  const clock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const card = await loadCard(db, ctx.workspaceId, ctx.orderId);
  if (!card) {
    return { kind: "not-found" };
  }
  if (!roleAtLeast(ctx.role, "manager")) {
    return { kind: "forbidden", error: REVIEW_COPY.forbidden };
  }
  if (card.shopifyOrderId !== null) {
    return { kind: "already-approved", order: orderView(card), orderName: card.name };
  }
  if (card.draftDeletedAt !== null || card.shopifyDraftId === null) {
    return refused(409, REVIEW_COPY.deleted);
  }
  const approved = await linkedStatus(db, ctx.workspaceId, "draft_completed");
  if (!approved) {
    return refused(409, REVIEW_COPY.noApprovedStatus);
  }
  if (!(await draftsOn(db, ctx.workspaceId))) {
    return refused(409, REVIEW_COPY.draftsOff);
  }
  const granted = await shopifyAccess(db, ctx.workspaceId, deps);
  if (granted.kind !== "ok") {
    return granted;
  }
  const { access } = granted;
  const draftId = card.shopifyDraftId;
  const gid = draftGid(draftId);

  const goneResult = async (): Promise<ApproveResult> => {
    const marked = await markDraftDeleted(db, ctx.workspaceId, draftId, clock());
    return {
      ...refused(409, REVIEW_COPY.deleted),
      ...(marked.kind === "deleted" ? { deleted: { orderId: marked.orderId, event: marked.event } } : {}),
    };
  };

  // A read after the mutation failed or was refused: completed counts as
  // done, whoever completed it.
  const doneIfCompleted = async (read: DraftForApprove): Promise<ApproveResult | null> => {
    if (read.status !== "COMPLETED" || read.orderId === null) {
      return null;
    }
    const completedDraft = await completedSnapshot(access, gid, read.orderId);
    return commitApproval(db, ctx, card, approved, { orderId: read.orderId, orderName: read.orderName, completedDraft }, clock);
  };

  // The fresh read before anything is sent.
  for (let attempt = 0; ; attempt++) {
    const read = await fetchDraftForApprove(access.shopDomain, access.token, gid, access.fetchImpl);
    if (read.kind !== "ok") {
      return refused(502, `Could not check the draft in Shopify (${sentence(failureText(read))}). Nothing changed. Try again.`);
    }
    if (read.draft === null) {
      return goneResult();
    }
    if (read.draft.status === "COMPLETED") {
      return followShopifyCompletion(db, ctx, card, read.draft, access, clock);
    }
    const refusal = approvalRefusal(read.draft);
    if (refusal) {
      return refused(409, refusal);
    }
    if (read.draft.ready) {
      break;
    }
    if (attempt >= REVIEW_READY_TRIES) {
      return refused(409, REVIEW_COPY.notReady);
    }
    await sleep(REVIEW_RETRY_MS);
  }

  let completed = await completeDraft(access.shopDomain, access.token, gid, access.fetchImpl);
  if (completed.kind === "refused" && /not finished calculating/i.test(completed.detail)) {
    await sleep(REVIEW_RETRY_MS);
    const again = await fetchDraftForApprove(access.shopDomain, access.token, gid, access.fetchImpl);
    if (again.kind !== "ok") {
      return refused(502, `Could not check the draft in Shopify (${sentence(failureText(again))}). Nothing changed. Try again.`);
    }
    if (again.draft === null) {
      return goneResult();
    }
    const done = await doneIfCompleted(again.draft);
    if (done) {
      return done;
    }
    // The same checks as the first read, before the mutation goes out again.
    const refusal = approvalRefusal(again.draft);
    if (refusal) {
      return refused(409, refusal);
    }
    if (!again.draft.ready) {
      return refused(409, REVIEW_COPY.notReady);
    }
    completed = await completeDraft(access.shopDomain, access.token, gid, access.fetchImpl);
  }

  if (completed.kind === "ok") {
    const [draft] = completed.node ? normalizeDrafts([completed.node]) : [];
    if (draft && draft.status === "completed" && draft.orderId !== null) {
      if (!(draft.total.trim().length > 0 && Number(draft.total) === 0)) {
        // Cannot happen after the checks above unless the draft changed
        // between the last read and the mutation. Shopify's completion
        // cannot be undone; ids only, so someone looks at the order at once.
        console.warn(
          "[review] " +
            JSON.stringify({ workspaceId: ctx.workspaceId, orderRowId: card.id, shopifyOrderId: draft.orderId, completedTotal: "not zero" }),
        );
      }
      return commitApproval(db, ctx, card, approved, { orderId: draft.orderId, orderName: draft.orderName, completedDraft: draft }, clock);
    }
  }

  // Refused, failed, timed out, or answered without the order: read the
  // draft again. Never send the mutation a second time.
  const after = await fetchDraftForApprove(access.shopDomain, access.token, gid, access.fetchImpl);
  if (after.kind === "ok" && after.draft !== null) {
    const done = await doneIfCompleted(after.draft);
    if (done) {
      return done;
    }
  }
  if (completed.kind === "refused" || completed.kind === "fatal") {
    return refused(409, `Shopify did not complete the draft: ${sentence(completed.detail)}.`);
  }
  if (after.kind !== "ok") {
    return refused(502, REVIEW_COPY.noAnswer);
  }
  if (after.draft === null) {
    return goneResult();
  }
  return refused(502, REVIEW_COPY.notConfirmed);
}

// The approval's batch: the attach, the status move and its event, and the
// draft_completed event.
function approvalStatements(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  approved: StatusInfo,
  input: AttachInput,
  orderName: string,
) {
  const now = input.now;
  const completed = completedEvent(ctx.workspaceId, card, input, orderName);
  const snapshot = input.completedDraft ?? sql`${orders.shopify}`;
  const statusEvent = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: card.id,
    type: "status" as const,
    text: `Approved the request. Status set to ${approved.label}`,
    actorId: ctx.userId,
    meta: { from: card.statusKey, to: approved.key, action: "approve", orderName },
    createdAt: now,
    source: "app" as const,
  };
  const statusExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${ctx.workspaceId} and ${statuses.key} = ${approved.key})`;
  const moved = sql`exists (select 1 from ${orders} where ${orders.id} = ${card.id} and ${orders.statusKey} = ${approved.key} and ${orders.statusSetAt} = ${now} and ${orders.statusSetBy} = ${ctx.userId})`;
  const statements = [
    db
      .update(orders)
      .set({
        shopifyOrderId: input.orderId,
        name: orderName,
        draftSnapshot: snapshot,
        shopify: snapshot,
        syncedAt: sql`max(${orders.syncedAt}, ${now})`,
      })
      .where(and(eq(orders.id, card.id), eq(orders.workspaceId, ctx.workspaceId), isNull(orders.shopifyOrderId))),
    db
      .update(orders)
      .set({ statusKey: approved.key, statusSetBy: ctx.userId, statusSetAt: now })
      .where(
        and(
          eq(orders.id, card.id),
          eq(orders.workspaceId, ctx.workspaceId),
          eq(orders.shopifyOrderId, input.orderId),
          ne(orders.statusKey, approved.key),
          statusExists,
        ),
      ),
    // Values in the events table's column order (as in changeOrderStatus).
    db
      .insert(events)
      .select(
        sql`select ${statusEvent.id}, ${statusEvent.workspaceId}, ${statusEvent.orderId}, ${statusEvent.type}, ${statusEvent.text}, ${statusEvent.actorId}, ${JSON.stringify(statusEvent.meta)}, ${statusEvent.createdAt}, ${statusEvent.source} where ${moved}`,
      ),
    insertCompletedEvent(db, completed),
  ];
  return { statements, statusEventId: statusEvent.id, completedEventId: completed.id };
}

async function commitApproval(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  approved: StatusInfo,
  completion: Completion,
  clock: () => number,
): Promise<ApproveResult> {
  const now = clock();
  const orderName = completion.orderName ?? card.name;
  const input: AttachInput = {
    draftRowId: card.id,
    orderId: completion.orderId,
    orderName,
    ...(completion.completedDraft ? { completedDraft: completion.completedDraft } : {}),
    now,
    source: "app",
    actorId: ctx.userId,
  };
  let merged: OrderMerge | undefined;
  let built = approvalStatements(db, ctx, card, approved, input, orderName);
  try {
    await applyBatch(db, built.statements);
  } catch (e) {
    if (!isOrderIdTaken(e)) {
      throw e;
    }
    // An order card for this order landed first: fold it into this card,
    // then run the batch again once (the attach is then a no-op).
    const folded = await mergeOrderIntoDraft(db, ctx.workspaceId, input);
    if (folded.kind === "attached") {
      merged = folded.merged;
    } else if (folded.kind !== "already") {
      console.warn("[review] " + JSON.stringify({ workspaceId: ctx.workspaceId, orderRowId: card.id, merge: folded.kind }));
      return refused(
        502,
        `Shopify created order ${orderName}, but the desk could not record it yet. The card updates on the next sync.`,
      );
    }
    built = approvalStatements(db, ctx, card, approved, input, orderName);
    await applyBatch(db, built.statements);
  }

  const fresh = await loadCard(db, ctx.workspaceId, card.id);
  if (!fresh) {
    return { kind: "not-found" };
  }
  if (fresh.shopifyOrderId !== completion.orderId) {
    console.warn("[review] " + JSON.stringify({ workspaceId: ctx.workspaceId, orderRowId: card.id, attach: "other order" }));
    return refused(
      502,
      `Shopify created order ${orderName}, but this card follows a different order. Check the draft in Shopify.`,
    );
  }
  const written = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, ctx.workspaceId), inArray(events.id, [built.statusEventId, built.completedEventId])));
  const statusRow = written.find((event) => event.id === built.statusEventId);
  const completedRow = written.find((event) => event.id === built.completedEventId);
  const order = orderView(fresh);
  const eventList = [statusRow, completedRow].filter((event) => event !== undefined).map(eventView);
  return {
    kind: "approved",
    order,
    orderName: fresh.name,
    shopifyOrderId: completion.orderId,
    events: eventList,
    triggersPo: approved.triggersPo,
    ...(merged ? { merged } : {}),
    follow: {
      order,
      statusEvent: statusRow ? eventView(statusRow) : null,
      completedEvent: completedRow ? eventView(completedRow) : null,
      statusChanges: [],
      merged: merged ?? null,
      pushStatus: true,
    },
  };
}

// The draft was completed in Shopify before the approval: nothing is sent.
// The card attaches to that order (source shopify) and takes the
// completion move from Shopify, exactly as if the draft webhook had landed.
async function followShopifyCompletion(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  read: DraftForApprove,
  access: Access,
  clock: () => number,
): Promise<ApproveResult> {
  if (read.orderId === null) {
    return refused(409, REVIEW_COPY.completedElsewhere);
  }
  const gid = draftGid(card.shopifyDraftId as string);
  const completedDraft = await completedSnapshot(access, gid, read.orderId);
  const now = clock();
  const attached = await attachOrderToDraft(db, ctx.workspaceId, {
    draftRowId: card.id,
    orderId: read.orderId,
    orderName: read.orderName,
    ...(completedDraft ? { completedDraft } : {}),
    now,
    source: "shopify",
  });
  if (attached.kind !== "attached" && attached.kind !== "already") {
    return refused(409, REVIEW_COPY.completedElsewhere);
  }
  let statusChanges: StatusChange[] = [];
  if (attached.kind === "attached") {
    // Without the full completed draft the card still holds the open draft:
    // the completion is judged against a completed copy of it.
    const after =
      attached.merged || completedDraft
        ? attached.after
        : { ...(isRecord(card.shopify) ? card.shopify : {}), status: "completed", orderId: read.orderId, orderName: read.orderName };
    statusChanges = await evaluateShopifyTransitions(
      db,
      ctx.workspaceId,
      [{ orderId: card.id, before: attached.before, after }],
      now,
    );
  }
  const fresh = await loadCard(db, ctx.workspaceId, card.id);
  if (!fresh) {
    return { kind: "not-found" };
  }
  const orderName = read.orderName ?? (fresh.shopifyOrderId !== null ? fresh.name : "");
  const order = orderView(fresh);
  return {
    kind: "completed-in-shopify",
    orderName,
    message: orderName
      ? `This draft was already completed in Shopify as order ${orderName}. The card now follows that order.`
      : "This draft was already completed in Shopify. The card now follows that order.",
    order,
    follow: {
      order,
      statusEvent: null,
      completedEvent: attached.kind === "attached" ? attached.event : null,
      statusChanges,
      merged: attached.kind === "attached" && attached.merged ? attached.merged : null,
      pushStatus: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Reject

export async function rejectRequest(
  db: Db,
  ctx: ReviewContext,
  body: unknown,
  deps: Pick<ReviewDeps, "now">,
): Promise<RejectResult> {
  const raw = isRecord(body) ? body.reason : undefined;
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0 || reason.length > NOTE_MAX) {
    return { kind: "invalid", error: REVIEW_COPY.reason };
  }
  const card = await loadCard(db, ctx.workspaceId, ctx.orderId);
  if (!card) {
    return { kind: "not-found" };
  }
  if (!roleAtLeast(ctx.role, "manager")) {
    return { kind: "forbidden", error: REVIEW_COPY.forbidden };
  }
  const alreadyOrder = (name: string) => refused(409, `This request is already order ${name}, so it cannot be rejected.`);
  if (card.shopifyOrderId !== null) {
    return alreadyOrder(card.name);
  }
  const rejected = await linkedStatus(db, ctx.workspaceId, "draft_rejected");
  if (!rejected) {
    return refused(409, REVIEW_COPY.noRejectedStatus);
  }
  if (!(await draftsOn(db, ctx.workspaceId))) {
    return refused(409, REVIEW_COPY.draftsOff);
  }
  if (card.statusKey === rejected.key) {
    return { kind: "unchanged" };
  }

  const now = (deps.now ?? Date.now)();
  const statusEvent = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: card.id,
    type: "status" as const,
    text: `Rejected the request. Status set to ${rejected.label}`,
    actorId: ctx.userId,
    meta: { from: card.statusKey, to: rejected.key, action: "reject" },
    createdAt: now,
    source: "app" as const,
  };
  const noteEvent = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: card.id,
    type: "note" as const,
    text: reason,
    actorId: ctx.userId,
    meta: { rejectReason: true },
    createdAt: now,
    source: "app" as const,
  };
  const statusExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${ctx.workspaceId} and ${statuses.key} = ${rejected.key})`;
  const moved = sql`exists (select 1 from ${orders} where ${orders.id} = ${card.id} and ${orders.statusKey} = ${rejected.key} and ${orders.statusSetAt} = ${now} and ${orders.statusSetBy} = ${ctx.userId})`;
  const insertWhenMoved = (event: typeof statusEvent | typeof noteEvent) =>
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${moved}`,
      );
  const [update] = await applyBatch(db, [
    db
      .update(orders)
      .set({ statusKey: rejected.key, statusSetBy: ctx.userId, statusSetAt: now })
      .where(
        and(
          eq(orders.id, card.id),
          eq(orders.workspaceId, ctx.workspaceId),
          isNull(orders.shopifyOrderId),
          ne(orders.statusKey, rejected.key),
          statusExists,
        ),
      ),
    insertWhenMoved(statusEvent),
    insertWhenMoved(noteEvent),
  ]);
  if (rowsAffected(update, "review") === 0) {
    const fresh = await loadCard(db, ctx.workspaceId, card.id);
    if (!fresh) {
      return { kind: "not-found" };
    }
    if (fresh.shopifyOrderId !== null) {
      return alreadyOrder(fresh.name);
    }
    if (fresh.statusKey === rejected.key) {
      return { kind: "unchanged" };
    }
    return refused(409, REVIEW_COPY.noRejectedStatus);
  }
  return {
    kind: "rejected",
    order: { id: card.id, statusKey: rejected.key, statusSetBy: ctx.userId, statusSetAt: now },
    events: [eventView(statusEvent), eventView(noteEvent)],
    statusEvent: eventView(statusEvent),
    noteEvent: eventView(noteEvent),
  };
}

// ---------------------------------------------------------------------------
// After the response

function logFollow(workspaceId: string, orderId: string, e: unknown): void {
  console.warn("[review] " + JSON.stringify({ workspaceId, orderId, follow: safeErrorReason(e) }));
}

export async function followApproval(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  follow: ApprovalFollowUp,
  deps: Omit<ReviewDeps, "env">,
): Promise<void> {
  const opts = { fetchImpl: deps.fetchImpl, now: deps.now };
  try {
    await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [orderId] });
    if (follow.merged) {
      await broadcastMerges(env, workspaceId, [follow.merged]);
    }
    if (follow.statusEvent && follow.order.statusSetAt !== null) {
      await broadcast(env, workspaceId, {
        kind: "order.status",
        event: follow.statusEvent,
        order: { ...follow.order, statusSetAt: follow.order.statusSetAt },
      });
    }
    if (follow.completedEvent) {
      await broadcast(env, workspaceId, { kind: "order.activity", event: follow.completedEvent });
    }
    if (follow.statusEvent) {
      await notifyActivity(db, env, workspaceId, follow.statusEvent, opts);
    }
    await shareShopifyMoves(db, env, workspaceId, follow.statusChanges, opts);

    // The order the card became, written onto it: an update, never a new
    // order (no notification).
    const clock = deps.now ?? Date.now;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const token = await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
    if (token.kind === "ok") {
      const ensured = await ensureOrderSnapshots(
        db,
        workspaceId,
        [orderId],
        { shopDomain: token.shopDomain, token: token.token, fetchImpl },
        clock(),
      );
      if (ensured.updatedOrderIds.length > 0) {
        await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: ensured.updatedOrderIds });
      }
      await shareShopifyMoves(db, env, workspaceId, ensured.statusChanges, opts);
    }
    // The ORDER now carries the approved status tag, replacing the tag it
    // inherited from the draft.
    if (follow.pushStatus) {
      await pushAndShare(db, env, workspaceId, orderId, opts);
    }
  } catch (e) {
    logFollow(workspaceId, orderId, e);
  }
}

export async function followRejection(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  result: Extract<RejectResult, { kind: "rejected" }>,
  deps: Omit<ReviewDeps, "env">,
): Promise<void> {
  const opts = { fetchImpl: deps.fetchImpl, now: deps.now };
  try {
    await broadcast(env, workspaceId, {
      kind: "order.status",
      event: result.statusEvent,
      order: { ...result.order, statusSetAt: result.order.statusSetAt ?? result.statusEvent.createdAt },
    });
    await broadcast(env, workspaceId, { kind: "order.note", event: result.noteEvent });
    // One push per action: the status change (a note's text never goes
    // into a push anyway).
    await notifyActivity(db, env, workspaceId, result.statusEvent, opts);
    // "Ordering Desk: Rejected" on the DraftOrder (skipped for a draft
    // Shopify deleted).
    await pushAndShare(db, env, workspaceId, orderId, opts);
  } catch (e) {
    logFollow(workspaceId, orderId, e);
  }
}
