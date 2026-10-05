// Shopify webhooks for one workspace (platform amendment section 4), behind
// POST /api/webhooks/shopify/[workspaceId]. No session: a delivery is
// trusted only when
// 1. the workspace has an enabled client-credentials connection (a legacy
//    token's app secret is unknown, so its deliveries cannot be verified;
//    those stores rely on the cron sync),
// 2. X-Shopify-Hmac-Sha256 is base64(HMAC-SHA256(raw body, the workspace's
//    client secret)), compared in constant time over the exact bytes
//    received, and
// 3. X-Shopify-Shop-Domain is the workspace's store: exactly its stored
//    domain, or the store's own myshopify domain recorded with it when the
//    connection was saved or refreshed (an aliased store's deliveries carry
//    the latter).
// Every rejection is the same 401, so a probe learns nothing about which
// workspaces exist or how they are connected. Then each X-Shopify-Webhook-Id
// is applied once (webhook_deliveries, insert or ignore: a repeat is a 200
// with no work), and the receipt goes back at once with the work to run
// after the response (ctx.waitUntil). If that work fails the cron sync and
// the roster sync heal it.
//
// - Order topics (orders/*, fulfillments/*): the order is re-fetched with
//   the sync's own query shape and normalizer and written through the sync's
//   write path (upsertFetchedOrder: same claim rule, so a webhook and a sync
//   run never regress each other), the Shopify -> app status rules run on
//   the change, open desks hear about it, and an order the webhook inserted
//   is announced (src/server/notify.ts, once per order).
// - Customer topics: the customer is re-fetched (customers/delete needs no
//   fetch) and the roster updated (roster-sync.ts).
// - Draft order topics (draft orders spec section 7.1), only while the
//   stored grant holds the draft scopes: the draft is re-fetched and written
//   through upsertFetchedDraft (src/server/sync/drafts.ts); a draft Shopify
//   no longer has, and draft_orders/delete (its payload is only the id),
//   mark the card deleted. A completion attaches the card and its order is
//   fetched and written onto it, never announced as new. With drafts on, an
//   order with no card is first looked up against the open draft cards
//   (upsertFetchedOrder's link); if that lookup fails nothing is written and
//   the cron sync lands the order.
// - Anything else: 200 and ignored.
//
// Payloads carry customer data: they are never logged, and failures are
// logged as the topic and a reason only.
// Relative imports, like the rest of the Shopify stage.

import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { rowsAffected } from "../../db/batch";
import { storeConnections, webhookDeliveries } from "../../db/schema";
import { broadcast, broadcastMerges, broadcastSync, kickUsers } from "../broadcast";
import { decryptSecret } from "../crypto";
import { notifyActivity, notifyNewOrders } from "../notify";
import { ensureOrderSnapshots, markDraftDeleted, upsertFetchedDraft } from "../sync/drafts";
import { upsertFetchedOrder } from "../sync/run";
import { draftsEnabled, failureText, fetchCustomer, fetchDraftNode, fetchOrderNode, legacyIdOf } from "./admin";
import { shareShopifyMoves } from "./fanout";
import { normalizeDrafts, normalizeOrders } from "./normalize";
import { applyRosterCustomer } from "./roster-sync";
import { safeErrorReason } from "./status-sync";
import { getAccessToken } from "./token";

// Shopify order payloads with many line items run to a few hundred KB.
export const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;
// Shopify's webhook ids are UUIDs; anything visible, bounded, is accepted.
const WEBHOOK_ID = /^[\x21-\x7e]{1,200}$/;
const NUMERIC_ID = /^[1-9]\d{0,19}$/;

const ORDER_TOPICS = new Set([
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "orders/fulfilled",
  "orders/partially_fulfilled",
]);
const FULFILLMENT_TOPICS = new Set(["fulfillments/create", "fulfillments/update"]);
const CUSTOMER_TOPICS = new Set(["customers/create", "customers/update", "customers/delete"]);
const DRAFT_TOPICS = new Set(["draft_orders/create", "draft_orders/update", "draft_orders/delete"]);

export type WebhookReceipt = { status: number; work?: () => Promise<void> };

export type WebhookOptions = { fetchImpl?: typeof fetch; now?: () => number };

