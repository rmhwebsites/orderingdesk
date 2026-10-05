// Notification fan-out (design doc and owner decisions: phone push plus a
// branded email for NEW ORDERS and PO SENDS; everything else in-app, bell
// and live toasts, with a per-person opt-in to push all activity; customers
// are never emailed).
//
// - notifyNewOrders: called by every path a new order lands through (the
//   cron sync, the Sync button, Shopify webhooks) with the ids that path
//   inserted. Each order is CLAIMED first with one conditional UPDATE
//   (orders.notified_at, set only while null), so an order is announced at
//   most once whichever paths race and however often an id is reported.
//   Orders created more than a day ago are claimed silently (a store's
//   first sync backfills two months). More than DIGEST_AFTER fresh orders
//   at once become one summary push and email instead of a flood.
// - notifyPoSent: after a reviewed Send to vendor (src/server/po/send.ts);
//   same audience, the sender's own devices get no push, and addresses
//   already on the vendor email get no second email.
// - notifyActivity: status changes and notes, pushed only to members who
//   opted into all activity, never about their own change.
//
// Audience: workspace members (platform admins who are not members get
// nothing). Push goes to the devices of a member whose push_new_orders is
// on (default on); email to the workspace notification list plus members
// whose email_new_orders is on (default on), deduplicated by address, one
// message per address so nobody sees the others. Push links open the order
// on the host the device subscribed on: the workspace's client host for a
// device that subscribed there, else the hub. Email links use the client
// host when it is active.
//
// Devices by host (deliversTo): a client host is run by its tenant, who
// controls its DNS and TLS and so can serve their own service worker there
// and read every push it receives. A workspace's notices therefore go only
// to devices that subscribed on the hub (or with no host recorded, which
// reads as the hub) and on that workspace's own active client host, never
// to a device on another workspace's client host or on a client host that
// is no longer active.
//
// Push payloads hold the order number, the customer's first name, the
// total and the link (activity: the order number and what happened; a
// note's text never). Everything here is best effort: it runs after the
// change committed (ctx.waitUntil, or after the cron run), never throws,
// and logs counts only, never an address.
//
// Relative imports on purpose: the cron path bundles this into the custom
// worker.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { notificationPrefs, orders, user, workspaceMembers, workspaceSettings } from "../db/schema";
import { formatMoney } from "../lib/format";
import type { EventView } from "./desk/shapes";
import { isRecord } from "./desk/shapes";
import {
  newOrderEmail,
  newOrdersDigestEmail,
  poSentEmail,
  type OrderSummaryForEmail,
  type PoSentNotice,
  type RenderedEmail,
} from "./email/notifications";
import { sendEmail, senderFor } from "./email/send";
import { loadMailWorkspace, type MailWorkspace } from "./email/workspace";
import { appOrigin, hubHostname, workspaceOrigin } from "./host";
import { sendPushToTargets, subscriptionsFor, type PushNotice, type PushTarget } from "./push";

export type { PoSentNotice } from "./email/notifications";

export const NEW_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DIGEST_AFTER = 5;
const MAX_EMAIL_RECIPIENTS = 50;
const EMAIL_CONCURRENCY = 4;
const ID_CHUNK = 50;
const NAME_MAX = 40;

export type NotifyOptions = { fetchImpl?: typeof fetch; now?: () => number };

export type NewOrdersResult = { claimed: number; announced: string[]; pushed: number; emailed: number };

type Member = {
  userId: string;
  email: string;
  pushNewOrders: boolean;
  emailNewOrders: boolean;
  pushAllActivity: boolean;
};

function log(detail: Record<string, unknown>): void {
  console.warn("[notify] " + JSON.stringify(detail));
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "failed";
}

// ---- Links --------------------------------------------------------------

type LinkWorkspace = Pick<MailWorkspace, "slug" | "customDomain" | "customDomainStatus">;

function onOwnHost(workspace: LinkWorkspace, host: string | null): boolean {
  return workspace.customDomainStatus === "active" && !!workspace.customDomain && host === workspace.customDomain;
}

function orderQuery(orderId: string | null): string {
  return orderId ? `?order=${encodeURIComponent(orderId)}` : "";
}

// Whether a device that subscribed on `host` may receive this workspace's
// notices: the hub (or no host recorded), or the workspace's own active
// client host. Any other host is another tenant's (or one no longer
// checked) and gets nothing.
export function deliversTo(env: CloudflareEnv, workspace: LinkWorkspace, host: string | null): boolean {
  if (host === null) {
    return true;
  }
  const hub = hubHostname(env);
  return (hub !== null && host === hub) || onOwnHost(workspace, host);
}

