// The browser side of the purchase order routes: list, save and the
// confirmed send, with the send route's answers read into outcomes the
// review modal and the drawer's history act on.

import type { PoView } from "@/server/po/service";
import { formatDate } from "./format";
import type { PoRecipients } from "./po";
import type { PoDraftBody } from "./po-form";

export type PoList = { pos: PoView[]; canManage: boolean; nextNumber: string | null };

export type SendOutcome =
  | { kind: "sent"; po: PoView }
  // Nothing sent by this request (already sent, or the same request ran).
  | { kind: "unchanged"; po: PoView; reason: string }
  // Confirm again: no confirmation reached the server, or who it goes to
  // changed since the review.
  | { kind: "recipients"; recipients: PoRecipients; message: string }
  | { kind: "busy"; message: string; po: PoView }
  | { kind: "failed"; message: string; po: PoView }
  | { kind: "error"; message: string }
  // No answer: the same request id can be sent again safely.
  | { kind: "offline" };

type Body = Record<string, unknown> | null;

function isRecipients(value: unknown): value is PoRecipients {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as PoRecipients).to) &&
    Array.isArray((value as PoRecipients).cc)
  );
}

export function interpretSendResponse(status: number, body: Body): SendOutcome {
  const message = typeof body?.error === "string" ? body.error : "";
  const po = body?.po as PoView | undefined;
  if (status === 200 && po) {
    return typeof body?.unchanged === "string" ? { kind: "unchanged", po, reason: body.unchanged } : { kind: "sent", po };
  }
  if ((status === 400 || status === 409) && isRecipients(body?.recipients)) {
    return { kind: "recipients", recipients: body.recipients as PoRecipients, message };
  }
  if (status === 409 && po) {
    return { kind: "busy", message, po };
  }
  if (status === 502 && po) {
    return { kind: "failed", message, po };
  }
  if (status === 404) {
    return { kind: "error", message: "This purchase order is not available to you. Reload the page." };
  }
  return { kind: "error", message: message || `Something went wrong (HTTP ${status}). Nothing was sent twice; try again.` };
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function recipientSummary(recipients: PoRecipients): { to: string; copies: string } {
  return {
    to: recipients.to.join(", "),
    copies: recipients.cc.length > 0 ? recipients.cc.join(", ") : "No copies",
  };
}

export async function sendPo(
  poId: string,
  request: { requestId: string; recipients: PoRecipients; resend: boolean },
): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/pos/${encodeURIComponent(poId)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: request.requestId,
        confirm: true,
        recipients: request.recipients,
        resend: request.resend,
        timeZone: browserTimeZone(),
      }),
      cache: "no-store",
    });
  } catch {
    return { kind: "offline" };
  }
  const body = (await response.json().catch(() => null)) as Body;
  return interpretSendResponse(response.status, body);
}

export type SaveOutcome = { ok: true; po: PoView } | { ok: false; message: string; po?: PoView };

// Creates the draft (poId null) or saves it.
export async function savePoDraft(orderId: string, poId: string | null, body: PoDraftBody): Promise<SaveOutcome> {
  let response: Response;
  try {
    response = await fetch(poId ? `/api/pos/${encodeURIComponent(poId)}` : `/api/orders/${encodeURIComponent(orderId)}/pos`, {
      method: poId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: "Could not reach the server. Your changes are still here, so you can try again." };
  }
  const data = (await response.json().catch(() => null)) as Body;
  if (response.ok && data?.po) {
    return { ok: true, po: data.po as PoView };
  }
  const message =
    typeof data?.error === "string"
      ? data.error
      : response.status === 404
        ? "This is not available to you. Reload the page."
        : `Not saved (HTTP ${response.status}). Try again.`;
  return { ok: false, message, ...(data?.po ? { po: data.po as PoView } : {}) };
}

export async function loadPoList(orderId: string): Promise<PoList | null> {
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/pos`, { cache: "no-store" });
    return response.ok ? ((await response.json()) as PoList) : null;
  } catch {
    return null;
  }
}

type PoTiming = Pick<PoView, "state" | "sendCount" | "sentAt" | "createdAt" | "updatedAt">;

// The state chip: a semantic tone (globals.css data-tone) and its label.
export function poStateChip(po: Pick<PoTiming, "state" | "sendCount">): { tone: string; label: string } {
  switch (po.state) {
    case "draft":
      return { tone: "slate", label: "Draft" };
    case "sending":
      return { tone: "blue", label: "Sending" };
    case "sent":
      return { tone: "green", label: po.sendCount > 1 ? `Sent ${po.sendCount} times` : "Sent" };
    case "failed":
      return { tone: "red", label: "Not sent" };
  }
}

export function poDateLine(po: PoTiming, timeZone?: string): string {
  switch (po.state) {
    case "draft":
      return `started ${formatDate(po.createdAt, timeZone)}`;
    case "sending":
      return "sending now";
    case "sent":
      return `sent ${formatDate(po.sentAt ?? po.updatedAt ?? po.createdAt, timeZone)}`;
    case "failed":
      return `last tried ${formatDate(po.updatedAt ?? po.createdAt, timeZone)}`;
  }
}