type Job =
  | { kind: "order"; orderGid: string }
  | { kind: "customer"; customerGid: string; customerId: string }
  | { kind: "customer-deleted"; customerId: string }
  | { kind: "draft"; draftGid: string }
  | { kind: "draft-deleted"; draftId: string };

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Bytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

// Constant time for equal lengths (an HMAC-SHA256 is always 32 bytes, so the
// length says nothing).
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function verifyShopifyHmac(
  rawBody: Uint8Array<ArrayBuffer>,
  secret: string,
  header: string | null,
): Promise<boolean> {
  if (!header) {
    return false;
  }
  const expected = base64Bytes(header.trim());
  if (!expected || expected.length !== 32) {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  return timingSafeEqual(actual, expected);
}

// A gid of the given type from a payload: admin_graphql_api_id when it is
// one, else the numeric field (order_id for fulfillments; the id alone for
// draft_orders/delete).
function gidOf(
  payload: Record<string, unknown>,
  field: "id" | "order_id",
  type: "Order" | "Customer" | "DraftOrder",
): string | null {
  const prefix = `gid://shopify/${type}/`;
  const apiId = payload.admin_graphql_api_id;
  if (field === "id" && typeof apiId === "string" && apiId.startsWith(prefix) && NUMERIC_ID.test(apiId.slice(prefix.length))) {
    return apiId;
  }
  const raw = payload[field];
  const id = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : typeof raw === "string" ? raw : "";
  return NUMERIC_ID.test(id) ? prefix + id : null;
}

function jobFor(topic: string, payload: unknown): Job | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (ORDER_TOPICS.has(topic) || FULFILLMENT_TOPICS.has(topic)) {
    const orderGid = gidOf(payload, ORDER_TOPICS.has(topic) ? "id" : "order_id", "Order");
    return orderGid ? { kind: "order", orderGid } : null;
  }
  if (DRAFT_TOPICS.has(topic)) {
    const draftGid = gidOf(payload, "id", "DraftOrder");
    if (!draftGid) {
      return null;
    }
    return topic === "draft_orders/delete" ? { kind: "draft-deleted", draftId: legacyIdOf(draftGid) } : { kind: "draft", draftGid };
  }
  const customerGid = gidOf(payload, "id", "Customer");
  if (!customerGid) {
    return null;
  }
  const customerId = legacyIdOf(customerGid);
  return topic === "customers/delete"
    ? { kind: "customer-deleted", customerId }
    : { kind: "customer", customerGid, customerId };
}

function logFailure(workspaceId: string, topic: string, reason: string): void {
  console.warn("[webhook] " + JSON.stringify({ workspaceId, topic, error: reason.slice(0, 200) }));
}