// The desk (or one order in it) for a device that subscribed on `host`.
export function pushLink(env: CloudflareEnv, workspace: LinkWorkspace, orderId: string | null, host: string | null): string {
  if (onOwnHost(workspace, host)) {
    return `${workspaceOrigin(env, workspace)}/${orderQuery(orderId)}`;
  }
  return `${appOrigin(env)}/w/${encodeURIComponent(workspace.slug)}${orderQuery(orderId)}`;
}

// Email links: the client host when it is active, else the hub.
export function emailLink(env: CloudflareEnv, workspace: LinkWorkspace, orderId: string | null): string {
  if (workspace.customDomainStatus === "active" && workspace.customDomain) {
    return `${workspaceOrigin(env, workspace)}/${orderQuery(orderId)}`;
  }
  return `${appOrigin(env)}/w/${encodeURIComponent(workspace.slug)}${orderQuery(orderId)}`;
}

// ---- Notices ------------------------------------------------------------

function firstName(customerName: string): string {
  return (customerName.trim().split(/\s+/)[0] ?? "").slice(0, NAME_MAX);
}

// On the hub, which serves every workspace, a notice names its workspace.
function withWorkspace(body: string, workspaceName: string, ownHost: boolean): string {
  return ownHost ? body : [workspaceName, body].filter((part) => part.length > 0).join(". ");
}

type NoticeContext = { workspaceName: string; ownHost: boolean; url: string };

export function newOrderNotice(order: OrderSummaryForEmail, ctx: NoticeContext): PushNotice {
  const body = [firstName(order.customerName), formatMoney(order.total, order.currency)].filter((part) => part.length > 0).join(", ");
  return {
    title: `New order ${order.name}`,
    body: withWorkspace(body, ctx.workspaceName, ctx.ownHost),
    url: ctx.url,
    tag: `order-${order.id}`,
  };
}

export function digestNotice(list: OrderSummaryForEmail[], ctx: NoticeContext): PushNotice {
  const names = list.slice(0, 3).map((order) => order.name);
  const rest = list.length - names.length;
  return {
    title: `${list.length} new orders`,
    body: withWorkspace(rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", "), ctx.workspaceName, ctx.ownHost),
    url: ctx.url,
    tag: "new-orders",
  };
}

const ACTIVITY_PUSH_TYPES = new Set<EventView["type"]>(["status", "note"]);

export function activityNotice(event: EventView, orderName: string, ctx: NoticeContext): PushNotice | null {
  if (!ACTIVITY_PUSH_TYPES.has(event.type) || !event.orderId) {
    return null;
  }
  // A note's text may hold anything a person typed: it stays in the app.
  const what = event.type === "note" ? "New note" : event.text.slice(0, 120);
  return {
    title: `Order ${orderName}`,
    body: withWorkspace(what, ctx.workspaceName, ctx.ownHost),
    url: ctx.url,
    tag: `order-${event.orderId}-activity`,
  };
}

export function poSentNotice(po: PoSentNotice, ctx: NoticeContext): PushNotice {
  return {
    title: `Purchase order ${po.poNumber} sent`,
    body: withWorkspace(`${po.orderName} to ${po.vendorName}`, ctx.workspaceName, ctx.ownHost),
    url: ctx.url,
    tag: `po-${po.poId}`,
  };
}

// ---- Audience -----------------------------------------------------------

async function loadMembers(db: Db, workspaceId: string): Promise<Member[]> {
  const rows = await db
    .select({
      userId: workspaceMembers.userId,
      email: user.email,
      pushNewOrders: notificationPrefs.pushNewOrders,
      emailNewOrders: notificationPrefs.emailNewOrders,
      pushAllActivity: notificationPrefs.pushAllActivity,
    })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .leftJoin(
      notificationPrefs,
      and(eq(notificationPrefs.userId, workspaceMembers.userId), eq(notificationPrefs.workspaceId, workspaceMembers.workspaceId)),
    )
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  // No preferences row means the defaults: push and email for new orders
  // on, all activity off.
  return rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    pushNewOrders: row.pushNewOrders ?? true,
    emailNewOrders: row.emailNewOrders ?? true,
    pushAllActivity: row.pushAllActivity ?? false,
  }));
}

async function notificationEmails(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ emails: workspaceSettings.notificationEmails })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const list = rows[0]?.emails;
  return Array.isArray(list) ? list.filter((email): email is string => typeof email === "string") : [];
}

