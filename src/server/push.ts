// Web push (design doc: phone push for new orders and purchase orders, and
// for all activity when a member opts in). Standard Web Push: VAPID-signed
// (RFC 8292), aes128gcm-encrypted (RFC 8291) messages built with
// @block65/webcrypto-web-push on WebCrypto, which runs on Workers (the Node
// web-push package does not).
//
// - Keys: VAPID_PUBLIC_KEY (the raw uncompressed P-256 point, base64url,
//   which browsers take as applicationServerKey), VAPID_PRIVATE_KEY (its JWK
//   d) and VAPID_SUBJECT (mailto: or https:). scripts/generate-vapid.mjs
//   prints a pair. Without them nothing is sent and the key route says so.
// - Subscriptions are per person and per browser (push_subscriptions, the
//   endpoint is unique), recorded with the host the browser subscribed on.
//   Only the browsers' own push services are accepted as endpoints, so
//   the Worker never posts to an address a signed-in person made up.
// - A push service answering 404 or 410 means the subscription is gone for
//   good: its row is deleted. Anything else is logged (status only; the
//   endpoint is a capability URL and never logged) and the row kept.
// - Payloads are the PushNotice fields only, clipped short. Callers decide
//   what goes in them (src/server/notify.ts keeps customer emails and
//   addresses out).
//
// Relative imports on purpose: the cron path (src/server/sync/cron.ts)
// bundles this into the custom worker.

import { buildPushPayload } from "@block65/webcrypto-web-push";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db";
import { pushSubscriptions } from "../db/schema";

// The library pads every message to 4096 octets; this is the most it can
// carry. Our notices stay far below it (encodePushNotice clips).
export const PUSH_PAYLOAD_MAX_BYTES = 3993;
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

const TITLE_MAX = 80;
const BODY_MAX = 160;
const URL_MAX = 600;
const TAG_MAX = 64;
const ENDPOINT_MAX = 2048;
const USER_AGENT_MAX = 200;
const ID_CHUNK = 50;
const SEND_CONCURRENCY = 6;

// What a notification shows: its title and body, the link it opens and a
// tag (a newer notification with the same tag replaces the older one).
export type PushNotice = { title: string; body: string; url: string; tag: string };

export type PushEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };

export type PushTarget = {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  host: string | null;
};

export type PushOutcome = "sent" | "gone" | "failed";

export type PushSendOptions = {
  fetchImpl?: typeof fetch;
  // Seconds the push service keeps the message for an offline device.
  ttl?: number;
  urgency?: "low" | "normal" | "high";
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function pushConfigured(env: PushEnv): boolean {
  return nonEmpty(env.VAPID_PUBLIC_KEY) && nonEmpty(env.VAPID_PRIVATE_KEY) && nonEmpty(env.VAPID_SUBJECT);
}

// The key browsers subscribe with, or null while push is not set up.
export function vapidPublicKey(env: PushEnv): string | null {
  return pushConfigured(env) ? (env.VAPID_PUBLIC_KEY as string).trim() : null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

// The JSON the service worker (public/sw.js) reads: exactly these four
// fields, clipped. Throws for a link that is not http or https.
export function encodePushNotice(notice: PushNotice): string {
  if (!/^https?:\/\//i.test(notice.url)) {
    throw new Error("encodePushNotice: the link must be an http or https URL");
  }
  return JSON.stringify({
    title: clip(notice.title, TITLE_MAX),
    body: clip(notice.body, BODY_MAX),
    url: notice.url.slice(0, URL_MAX),
    tag: clip(notice.tag, TAG_MAX),
  });
}

function logWarn(detail: Record<string, unknown>): void {
  console.warn("[push] " + JSON.stringify(detail));
}

// Sends one notice to one subscription. Never throws.
export async function sendPush(
  db: Db,
  env: PushEnv,
  target: PushTarget,
  notice: PushNotice,
  opts?: PushSendOptions,
): Promise<PushOutcome> {
  if (!pushConfigured(env)) {
    return "failed";
  }
  try {
    const payload = await buildPushPayload(
      {
        data: encodePushNotice(notice),
        options: { ttl: opts?.ttl ?? 86400, ...(opts?.urgency ? { urgency: opts.urgency } : {}) },
      },
      { endpoint: target.endpoint, expirationTime: null, keys: target.keys },
      { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY?.trim(), privateKey: env.VAPID_PRIVATE_KEY?.trim() },
    );
    const response = await (opts?.fetchImpl ?? fetch)(target.endpoint, payload);
    if (response.status === 404 || response.status === 410) {
      await db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.id, target.id), eq(pushSubscriptions.endpoint, target.endpoint)));
      return "gone";
    }
    if (!response.ok) {
      logWarn({ status: response.status });
      return "failed";
    }
    return "sent";
  } catch (e) {
    logWarn({ error: e instanceof Error ? e.name : "failed" });
    return "failed";
  }
}