export async function receiveShopifyWebhook(
  db: Db,
  env: CloudflareEnv,
  input: { workspaceId: string; rawBody: Uint8Array<ArrayBuffer>; headers: Headers },
  opts?: WebhookOptions,
): Promise<WebhookReceipt> {
  const rejected: WebhookReceipt = { status: 401 };
  if (input.rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return { status: 413 };
  }
  const hmac = input.headers.get("x-shopify-hmac-sha256");
  if (!hmac) {
    return rejected;
  }
  const rows = await db
    .select({
      status: storeConnections.status,
      shopDomain: storeConnections.shopDomain,
      authMode: storeConnections.authMode,
      encryptedClientSecret: storeConnections.encryptedClientSecret,
      canonicalShopDomain: storeConnections.canonicalShopDomain,
    })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, input.workspaceId))
    .limit(1);
  const connection = rows[0];
  if (
    !connection ||
    connection.status === "disabled" ||
    connection.authMode !== "client_credentials" ||
    !connection.encryptedClientSecret
  ) {
    return rejected;
  }
  let secret: string;
  try {
    secret = await decryptSecret(connection.encryptedClientSecret, env.ENCRYPTION_KEY, input.workspaceId);
  } catch {
    return rejected;
  }
  if (!(await verifyShopifyHmac(input.rawBody, secret, hmac))) {
    return rejected;
  }
  // Exactly the stored domain, or the store's own myshopify domain recorded
  // with it: Shopify sends the latter, and a store connected under an alias
  // (IMPACT: impactrentals.myshopify.com for 40kra0-b6.myshopify.com) has
  // a stored domain that differs. Never any other host.
  const shop = (input.headers.get("x-shopify-shop-domain") ?? "").trim().toLowerCase();
  if (shop.length === 0 || (shop !== connection.shopDomain && shop !== connection.canonicalShopDomain)) {
    return rejected;
  }

  const topic = (input.headers.get("x-shopify-topic") ?? "").trim();
  if (!ORDER_TOPICS.has(topic) && !FULFILLMENT_TOPICS.has(topic) && !CUSTOMER_TOPICS.has(topic) && !DRAFT_TOPICS.has(topic)) {
    return { status: 200 };
  }
  const webhookId = (input.headers.get("x-shopify-webhook-id") ?? "").trim();
  if (!WEBHOOK_ID.test(webhookId)) {
    return { status: 400 };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(input.rawBody));
  } catch {
    payload = null;
  }
  const job = jobFor(topic, payload);
  if (!job) {
    // Verified but names nothing to act on; a retry would not help.
    return { status: 200 };
  }

  const now = opts?.now?.() ?? Date.now();
  const recorded = await db
    .insert(webhookDeliveries)
    .values({ id: `${input.workspaceId}:${webhookId}`, workspaceId: input.workspaceId, topic, receivedAt: now })
    .onConflictDoNothing();
  if (rowsAffected(recorded, "webhook") === 0) {
    return { status: 200 };
  }
  return {
    status: 200,
    work: async () => {
      try {
        await runJob(db, env, input.workspaceId, topic, job, opts);
      } catch (e) {
        logFailure(input.workspaceId, topic, safeErrorReason(e));
      }
    },
  };
}

// Whether draft orders sync for the store (the stored grant holds the
// draft scopes), and whether the first draft sync is still pending.
async function draftState(db: Db, workspaceId: string): Promise<{ enabled: boolean; firstPending: boolean }> {
  const rows = await db
    .select({ scopes: storeConnections.scopes, draftLastSyncAt: storeConnections.draftLastSyncAt })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  return { enabled: draftsEnabled(rows[0]?.scopes), firstPending: (rows[0]?.draftLastSyncAt ?? 0) === 0 };
}

// A draft card marked deleted: open desks refresh it and hear the timeline
// entry; members who follow all activity are told.
async function shareDeletion(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  draftId: string,
  now: number,
  opts?: WebhookOptions,
): Promise<void> {
  const marked = await markDraftDeleted(db, workspaceId, draftId, now);
  if (marked.kind !== "deleted") {
    return;
  }
  await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [marked.orderId] });
  await broadcast(env, workspaceId, { kind: "order.activity", event: marked.event });
  await notifyActivity(db, env, workspaceId, marked.event, opts);
}

// The connection the work was authorized under is still the workspace's
// store (not disconnected, same shop): the webhook's stand-in for a sync
// run's lease check before it writes.
async function stillConnected(db: Db, workspaceId: string, shopDomain: string): Promise<boolean> {
  const rows = await db
    .select({ status: storeConnections.status, shopDomain: storeConnections.shopDomain })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  return rows[0] !== undefined && rows[0].status !== "disabled" && rows[0].shopDomain === shopDomain;
}