// The notification list plus members who want email, lowercased and
// deduplicated, at most MAX_EMAIL_RECIPIENTS.
function emailRecipients(list: string[], members: Member[]): string[] {
  const out = new Set<string>();
  for (const email of [...list, ...members.filter((member) => member.emailNewOrders).map((member) => member.email)]) {
    const normalized = email.trim().toLowerCase();
    if (normalized.includes("@")) {
      out.add(normalized);
    }
  }
  return [...out].slice(0, MAX_EMAIL_RECIPIENTS);
}

// ---- Sending ------------------------------------------------------------

// Every device of these people that may receive this workspace's notices
// (deliversTo), each sent what noticeFor builds for it.
async function pushTo(
  db: Db,
  env: CloudflareEnv,
  workspace: LinkWorkspace,
  userIds: string[],
  noticeFor: (target: PushTarget) => PushNotice | null,
  opts: NotifyOptions & { urgency: "normal" | "high"; ttl: number },
): Promise<number> {
  if (userIds.length === 0) {
    return 0;
  }
  try {
    const targets = (await subscriptionsFor(db, userIds)).filter((target) => deliversTo(env, workspace, target.host));
    const counts = await sendPushToTargets(db, env, targets, noticeFor, opts);
    return counts.sent;
  } catch (e) {
    log({ push: errorName(e) });
    return 0;
  }
}

