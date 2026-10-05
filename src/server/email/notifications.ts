// The notification emails (design doc: branded email for new orders and
// purchase order sends; customers are never emailed). Each renders through
// renderEmail with the workspace's branding; src/server/notify.ts picks the
// sender (senderFor) and the recipients.
//
// Every value interpolated into HTML passes escapeHtml (renderEmail escapes
// what it is given except bodyHtml, which is built here, escaped); every
// subject passes sanitizeSubject. The order summary carries the customer's
// name, the items and the total: no customer email or address.
//
// Relative imports: the cron path bundles this (src/server/notify.ts).

import { formatMoney } from "../../lib/format";
import { appOrigin } from "../host";
import { escapeHtml, sanitizeSubject } from "./escape";
import { emailParagraph, renderEmail } from "./layout";
import type { MailWorkspace } from "./workspace";

export type OrderSummaryForEmail = {
  id: string;
  name: string;
  customerName: string;
  total: string;
  currency: string;
  items: { title: string; qty: number; variant: string }[];
  // Draft orders spec section 12: a draft card announces itself as a
  // request, with its request fields (src/lib/request-fields.ts). Absent
  // means an order.
  kind?: "draft" | "order";
  company?: string;
  location?: string;
  requestFor?: string;
  branch?: string;
  // Up to REQUEST_ATTRIBUTES_SHOWN public attributes, values clipped.
  attributes?: { key: string; value: string }[];
};

// What a request email shows of its cart attributes.
export const REQUEST_ATTRIBUTES_SHOWN = 6;
export const REQUEST_VALUE_MAX = 200;

export type PoSentNotice = {
  poId: string;
  poNumber: string;
  orderId: string;
  orderName: string;
  vendorName: string;
  // Who sent it (they get no push about their own send), or null.
  actorId: string | null;
};

export type RenderedEmail = { subject: string; html: string; text: string };

const ITEMS_SHOWN = 8;
const DIGEST_SHOWN = 20;
const LABEL_STYLE = "padding:6px 16px 6px 0;vertical-align:top;font-size:14px;line-height:20px;font-weight:700;white-space:nowrap;";
const VALUE_STYLE = "padding:6px 0;vertical-align:top;font-size:14px;line-height:20px;";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Label and value rows; values are already-escaped HTML.
function summaryTable(rows: Array<[string, string]>): string {
  const body = rows
    .map(([label, value]) => `<tr><td style="${LABEL_STYLE}">${escapeHtml(label)}</td><td style="${VALUE_STYLE}">${value}</td></tr>`)
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 8px 0;">${body}</table>`;
}

function itemLine(item: OrderSummaryForEmail["items"][number]): string {
  const title = item.title.trim() || "Untitled item";
  const variant = item.variant.trim();
  return escapeHtml(`${item.qty} x ${title}${variant ? ` (${variant})` : ""}`);
}

function itemsHtml(items: OrderSummaryForEmail["items"]): string {
  if (items.length === 0) {
    return "No items listed";
  }
  const shown = items.slice(0, ITEMS_SHOWN).map(itemLine);
  const rest = items.length - shown.length;
  return shown.join("<br>") + (rest > 0 ? `<br>and ${plural(rest, "more item")}` : "");
}

function total(order: Pick<OrderSummaryForEmail, "total" | "currency">): string {
  return formatMoney(order.total, order.currency);
}

const isRequest = (order: OrderSummaryForEmail) => order.kind === "draft";

function clipValue(value: string): string {
  const flat = value.trim();
  return flat.length > REQUEST_VALUE_MAX ? `${flat.slice(0, REQUEST_VALUE_MAX - 3).trimEnd()}...` : flat;
}

// "3 new requests", "2 new orders", or "5 new orders and requests".
export function arrivalsPhrase(list: OrderSummaryForEmail[]): string {
  const requests = list.filter(isRequest).length;
  if (requests === list.length) {
    return plural(list.length, "new request");
  }
  if (requests === 0) {
    return plural(list.length, "new order");
  }
  return `${list.length} new orders and requests`;
}