async function runJob(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  topic: string,
  job: Job,
  opts?: WebhookOptions,
): Promise<void> {
  const clock = opts?.now ?? Date.now;
  // Taken before anything is fetched: the order's row ownership goes by it
  // (see upsertFetchedOrder).
  const now = clock();
  if (job.kind === "customer-deleted") {
    await kickUsers(env, workspaceId, await applyRosterCustomer(db, workspaceId, job.customerId, null, now));
    return;
  }
  const drafts = await draftState(db, workspaceId);
  if (job.kind === "draft-deleted") {
    if (drafts.enabled) {
      await shareDeletion(db, env, workspaceId, job.draftId, now, opts);
    }
    return;
  }
  if (job.kind === "draft" && !drafts.enabled) {
    return;
  }

  const token = await getAccessToken(db, env, workspaceId, { fetchImpl: opts?.fetchImpl, now: clock });
  if (token.kind !== "ok") {
    if (token.kind !== "unavailable") {
      logFailure(workspaceId, topic, token.kind === "unreadable" ? "store credentials unreadable" : token.detail);
    }
    return;
  }

  if (job.kind === "customer") {
    const fetched = await fetchCustomer(token.shopDomain, token.token, job.customerGid, opts?.fetchImpl);
    if (fetched.kind !== "ok") {
      logFailure(workspaceId, topic, failureText(fetched));
      return;
    }
    if (!(await stillConnected(db, workspaceId, token.shopDomain))) {
      return;
    }
    await kickUsers(env, workspaceId, await applyRosterCustomer(db, workspaceId, job.customerId, fetched.customer, now));
    return;
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const access = { shopDomain: token.shopDomain, token: token.token, fetchImpl };

  if (job.kind === "draft") {
    const fetched = await fetchDraftNode(token.shopDomain, token.token, job.draftGid, fetchImpl);
    if (fetched.kind !== "ok") {
      logFailure(workspaceId, topic, failureText(fetched));
      return;
    }
    if (!(await stillConnected(db, workspaceId, token.shopDomain))) {
      return;
    }
    if (fetched.node === null) {
      // Deleted (or purged) since the delivery was sent.
      await shareDeletion(db, env, workspaceId, legacyIdOf(job.draftGid), now, opts);
      return;
    }
    const [draft] = normalizeDrafts([fetched.node]);
    if (!draft) {
      return;
    }
    // Before the first draft sync, a draft that was already waiting (any
    // topic but create) is inserted without an announcement, like the
    // first draft sync would (decision D12).
    const outcome = await upsertFetchedDraft(db, workspaceId, draft, now, {
      silent: drafts.firstPending && topic !== "draft_orders/create",
    });
    switch (outcome.kind) {
      case "unchanged":
        return;
      case "added":
        await broadcastSync(env, workspaceId, { addedOrderIds: [outcome.orderId], updatedOrderIds: [] });
        await notifyNewOrders(db, env, workspaceId, [outcome.orderId], opts);
        return;
      case "updated":
        await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [outcome.orderId] });
        await shareShopifyMoves(db, env, workspaceId, outcome.statusChanges, opts);
        return;
      case "attached": {
        await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [outcome.orderId] });
        await broadcastMerges(env, workspaceId, outcome.merged ? [outcome.merged] : []);
        await shareShopifyMoves(db, env, workspaceId, outcome.statusChanges, opts);
        // The order the card became, written onto it (an update, never a
        // notification).
        const ensured = await ensureOrderSnapshots(db, workspaceId, [outcome.orderId], access, now);
        if (ensured.updatedOrderIds.length > 0) {
          await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: ensured.updatedOrderIds });
        }
        await shareShopifyMoves(db, env, workspaceId, ensured.statusChanges, opts);
        return;
      }
    }
  }

  const fetched = await fetchOrderNode(token.shopDomain, token.token, job.orderGid, fetchImpl);
  if (fetched.kind !== "ok") {
    logFailure(workspaceId, topic, failureText(fetched));
    return;
  }
  const [order] = fetched.node ? normalizeOrders([fetched.node]) : [];
  if (!order || !(await stillConnected(db, workspaceId, token.shopDomain))) {
    return;
  }
  const outcome = await upsertFetchedOrder(db, workspaceId, order, now, drafts.enabled ? access : undefined);
  if (outcome.kind === "unchanged") {
    return;
  }
  if (outcome.kind === "deferred") {
    logFailure(workspaceId, topic, "draft link lookup failed");
    return;
  }
  await broadcastSync(env, workspaceId, {
    addedOrderIds: outcome.kind === "added" ? [outcome.orderId] : [],
    updatedOrderIds: outcome.kind === "added" ? [] : [outcome.orderId],
  });
  if (outcome.kind === "attached") {
    await broadcastMerges(env, workspaceId, outcome.mergedOrders);
  }
  // A new order is announced (push and email); notifyNewOrders claims it,
  // so a cron run that lands it too announces nothing twice. An order that
  // came from a draft card is an update of that card: never announced.
  if (outcome.kind === "added") {
    await notifyNewOrders(db, env, workspaceId, [outcome.orderId], opts);
  }
  await shareShopifyMoves(db, env, workspaceId, outcome.statusChanges, opts);
}