// Every subscription of these people.
export async function subscriptionsFor(db: Db, userIds: readonly string[]): Promise<PushTarget[]> {
  const unique = [...new Set(userIds)];
  const out: PushTarget[] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: pushSubscriptions.id,
        userId: pushSubscriptions.userId,
        endpoint: pushSubscriptions.endpoint,
        keys: pushSubscriptions.keys,
        host: pushSubscriptions.host,
      })
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, unique.slice(i, i + ID_CHUNK)));
    out.push(...rows);
  }
  return out;
}

// Sends each target the notice noticeFor builds for it (null skips it), a
// few at a time. Never throws.
export async function sendPushToTargets(
  db: Db,
  env: PushEnv,
  targets: readonly PushTarget[],
  noticeFor: (target: PushTarget) => PushNotice | null,
  opts?: PushSendOptions,
): Promise<{ sent: number; gone: number; failed: number }> {
  const counts = { sent: 0, gone: 0, failed: 0 };
  if (!pushConfigured(env)) {
    return counts;
  }
  const queue = [...targets];
  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      let notice: PushNotice | null = null;
      try {
        notice = noticeFor(target);
      } catch {
        notice = null;
      }
      if (!notice) {
        continue;
      }
      counts[await sendPush(db, env, target, notice, opts)]++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));
  return counts;
}

// The browsers' own push services: Chrome, Edge on Android and other
// Chromium browsers (FCM), Firefox (Mozilla), Safari and iOS (Apple), Edge
// on Windows (WNS).
const PUSH_SERVICE_SUFFIXES = [".googleapis.com", ".mozilla.com", ".push.apple.com", ".notify.windows.com"];
const KEY_TEXT = /^[A-Za-z0-9_-]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > ENDPOINT_MAX) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? value : null;
}

function validKey(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.length >= min && value.length <= max && KEY_TEXT.test(value) ? value : null;
}

export type SaveSubscriptionResult = { kind: "saved" } | { kind: "invalid"; error: string };

// Body: a PushSubscription's toJSON() ({endpoint, keys: {p256dh, auth}}).
// Upserts by endpoint for the caller (a browser someone else used to
// register belongs to whoever registers it now), then keeps the caller's
// MAX_SUBSCRIPTIONS_PER_USER newest.
export async function saveSubscription(
  db: Db,
  ctx: { userId: string; host: string | null; userAgent: string | null; now?: number },
  body: unknown,
): Promise<SaveSubscriptionResult> {
  if (!isRecord(body)) {
    return { kind: "invalid", error: "A push subscription is required" };
  }
  const endpoint = validEndpoint(body.endpoint);
  if (!endpoint) {
    return { kind: "invalid", error: "This browser's push service is not supported" };
  }
  const keys = isRecord(body.keys) ? body.keys : null;
  const p256dh = validKey(keys?.p256dh, 40, 200);
  const auth = validKey(keys?.auth, 10, 100);
  if (!p256dh || !auth) {
    return { kind: "invalid", error: "The push subscription keys are missing or malformed" };
  }
  const now = ctx.now ?? Date.now();
  const userAgent = ctx.userAgent ? ctx.userAgent.slice(0, USER_AGENT_MAX) : null;
  await db
    .insert(pushSubscriptions)
    .values({ id: crypto.randomUUID(), userId: ctx.userId, endpoint, keys: { p256dh, auth }, userAgent, createdAt: now, host: ctx.host })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: ctx.userId, keys: { p256dh, auth }, userAgent, createdAt: now, host: ctx.host },
    });
  const keep = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, ctx.userId))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
    .limit(MAX_SUBSCRIPTIONS_PER_USER);
  await db.delete(pushSubscriptions).where(
    and(
      eq(pushSubscriptions.userId, ctx.userId),
      notInArray(
        pushSubscriptions.id,
        keep.map((row) => row.id),
      ),
    ),
  );
  return { kind: "saved" };
}

export type RemoveSubscriptionResult = { kind: "removed" } | { kind: "not-found" } | { kind: "invalid"; error: string };

// Body {endpoint}: removes that browser's subscription when it is the
// caller's; anyone else's (or none) is not-found, the same answer.
export async function removeSubscription(db: Db, userId: string, body: unknown): Promise<RemoveSubscriptionResult> {
  const endpoint = isRecord(body) && typeof body.endpoint === "string" ? body.endpoint : null;
  if (!endpoint || endpoint.length > ENDPOINT_MAX) {
    return { kind: "invalid", error: "endpoint is required" };
  }
  const removed = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
    .returning({ id: pushSubscriptions.id });
  return removed.length > 0 ? { kind: "removed" } : { kind: "not-found" };
}
