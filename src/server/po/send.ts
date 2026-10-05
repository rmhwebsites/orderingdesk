// Sending a purchase order to its vendor. NOTHING is sent without an
// explicit confirmation of the exact recipients: the request must carry
// confirm: true and the To and CC lists the reviewer was shown, and they
// must equal who the PO would go to now (the vendor's addresses and the
// workspace notification list). A missing confirmation, or recipients that
// changed since the review (a vendor edited meanwhile), sends nothing and
// answers the current recipients so the page can ask again.
//
// One send, in order: claim the PO (the send lease, so overlapping requests
// cannot both send), mint its number if it has none yet, render the PDF,
// store it in R2 under pos/<workspaceId>/<poId>-<random>.pdf, email the
// vendor from the workspace sender (senderFor) with the branded body
// (renderEmail), the PDF attached, copies to the vendor's other addresses
// and the workspace notification list, and the workspace reply-to; then
// mark the PO sent with a po_sent event. The caller broadcasts the event
// and calls notifyPoSent.
//
// Never twice by accident, never silent:
// - every request carries a requestId; the same request again (a lost
//   response, a repeated tap) answers what that attempt did and sends
//   nothing;
// - a PO that is already sent answers so and sends nothing, unless the
//   request asks for a resend (a separate, confirmed action);
// - a failure marks the PO failed with the reason and a po_failed event
//   (a failed resend leaves it sent, with the reason), and frees it for a
//   retry, which goes through the same confirmation.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch } from "@/db/batch";
import { events, orders, purchaseOrders, vendors } from "@/db/schema";
import { brandHex } from "@/lib/branding";
import { recipientsFor, sameRecipients, subtotalCents, type PoRecipients } from "@/lib/po";
import { eventView, isRecord, type EventView } from "@/server/desk/shapes";
import { sendEmail, senderFor } from "@/server/email/send";
import { loadMailWorkspace } from "@/server/email/workspace";
import type { PoSentNotice } from "@/server/notify";
import { vendorPoEmail } from "./email";
import { nextPoNumber, PoNumberError } from "./number";
import { renderPoPdf } from "./pdf";
import {
  leaseFree,
  loadPoRow,
  loadPoView,
  notificationEmailsOf,
  poPrefixOf,
  readLines,
  readShipTo,
  sendLeaseActive,
  type PoView,
} from "./service";
import { loadLogoBytes, poPdfKey, toBase64, type PoBucket } from "./storage";

// Well under the Email Service message limit once base64 grows it by a
// third.
export const PO_PDF_MAX_BYTES = 5 * 1024 * 1024;
const REASON_MAX = 300;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export type SendDeps = {
  env: CloudflareEnv;
  bucket: PoBucket;
  now?: () => number;
};

export type SendResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  // No confirmation, or not of these recipients: nothing was sent.
  | { kind: "confirm-required"; error: string; recipients: PoRecipients }
  | { kind: "recipients-changed"; error: string; recipients: PoRecipients }
  // Another send attempt holds the PO right now.
  | { kind: "busy"; error: string; po: PoView }
  // Nothing sent by this request: the PO was already sent, or this exact
  // request already ran (po says how it went).
  | { kind: "unchanged"; reason: "already-sent" | "replayed"; po: PoView }
  | { kind: "sent"; po: PoView; event: EventView; notice: PoSentNotice; emailed: string[]; first: boolean }
  | { kind: "failed"; error: string; po: PoView; event: EventView };

type SendRequest = {
  requestId: string;
  confirm: boolean;
  recipients: PoRecipients | null;
  resend: boolean;
  // The sender's IANA time zone, for the date on the PDF and in the email
  // (UTC without a real one).
  timeZone: string | null;
};

function parseTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function parseRecipients(value: unknown): PoRecipients | null {
  if (!isRecord(value) || !Array.isArray(value.to) || !Array.isArray(value.cc)) {
    return null;
  }
  if (![...value.to, ...value.cc].every((email) => typeof email === "string" && email.length <= 254)) {
    return null;
  }
  return { to: value.to as string[], cc: value.cc as string[] };
}

function parseRequest(body: unknown): SendRequest | string {
  if (!isRecord(body)) {
    return "Send the request as a JSON object";
  }
  if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) {
    return "requestId is required (8 to 64 letters, digits, - or _)";
  }
  return {
    requestId: body.requestId,
    confirm: body.confirm === true,
    recipients: parseRecipients(body.recipients),
    resend: body.resend === true,
    timeZone: parseTimeZone(body.timeZone),
  };
}

class SendFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function plainReason(prefix: string, e: unknown): string {
  const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const cleaned = detail.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const text = cleaned ? `${prefix}: ${cleaned}` : prefix;
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 3)}...` : text;
}

export async function sendPurchaseOrder(
  db: Db,
  deps: SendDeps,
  ctx: { workspaceId: string; poId: string; userId: string },
  body: unknown,
): Promise<SendResult> {
  const now = deps.now ?? Date.now;
  const request = parseRequest(body);
  if (typeof request === "string") {
    return { kind: "invalid", error: request };
  }
  const row = await loadPoRow(db, ctx.workspaceId, ctx.poId);
  if (!row) {
    return { kind: "not-found" };
  }
  const view = async () => (await loadPoView(db, ctx.workspaceId, ctx.poId, now()))!;

  // The same request again sends nothing: it answers how that attempt went
  // (or that it is still running).
  if (row.sendAttempt === request.requestId) {
    if (sendLeaseActive(row, now())) {
      return { kind: "busy", error: "This purchase order is being sent right now.", po: await view() };
    }
    return { kind: "unchanged", reason: "replayed", po: await view() };
  }
  if (request.resend && row.status !== "sent") {
    return { kind: "invalid", error: "Only a purchase order that was sent can be sent again." };
  }
  if (!request.resend && row.status === "sent") {
    return { kind: "unchanged", reason: "already-sent", po: await view() };
  }

  const [vendorRows, notificationEmails, prefix, mail, orderRows] = await Promise.all([
    db
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, row.vendorId), eq(vendors.workspaceId, ctx.workspaceId)))
      .limit(1),
    notificationEmailsOf(db, ctx.workspaceId),
    poPrefixOf(db, ctx.workspaceId),
    loadMailWorkspace(db, ctx.workspaceId),
    db
      .select({ name: orders.name })
      .from(orders)
      .where(and(eq(orders.id, row.orderId), eq(orders.workspaceId, ctx.workspaceId)))
      .limit(1),
  ]);
  const vendor = vendorRows[0];
  if (!vendor || vendor.archived) {
    return { kind: "invalid", error: "This purchase order's vendor was removed. Edit it and pick another vendor." };
  }
  if (!mail || !orderRows[0]) {
    return { kind: "not-found" };
  }

  const recipients = recipientsFor({ email: vendor.email, cc: Array.isArray(vendor.cc) ? vendor.cc : [] }, notificationEmails);
  if (!request.confirm || !request.recipients) {
    return {
      kind: "confirm-required",
      error: "Confirm who this purchase order goes to before it is sent.",
      recipients,
    };
  }
  if (!sameRecipients(request.recipients, recipients)) {
    return {
      kind: "recipients-changed",
      error: "Who this purchase order goes to changed since you reviewed it. Check the recipients and confirm again.",
      recipients,
    };
  }

  const lines = readLines(row.lineItems);
  const subtotal = subtotalCents(lines);
  if (lines.length === 0 || subtotal === null) {
    return { kind: "invalid", error: "Enter a unit cost for every line before sending." };
  }

  // Claim: only while the PO is in a state this request may send from and
  // no other attempt holds it.
  const claimedAt = now();
  const claimed = await db
    .update(purchaseOrders)
    .set({ sendStartedAt: claimedAt, sendAttempt: request.requestId })
    .where(
      and(
        eq(purchaseOrders.id, row.id),
        eq(purchaseOrders.workspaceId, ctx.workspaceId),
        inArray(purchaseOrders.status, request.resend ? ["sent"] : ["draft", "failed"]),
        leaseFree(claimedAt),
      ),
    )
    .returning({ id: purchaseOrders.id });
  if (claimed.length === 0) {
    const current = await view();
    if (!request.resend && current.state === "sent") {
      return { kind: "unchanged", reason: "already-sent", po: current };
    }
    return { kind: "busy", error: "This purchase order is being sent right now.", po: current };
  }

  const fence = and(eq(purchaseOrders.id, row.id), eq(purchaseOrders.sendAttempt, request.requestId));
  // The PO's date: when it first went out (a resend keeps it), else now.
  const poDate = request.resend && row.sentAt ? row.sentAt : claimedAt;
  let number: string | null = null;
  let storedKey: string | null = null;
  try {
    try {
      number = await nextPoNumber(db, { workspaceId: ctx.workspaceId, poId: row.id, prefix, now: claimedAt });
    } catch (e) {
      throw new SendFailure(e instanceof PoNumberError ? e.message : plainReason("No purchase order number could be assigned", e));
    }

    // A resend carries the PDF the vendor already has; anything else is
    // rendered now (a failed PO may have been edited since).
    let pdf: Uint8Array | null = null;
    if (request.resend && row.pdfKey) {
      try {
        const object = await deps.bucket.get(row.pdfKey);
        pdf = object ? new Uint8Array(await object.arrayBuffer()) : null;
        storedKey = pdf ? row.pdfKey : null;
      } catch {
        pdf = null;
      }
    }
    if (!pdf) {
      try {
        pdf = await renderPoPdf({
          workspaceName: mail.name,
          primaryColor: brandHex(mail.branding?.colors?.primary) ?? brandHex(mail.accentColor),
          replyTo: mail.replyTo,
          logo: await loadLogoBytes(deps.bucket, ctx.workspaceId, mail.branding),
          poNumber: number,
          date: poDate,
          timeZone: request.timeZone,
          orderName: orderRows[0].name,
          vendor: { name: vendor.name, email: vendor.email },
          shipTo: readShipTo(row.shipTo),
          lines,
          currency: row.currency,
          notes: row.notes ?? null,
        });
      } catch (e) {
        throw new SendFailure(plainReason("The PDF could not be made", e));
      }
      if (pdf.length > PO_PDF_MAX_BYTES) {
        throw new SendFailure("The PDF is too large to email (over 5 MB).");
      }
      const key = poPdfKey(ctx.workspaceId, row.id);
      try {
        await deps.bucket.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
      } catch (e) {
        throw new SendFailure(plainReason("The PDF could not be stored. Try again", e));
      }
      storedKey = key;
      // From here the PO points at this PDF whatever the email does.
      await db.update(purchaseOrders).set({ pdfKey: key }).where(fence);
      if (row.pdfKey && row.pdfKey !== key) {
        await deps.bucket.delete(row.pdfKey).catch(() => undefined);
      }
    }

    const email = vendorPoEmail(deps.env, mail, {
      poNumber: number,
      orderName: orderRows[0].name,
      vendorName: vendor.name,
      lines,
      currency: row.currency,
      subtotalCents: subtotal,
      shipTo: readShipTo(row.shipTo),
      notes: row.notes ?? null,
      date: poDate,
      timeZone: request.timeZone,
    });
    const sender = senderFor(deps.env, mail);
    try {
      await sendEmail(deps.env, {
        from: sender.from,
        ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
        to: recipients.to,
        ...(recipients.cc.length > 0 ? { cc: recipients.cc } : {}),
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: [{ filename: `${number}.pdf`, content: toBase64(pdf) }],
      });
    } catch (e) {
      throw new SendFailure(plainReason("The email was not sent", e));
    }
  } catch (e) {
    const reason = e instanceof SendFailure ? e.reason : plainReason("The purchase order was not sent", e);
    const failedAt = now();
    const event = {
      id: crypto.randomUUID(),
      workspaceId: ctx.workspaceId,
      orderId: row.orderId,
      type: "po_failed" as const,
      text: `Purchase order ${number ?? "draft"} was not ${request.resend ? "sent again" : "sent"}: ${reason}`,
      actorId: ctx.userId,
      meta: { poId: row.id, poNumber: number, resend: request.resend },
      createdAt: failedAt,
      source: "app" as const,
    };
    await applyBatch(db, [
      db
        .update(purchaseOrders)
        .set({
          status: request.resend ? "sent" : "failed",
          lastError: reason,
          sendStartedAt: null,
          updatedAt: failedAt,
        })
        .where(fence),
      db.insert(events).values(event),
    ]);
    console.warn("[po] " + JSON.stringify({ workspaceId: ctx.workspaceId, poId: row.id, sent: false }));
    return { kind: "failed", error: reason, po: await view(), event: eventView(event) };
  }

  // The try above only completes once the number is minted.
  const poNumber = number as string;
  const sentAt = now();
  const event = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: row.orderId,
    type: "po_sent" as const,
    text: `Purchase order ${poNumber} ${request.resend ? "sent again" : "sent"} to ${vendor.name}`,
    actorId: ctx.userId,
    meta: { poId: row.id, poNumber, resend: request.resend },
    createdAt: sentAt,
    source: "app" as const,
  };
  const [marked] = await applyBatch(db, [
    db
      .update(purchaseOrders)
      .set({
        status: "sent",
        sentAt: sql`coalesce(${purchaseOrders.sentAt}, ${sentAt})`,
        pdfKey: storedKey,
        sentTo: recipients,
        sentBy: ctx.userId,
        sendCount: sql`${purchaseOrders.sendCount} + 1`,
        sendStartedAt: null,
        lastError: null,
        updatedAt: sentAt,
      })
      .where(fence)
      .returning({ id: purchaseOrders.id }),
    db.insert(events).values(event),
  ]);
  if (Array.isArray(marked) && marked.length === 0) {
    // The email went out, but this attempt's claim expired and another took
    // the PO meanwhile; the event above still records the send.
    console.warn("[po] " + JSON.stringify({ workspaceId: ctx.workspaceId, poId: row.id, lateMark: true }));
  }
  console.warn("[po] " + JSON.stringify({ workspaceId: ctx.workspaceId, poId: row.id, sent: true, resend: request.resend }));
  return {
    kind: "sent",
    po: await view(),
    event: eventView(event),
    notice: {
      poId: row.id,
      poNumber,
      orderId: row.orderId,
      orderName: orderRows[0].name,
      vendorName: vendor.name,
      actorId: ctx.userId,
    },
    emailed: [...recipients.to, ...recipients.cc],
    first: !request.resend,
  };
}
