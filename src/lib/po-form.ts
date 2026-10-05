// The purchase order review form (src/components/desk/po-modal.tsx) as
// pure functions: the first draft from an order, a saved PO loaded back,
// what the reviewer typed read into a draft body with a plain message per
// field, line totals and the unsaved-changes check. The server validates
// everything again (src/server/po/service.ts).

import type { PoView } from "@/server/po/service";
import type { OrderSnapshot } from "./order-snapshot";
import { shippingLines } from "./order-snapshot";
import {
  costToCents,
  linesFromOrderItems,
  normalizeCostInput,
  PO_DESCRIPTION_MAX,
  PO_NOTES_MAX,
  PO_QUANTITY_MAX,
  PO_SHIP_TO_LINE_MAX,
  PO_SHIP_TO_LINES_MAX,
  PO_SKU_MAX,
  type PoLine,
} from "./po";

// Inputs hold what was typed; key tells rows apart for React.
export type PoFormLine = { key: string; description: string; sku: string; quantity: string; unitCost: string };

export type PoForm = { vendorId: string; lines: PoFormLine[]; shipTo: string; notes: string };

export type PoDraftBody = { vendorId: string; lines: PoLine[]; shipTo: string[]; notes: string | null };

export type PoLineErrors = { description?: string; sku?: string; quantity?: string; unitCost?: string };

export type PoFormErrors = {
  vendor?: string;
  lines: Record<string, PoLineErrors>;
  shipTo?: string;
  notes?: string;
  form?: string;
};

let nextKey = 0;

function lineKey(): string {
  nextKey += 1;
  return `line-${nextKey}`;
}

export function emptyLine(): PoFormLine {
  return { key: lineKey(), description: "", sku: "", quantity: "1", unitCost: "" };
}

function formLine(line: PoLine): PoFormLine {
  return {
    key: lineKey(),
    description: line.description,
    sku: line.sku,
    quantity: String(line.quantity),
    unitCost: line.unitCost ?? "",
  };
}

export function formFromOrder(snapshot: OrderSnapshot): PoForm {
  const lines = linesFromOrderItems(snapshot.items).map(formLine);
  return {
    vendorId: "",
    lines: lines.length > 0 ? lines : [emptyLine()],
    shipTo: snapshot.shipping ? shippingLines(snapshot.shipping).join("\n") : "",
    notes: "",
  };
}

export function formFromPo(po: Pick<PoView, "vendor" | "lines" | "shipTo" | "notes">): PoForm {
  return {
    // A removed vendor must be picked again.
    vendorId: po.vendor && !po.vendor.archived ? po.vendor.id : "",
    lines: po.lines.length > 0 ? po.lines.map(formLine) : [emptyLine()],
    shipTo: po.shipTo.join("\n"),
    notes: po.notes ?? "",
  };
}

const WHOLE = /^\d+$/;

function readQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (!WHOLE.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return value >= 1 && value <= PO_QUANTITY_MAX ? value : null;
}

// requireCosts: a send needs a cost on every line; a draft does not.
export function readForm(
  form: PoForm,
  opts: { requireCosts: boolean },
): { ok: true; body: PoDraftBody } | { ok: false; errors: PoFormErrors } {
  const errors: PoFormErrors = { lines: {} };
  let failed = false;
  if (!form.vendorId) {
    errors.vendor = "Pick a vendor";
    failed = true;
  }
  if (form.lines.length === 0) {
    errors.form = "Add at least one line";
    failed = true;
  }
  const lines: PoLine[] = [];
  for (const line of form.lines) {
    const lineErrors: PoLineErrors = {};
    const description = line.description.replace(/\s+/g, " ").trim();
    if (description.length === 0) {
      lineErrors.description = "Add a description";
    } else if (description.length > PO_DESCRIPTION_MAX) {
      lineErrors.description = `Keep it to ${PO_DESCRIPTION_MAX} characters`;
    }
    const sku = line.sku.trim();
    if (sku.length > PO_SKU_MAX) {
      lineErrors.sku = `Keep it to ${PO_SKU_MAX} characters`;
    }
    const quantity = readQuantity(line.quantity);
    if (quantity === null) {
      lineErrors.quantity = `Enter a whole number from 1 to ${PO_QUANTITY_MAX.toLocaleString("en-US")}`;
    }
    const cost = normalizeCostInput(line.unitCost);
    if (cost === null) {
      lineErrors.unitCost = "Enter an amount like 12.50";
    } else if (cost === "" && opts.requireCosts) {
      lineErrors.unitCost = "Enter the unit cost";
    }
    if (Object.keys(lineErrors).length > 0) {
      errors.lines[line.key] = lineErrors;
      failed = true;
      continue;
    }
    lines.push({ description, sku, quantity: quantity as number, unitCost: cost === "" || cost === null ? null : cost });
  }
  const shipTo = form.shipTo
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  if (shipTo.length > PO_SHIP_TO_LINES_MAX || shipTo.some((line) => line.length > PO_SHIP_TO_LINE_MAX)) {
    errors.shipTo = `Use up to ${PO_SHIP_TO_LINES_MAX} lines of up to ${PO_SHIP_TO_LINE_MAX} characters`;
    failed = true;
  }
  const notes = form.notes.trim();
  if (notes.length > PO_NOTES_MAX) {
    errors.notes = `Keep notes to ${PO_NOTES_MAX.toLocaleString("en-US")} characters`;
    failed = true;
  }
  if (failed) {
    return { ok: false, errors };
  }
  return { ok: true, body: { vendorId: form.vendorId, lines, shipTo, notes: notes.length > 0 ? notes : null } };
}

// Line totals in cents (null while a line's quantity or cost does not read)
// and the subtotal (null while any line has none).
export function formTotals(form: PoForm): { lineTotals: Record<string, number | null>; subtotalCents: number | null } {
  const lineTotals: Record<string, number | null> = {};
  let subtotal: number | null = form.lines.length > 0 ? 0 : null;
  for (const line of form.lines) {
    const quantity = readQuantity(line.quantity);
    const cost = normalizeCostInput(line.unitCost);
    const cents = cost ? costToCents(cost) : null;
    const total = quantity !== null && cents !== null ? quantity * cents : null;
    lineTotals[line.key] = total;
    subtotal = subtotal === null || total === null ? null : subtotal + total;
  }
  return { lineTotals, subtotalCents: subtotal };
}

function comparable(form: PoForm) {
  return {
    vendorId: form.vendorId,
    lines: form.lines.map(({ description, sku, quantity, unitCost }) => ({ description, sku, quantity, unitCost })),
    shipTo: form.shipTo,
    notes: form.notes,
  };
}

// Whether two forms hold the same values (row keys aside).
export function sameForm(a: PoForm, b: PoForm): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}