// One message per address, a few at a time. Returns how many went out.
async function emailEach(env: CloudflareEnv, workspace: MailWorkspace, recipients: string[], email: RenderedEmail): Promise<number> {
  const sender = senderFor(env, workspace);
  const queue = [...recipients];
  let sentCount = 0;
  const worker = async () => {
    for (let to = queue.shift(); to; to = queue.shift()) {
      try {
        await sendEmail(env, {
          from: sender.from,
          ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
          to: [to],
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
        sentCount++;
      } catch (e) {
        log({ workspaceId: workspace.id, email: errorName(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(EMAIL_CONCURRENCY, queue.length) }, worker));
  return sentCount;
}

// ---- New orders ---------------------------------------------------------

function summaryOf(row: { id: string; name: string; shopify: unknown }): OrderSummaryForEmail {
  const snapshot = isRecord(row.shopify) ? row.shopify : {};
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const items = Array.isArray(snapshot.items) ? snapshot.items.filter(isRecord) : [];
  return {
    id: row.id,
    name: row.name,
    customerName: text(snapshot.customerName),
    total: text(snapshot.total),
    currency: text(snapshot.currency),
    items: items.map((item) => ({
      title: text(item.title),
      qty: typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 1,
      variant: text(item.variant),
    })),
  };
}

// Claims the orders that nobody announced yet (notified_at null), one
// conditional UPDATE per chunk: whichever caller's UPDATE matches a row
// owns its announcement, so concurrent callers never both get it.
async function claimNewOrders(db: Db, workspaceId: string, orderIds: string[], now: number) {
  const unique = [...new Set(orderIds)];
  const claimed: Array<{ id: string; name: string; shopify: unknown; createdAt: number }> = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const rows = await db
      .update(orders)
      .set({ notifiedAt: now })
      .where(
        and(eq(orders.workspaceId, workspaceId), inArray(orders.id, unique.slice(i, i + ID_CHUNK)), isNull(orders.notifiedAt)),
      )
      .returning({ id: orders.id, name: orders.name, shopify: orders.shopify, createdAt: orders.createdAt });
    claimed.push(...rows);
  }
  return claimed;
}

export async function notifyNewOrders(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderIds: readonly string[],
  opts?: NotifyOptions,
): Promise<NewOrdersResult> {
  const result: NewOrdersResult = { claimed: 0, announced: [], pushed: 0, emailed: 0 };
  if (orderIds.length === 0) {
    return result;
  }
  try {
    const now = opts?.now?.() ?? Date.now();
    const claimed = await claimNewOrders(db, workspaceId, [...orderIds], now);
    result.claimed = claimed.length;
    const fresh = claimed
      .filter((row) => row.createdAt >= now - NEW_ORDER_MAX_AGE_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(summaryOf);
    if (fresh.length === 0) {
      return result;
    }
    const workspace = await loadMailWorkspace(db, workspaceId);
    if (!workspace) {
      return result;
    }
    result.announced = fresh.map((order) => order.id);
    const [members, list] = await Promise.all([loadMembers(db, workspaceId), notificationEmails(db, workspaceId)]);
    // Up to DIGEST_AFTER orders: a notification and an email each (the
    // push tag keeps them apart). More: one summary of each.
    const digest = fresh.length > DIGEST_AFTER;
    const context = (target: PushTarget, orderId: string | null) => ({
      workspaceName: workspace.name,
      ownHost: onOwnHost(workspace, target.host),
      url: pushLink(env, workspace, orderId, target.host),
    });
    const noticeBuilders: Array<(target: PushTarget) => PushNotice> = digest
      ? [(target) => digestNotice(fresh, context(target, null))]
      : fresh.map((order) => (target: PushTarget) => newOrderNotice(order, context(target, order.id)));
    const pushUserIds = members.filter((member) => member.pushNewOrders).map((member) => member.userId);
    for (const noticeFor of noticeBuilders) {
      result.pushed += await pushTo(db, env, workspace, pushUserIds, noticeFor, { ...opts, urgency: "high", ttl: 86400 });
    }

    const recipients = emailRecipients(list, members);
    const emails = digest
      ? [newOrdersDigestEmail(env, workspace, fresh, emailLink(env, workspace, null))]
      : fresh.map((order) => newOrderEmail(env, workspace, order, emailLink(env, workspace, order.id)));
    for (const email of emails) {
      result.emailed += await emailEach(env, workspace, recipients, email);
    }
    log({ workspaceId, newOrders: result.announced.length, pushed: result.pushed, emailed: result.emailed });
  } catch (e) {
    log({ workspaceId, newOrders: errorName(e) });
  }
  return result;
}

// ---- Purchase orders (called after a reviewed Send to vendor) ------------

// alreadyEmailed: the addresses on the vendor email itself (its To and CC,
// which include the notification list); they already have the PO and its
// PDF, so they get no second email about the same send.
export async function notifyPoSent(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  po: PoSentNotice,
  opts?: NotifyOptions & { alreadyEmailed?: readonly string[] },
): Promise<{ pushed: number; emailed: number }> {
  const result = { pushed: 0, emailed: 0 };
  try {
    const workspace = await loadMailWorkspace(db, workspaceId);
    if (!workspace) {
      return result;
    }
    const [members, list] = await Promise.all([loadMembers(db, workspaceId), notificationEmails(db, workspaceId)]);
    result.pushed = await pushTo(
      db,
      env,
      workspace,
      members.filter((member) => member.pushNewOrders && member.userId !== po.actorId).map((member) => member.userId),
      (target) =>
        poSentNotice(po, {
          workspaceName: workspace.name,
          ownHost: onOwnHost(workspace, target.host),
          url: pushLink(env, workspace, po.orderId, target.host),
        }),
      { ...opts, urgency: "normal", ttl: 86400 },
    );
    const skip = new Set((opts?.alreadyEmailed ?? []).map((email) => email.trim().toLowerCase()));
    result.emailed = await emailEach(
      env,
      workspace,
      emailRecipients(list, members).filter((email) => !skip.has(email)),
      poSentEmail(env, workspace, po, emailLink(env, workspace, po.orderId)),
    );
    log({ workspaceId, poSent: true, pushed: result.pushed, emailed: result.emailed });
  } catch (e) {
    log({ workspaceId, poSent: errorName(e) });
  }
  return result;
}

// ---- Activity (status changes and notes) -------------------------------

export async function notifyActivity(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  event: EventView,
  opts?: NotifyOptions,
): Promise<{ pushed: number }> {
  if (!ACTIVITY_PUSH_TYPES.has(event.type) || !event.orderId) {
    return { pushed: 0 };
  }
  try {
    const members = (await loadMembers(db, workspaceId)).filter(
      (member) => member.pushAllActivity && member.userId !== event.actorId,
    );
    if (members.length === 0) {
      return { pushed: 0 };
    }
    const [workspace, orderRows] = await Promise.all([
      loadMailWorkspace(db, workspaceId),
      db
        .select({ name: orders.name })
        .from(orders)
        .where(and(eq(orders.id, event.orderId), eq(orders.workspaceId, workspaceId)))
        .limit(1),
    ]);
    if (!workspace || !orderRows[0]) {
      return { pushed: 0 };
    }
    const orderId = event.orderId;
    const pushed = await pushTo(
      db,
      env,
      workspace,
      members.map((member) => member.userId),
      (target) =>
        activityNotice(event, orderRows[0].name, {
          workspaceName: workspace.name,
          ownHost: onOwnHost(workspace, target.host),
          url: pushLink(env, workspace, orderId, target.host),
        }),
      { ...opts, urgency: "normal", ttl: 21600 },
    );
    return { pushed };
  } catch (e) {
    log({ workspaceId, activity: errorName(e) });
    return { pushed: 0 };
  }
}
