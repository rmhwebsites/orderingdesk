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
};

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

export function newOrderEmail(
  env: CloudflareEnv,
  workspace: MailWorkspace,
  order: OrderSummaryForEmail,
  url: string,
): RenderedEmail {
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
    const detail = [order.customerName.trim(), total(order)].filter((part) => part.length > 0).join(", ");
    return [order.name, escapeHtml(detail || "New order")];
  });
  const rest = orders.length - shown.length;
  const count = plural(orders.length, "new order");
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `${count} came in for ${workspace.name}.`,
    heading: count.charAt(0).toUpperCase() + count.slice(1),
    bodyHtml:
      emailParagraph(`These orders came in for ${escapeHtml(workspace.name)}.`) +
      summaryTable(rows) +
      (rest > 0 ? emailParagraph(`And ${escapeHtml(plural(rest, "more order"))}.`) : ""),
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
