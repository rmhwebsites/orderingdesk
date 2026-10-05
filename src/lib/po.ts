// Purchase order values shared by the server (src/server/po/) and the
// review modal: field limits, line money in whole cents, the prefill from
// an order's items, and who a PO email goes to. Pure functions.

import { formatMoney } from "./format";

export const PO_LINES_MAX = 200;
export const PO_DESCRIPTION_MAX = 300;
export const PO_SKU_MAX = 64;
export const PO_QUANTITY_MAX = 99999;
export const PO_SHIP_TO_LINES_MAX = 8;
export const PO_SHIP_TO_LINE_MAX = 120;
export const PO_NOTES_MAX = 2000;

// One line of a purchase order. unitCost is a plain decimal with at most
// two places ("12.50"), or null while the reviewer has not entered it.
export type PoLine = { description: string; sku: string; quantity: number; unitCost: string | null };

export type PoRecipients = { to: string[]; cc: string[] };

// Up to 9,999,999.99.
const COST = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

// A unit cost in whole cents, or null for anything but a plain decimal.
export function costToCents(value: string): number | null {
  const match = value.match(COST);
  if (!match) {
    return null;
  }
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number(match[1]) * 100 + Number(fraction);
}

export function centsToDecimal(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

// What someone typed into a cost field, as the stored decimal: "" for a
// blank field, null when it is not an amount. A currency sign, thousands
// commas and spaces are dropped.
export function normalizeCostInput(raw: string): string | null {
  const cleaned = raw.replace(/[\s$,]/g, "");
  if (cleaned.length === 0) {
    return "";
  }
  const cents = costToCents(cleaned);
  return cents === null ? null : centsToDecimal(cents);
}

export function lineTotalCents(line: PoLine): number | null {
  const unit = line.unitCost === null ? null : costToCents(line.unitCost);
  return unit === null ? null : unit * line.quantity;
}

// The sum of every line, or null while any line has no cost (a partial sum
// would read as the real one).
export function subtotalCents(lines: PoLine[]): number | null {
  let total = 0;
  for (const line of lines) {
    const cents = lineTotalCents(line);
    if (cents === null) {
      return null;
    }
    total += cents;
  }
  return total;
}

export function formatCents(cents: number, currency: string): string {
  return formatMoney(centsToDecimal(cents), currency);
}

type OrderItem = { title: string; variant: string; sku: string; qty: number; price: string | null };

// The review modal's first draft: each order item as a line, the cost left
// for the reviewer (the order's price is what the customer paid, not what
// the vendor charges).
export function linesFromOrderItems(items: OrderItem[]): PoLine[] {
  return items.map((item) => {
    const title = item.title.trim() || "Untitled item";
    const variant = item.variant.trim();
    const quantity = Number.isInteger(item.qty) && item.qty >= 1 ? Math.min(item.qty, PO_QUANTITY_MAX) : 1;
    return {
      description: (variant ? `${title} (${variant})` : title).slice(0, PO_DESCRIPTION_MAX),
      sku: item.sku.trim().slice(0, PO_SKU_MAX),
      quantity,
      unitCost: null,
    };
  });
}

// Who a purchase order email goes to: the vendor's order address, with
// copies to the vendor's other addresses and the workspace notification
// list, each address once.
export function recipientsFor(vendor: { email: string; cc: string[] }, notificationEmails: string[]): PoRecipients {
  const to = vendor.email.trim().toLowerCase();
  const cc: string[] = [];
  for (const raw of [...vendor.cc, ...notificationEmails]) {
    const email = raw.trim().toLowerCase();
    if (email.length > 0 && email !== to && !cc.includes(email)) {
      cc.push(email);
    }
  }
  return { to: [to], cc };
}

function sortedLower(list: string[]): string[] {
  return list.map((email) => email.trim().toLowerCase()).sort();
}

function sameList(a: string[], b: string[]): boolean {
  const x = sortedLower(a);
  const y = sortedLower(b);
  return x.length === y.length && x.every((email, index) => email === y[index]);
}

// Whether the recipients someone confirmed are exactly these.
export function sameRecipients(a: PoRecipients, b: PoRecipients): boolean {
  return sameList(a.to, b.to) && sameList(a.cc, b.cc);
}