// A request (a draft order waiting for review): its fields and items, no
// requester email or address.
function newRequestEmail(env: CloudflareEnv, workspace: MailWorkspace, request: OrderSummaryForEmail, url: string): RenderedEmail {
  const customer = request.customerName.trim();
  const rows: Array<[string, string]> = [["Request", escapeHtml(request.name)]];
  if (customer) {
    rows.push(["Requested by", escapeHtml(customer)]);
  }
  if (request.company?.trim()) {
    rows.push(["Company", escapeHtml(request.company.trim())]);
  }
  if (request.location?.trim()) {
    rows.push(["Location", escapeHtml(request.location.trim())]);
  }
  for (const attribute of (request.attributes ?? []).slice(0, REQUEST_ATTRIBUTES_SHOWN)) {
    rows.push([attribute.key.trim(), escapeHtml(clipValue(attribute.value))]);
  }
  const amount = Number(request.total) !== 0 ? total(request) : "";
  if (amount) {
    rows.push(["Total", escapeHtml(amount)]);
  }
  rows.push(["Items", itemsHtml(request.items)]);
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `${customer || "Someone"} sent request ${request.name}.`,
    heading: `New request ${request.name}`,
    bodyHtml:
      emailParagraph(
        `A new request came in for ${escapeHtml(workspace.name)}. It is waiting for a manager to approve or reject it.`,
      ) + summaryTable(rows),
    cta: { label: "Open the request", url },
    footerNote: `Managers choose who gets these emails, and each person their own, in ${workspace.name} Settings.`,
  });
  return {
    subject: sanitizeSubject(`New Request ${request.name}${customer ? ` from ${customer}` : ""}`),
    html,
    text,
  };
}

export function newOrderEmail(
  env: CloudflareEnv,
  workspace: MailWorkspace,
  order: OrderSummaryForEmail,
  url: string,
): RenderedEmail {
  if (isRequest(order)) {
    return newRequestEmail(env, workspace, order, url);
  }
  const customer = order.customerName.trim();
  const amount = total(order);
  const rows: Array<[string, string]> = [["Order", escapeHtml(order.name)]];
  if (customer) {
    rows.push(["Customer", escapeHtml(customer)]);
  }
  if (amount) {
    rows.push(["Total", escapeHtml(amount)]);
  }
  rows.push(["Items", itemsHtml(order.items)]);
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `${customer || "A customer"} placed order ${order.name}${amount ? ` for ${amount}` : ""}.`,
    heading: `New order ${order.name}`,
    bodyHtml: emailParagraph(`A new order came in for ${escapeHtml(workspace.name)}.`) + summaryTable(rows),
    cta: { label: "Open the order", url },
    footerNote: `Managers choose who gets these emails, and each person their own, in ${workspace.name} Settings.`,
  });
  return {
    subject: sanitizeSubject(`New order ${order.name}${customer ? ` from ${customer}` : ""}`),
    html,
    text,
  };
}

// More orders at once than are worth an email each (a first sync, a catch
// up after an outage): one email listing them.
export function newOrdersDigestEmail(
  env: CloudflareEnv,
  workspace: MailWorkspace,
  orders: OrderSummaryForEmail[],
  deskUrl: string,
): RenderedEmail {
  const shown = orders.slice(0, DIGEST_SHOWN);
  const rows: Array<[string, string]> = shown.map((order) => {
    const second = isRequest(order) ? (order.branch ?? "").trim() : total(order);
    const detail = [order.customerName.trim(), second].filter((part) => part.length > 0).join(", ");
    return [order.name, escapeHtml(detail || (isRequest(order) ? "New request" : "New order"))];
  });
  const rest = orders.length - shown.length;
  const count = arrivalsPhrase(orders);
  const requests = orders.every(isRequest);
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `${count} came in for ${workspace.name}.`,
    heading: count.charAt(0).toUpperCase() + count.slice(1),
    bodyHtml:
      emailParagraph(`These ${requests ? "requests" : orders.some(isRequest) ? "orders and requests" : "orders"} came in for ${escapeHtml(workspace.name)}.`) +
      summaryTable(rows) +
      (rest > 0 ? emailParagraph(`And ${rest} more.`) : ""),
    cta: { label: "Open orders", url: deskUrl },
    footerNote: `Managers choose who gets these emails, and each person their own, in ${workspace.name} Settings.`,
  });
  return { subject: sanitizeSubject(`${count} in ${workspace.name}`), html, text };
}

export function poSentEmail(env: CloudflareEnv, workspace: MailWorkspace, po: PoSentNotice, url: string): RenderedEmail {
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `Purchase order ${po.poNumber} for order ${po.orderName} went to ${po.vendorName}.`,
    heading: `Purchase order ${po.poNumber} sent`,
    bodyHtml:
      emailParagraph(
        `Purchase order ${escapeHtml(po.poNumber)} for order ${escapeHtml(po.orderName)} went to ${escapeHtml(po.vendorName)}.`,
      ) +
      summaryTable([
        ["Purchase order", escapeHtml(po.poNumber)],
        ["Order", escapeHtml(po.orderName)],
        ["Vendor", escapeHtml(po.vendorName)],
      ]),
    cta: { label: "Open the order", url },
    footerNote: `Managers choose who gets these emails, and each person their own, in ${workspace.name} Settings.`,
  });
  return { subject: sanitizeSubject(`Purchase order ${po.poNumber} sent to ${po.vendorName}`), html, text };
}
