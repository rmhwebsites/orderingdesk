// Purchase order drafts and how a PO reads in the app. Managers and
// platform admins create and edit drafts (the routes check the role);
// everyone in the workspace sees the PO history of an order. Sending lives
// in src/server/po/send.ts and never happens from here.
//
// A PO is editable while it is a draft or its last send failed, and no send
// attempt holds it. Every query is scoped to the workspace it is given.

import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch } from "@/db/batch";
import { events, orders, purchaseOrders, vendors, workspaceSettings } from "@/db/schema";
import {
  centsToDecimal,
  costToCents,
  PO_DESCRIPTION_MAX,
  PO_LINES_MAX,
  PO_NOTES_MAX,
  PO_QUANTITY_MAX,
  PO_SHIP_TO_LINE_MAX,
  PO_SHIP_TO_LINES_MAX,
  PO_SKU_MAX,
  recipientsFor,
  subtotalCents,
  type PoLine,
  type PoRecipients,
} from "@/lib/po";
import { eventView, isRecord, type EventView } from "@/server/desk/shapes";
import { draftPoNumber, isMintedPoNumber } from "./number";
import { isPoPdfKeyFor } from "./storage";

// How long a send attempt holds a PO. A send renders a PDF, stores it and
// emails it, well inside this; an attempt that never finished (the Worker
// was stopped) frees the PO after it, and the PO then reads as interrupted.
export const SEND_LEASE_MS = 2 * 60 * 1000;

export type PoState = "draft" | "sending" | "sent" | "failed";

export type PoVendorView = { id: string; name: string; email: string; cc: string[]; archived: boolean };

export type PoView = {
  id: string;
  orderId: string;
  // The minted number, or null before the first send attempt.
  number: string | null;
  // sending while a send attempt holds the PO.
  state: PoState;
  // A send attempt started and never finished: the vendor may or may not
  // have the email.
  interrupted: boolean;
  vendor: PoVendorView | null;
  lines: PoLine[];
  shipTo: string[];
  notes: string | null;
  currency: string;
  // Decimal string, or null while any line has no cost.
  subtotal: string | null;
  lastError: string | null;
  sentAt: number | null;
  sentTo: PoRecipients | null;
  sendCount: number;
  createdAt: number;
  createdBy: string;
  updatedAt: number | null;
  // Where the PDF of the last send attempt opens, or null when there is none.
  pdfUrl: string | null;
  // Who a send would go to now (the vendor's current addresses and the
  // workspace notification list), or null without an active vendor.
  recipients: PoRecipients | null;
  // What a send would carry now, as one value (poContentVersion). The review
  // step hands it back with Send to vendor; a send of anything else is
  // refused with what would go out instead.
  contentVersion: string;
};

export type PoDraftInput = { vendorId: string; lines: PoLine[]; shipTo: string[]; notes: string | null };

type PoRow = typeof purchaseOrders.$inferSelect;
type VendorRow = typeof vendors.$inferSelect;

const CONTROL = /[\u0000-\u001f\u007f]/g;
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const CURRENCY = /^[A-Z]{3}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

// One line of text: control characters become spaces, spaces collapse.
function oneLine(value: string): string {
  return value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

// ---- Reading -------------------------------------------------------------

function readLine(value: unknown): PoLine | null {
  if (!isRecord(value)) {
    return null;
  }
  const quantity = typeof value.quantity === "number" && Number.isInteger(value.quantity) && value.quantity >= 1 ? value.quantity : 1;
  const unitCost = typeof value.unitCost === "string" && costToCents(value.unitCost) !== null ? value.unitCost : null;
  return {
    description: typeof value.description === "string" ? value.description : "",
    sku: typeof value.sku === "string" ? value.sku : "",
    quantity,
    unitCost,
  };
}

export function readLines(value: unknown): PoLine[] {
  return Array.isArray(value) ? value.map(readLine).filter((line): line is PoLine => line !== null) : [];
}

export function readShipTo(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
}

function readRecipients(value: unknown): PoRecipients | null {
  if (!isRecord(value) || !Array.isArray(value.to) || !Array.isArray(value.cc)) {
    return null;
  }
  return {
    to: value.to.filter((email): email is string => typeof email === "string"),
    cc: value.cc.filter((email): email is string => typeof email === "string"),
  };
}

export function sendLeaseActive(row: Pick<PoRow, "sendStartedAt">, now: number): boolean {
  return row.sendStartedAt !== null && now - row.sendStartedAt < SEND_LEASE_MS;
}

// SQL: no send attempt holds the PO (never claimed, or the claim expired).
export function leaseFree(now: number) {
  return or(isNull(purchaseOrders.sendStartedAt), lt(purchaseOrders.sendStartedAt, now - SEND_LEASE_MS));
}

function vendorView(row: VendorRow): PoVendorView {
  return { id: row.id, name: row.name, email: row.email, cc: Array.isArray(row.cc) ? row.cc : [], archived: row.archived };
}

export type PoContent = {
  updatedAt: number | null;
  vendor: { id: string; name: string; email: string } | null;
  recipients: PoRecipients | null;
  lines: PoLine[];
  shipTo: string[];
  notes: string | null;
  currency: string;
};

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The version of what a send of the PO would carry: the PO's updated_at and
// a SHA-256 of the vendor, the recipients, the lines, the ship-to, the notes
// and the currency. Any save moves updated_at; the hash also catches a save
// in the same millisecond and a change made outside the PO (the vendor
// renamed or readdressed, the workspace notification list edited).
export async function poContentVersion(content: PoContent): Promise<string> {
  const sorted = (list: string[]) => list.map((email) => email.trim().toLowerCase()).sort();
  const canonical = JSON.stringify([
    content.vendor ? [content.vendor.id, content.vendor.name, content.vendor.email] : null,
    content.recipients ? [sorted(content.recipients.to), sorted(content.recipients.cc)] : null,
    content.lines.map((line) => [line.description, line.sku, line.quantity, line.unitCost]),
    content.shipTo,
    content.notes,
    content.currency,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `${content.updatedAt ?? 0}.${hex(digest)}`;
}

export async function poView(row: PoRow, vendor: VendorRow | undefined, notificationEmails: string[], now: number): Promise<PoView> {
  const lines = readLines(row.lineItems);
  const subtotal = subtotalCents(lines);
  const leased = sendLeaseActive(row, now);
  const vendorShown = vendor ? vendorView(vendor) : null;
  const recipients = vendor && !vendor.archived ? recipientsFor(vendorView(vendor), notificationEmails) : null;
  const shipTo = readShipTo(row.shipTo);
  const notes = row.notes ?? null;
  const contentVersion = await poContentVersion({
    updatedAt: row.updatedAt ?? null,
    vendor: vendorShown,
    recipients,
    lines,
    shipTo,
    notes,
    currency: row.currency,
  });
  return {
    id: row.id,
    orderId: row.orderId,
    number: isMintedPoNumber(row.poNumber) ? row.poNumber : null,
    state: leased ? "sending" : row.status,
    interrupted: row.sendStartedAt !== null && !leased,
    vendor: vendorShown,
    lines,
    shipTo,
    notes,
    currency: row.currency,
    subtotal: subtotal === null || lines.length === 0 ? null : centsToDecimal(subtotal),
    lastError: row.lastError ?? null,
    sentAt: row.sentAt ?? null,
    sentTo: readRecipients(row.sentTo),
    sendCount: row.sendCount,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt ?? null,
    pdfUrl: row.pdfKey ? `/api/pos/${encodeURIComponent(row.id)}/pdf` : null,
    recipients,
    contentVersion,
  };
}

export async function notificationEmailsOf(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ emails: workspaceSettings.notificationEmails })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const list = rows[0]?.emails;
  return Array.isArray(list) ? list.filter((email): email is string => typeof email === "string") : [];
}

export async function poPrefixOf(db: Db, workspaceId: string): Promise<string> {
  return (await poSettingsOf(db, workspaceId)).prefix;
}

// The PO prefix and the From name (Settings > Workspace email: "the sender
// name for purchase order email").
export async function poSettingsOf(db: Db, workspaceId: string): Promise<{ prefix: string; fromName: string | null }> {
  const rows = await db
    .select({ prefix: workspaceSettings.poPrefix, fromName: workspaceSettings.fromName })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return { prefix: rows[0]?.prefix ?? "PO", fromName: rows[0]?.fromName ?? null };
}

async function vendorsById(db: Db, workspaceId: string, ids: string[]): Promise<Map<string, VendorRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .select()
    .from(vendors)
    .where(and(eq(vendors.workspaceId, workspaceId), inArray(vendors.id, unique)));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function loadPoRow(db: Db, workspaceId: string, poId: string): Promise<PoRow | undefined> {
  const rows = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.workspaceId, workspaceId)))
    .limit(1);
  return rows[0];
}

// The PO's row and how it reads, from one read of the row, its vendor and
// the workspace notification list.
export async function loadPoState(db: Db, workspaceId: string, poId: string, now: number): Promise<{ row: PoRow; view: PoView } | null> {
  const row = await loadPoRow(db, workspaceId, poId);
  if (!row) {
    return null;
  }
  const [vendorMap, emails] = await Promise.all([vendorsById(db, workspaceId, [row.vendorId]), notificationEmailsOf(db, workspaceId)]);
  return { row, view: await poView(row, vendorMap.get(row.vendorId), emails, now) };
}

export async function loadPoView(db: Db, workspaceId: string, poId: string, now: number): Promise<PoView | null> {
  return (await loadPoState(db, workspaceId, poId, now))?.view ?? null;
}

// An order's purchase orders, newest first. null when the order is not in
// the workspace.
export async function listOrderPurchaseOrders(
  db: Db,
  input: { workspaceId: string; orderId: string; now: number },
): Promise<PoView[] | null> {
  const order = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.workspaceId, input.workspaceId)))
    .limit(1);
  if (order.length === 0) {
    return null;
  }
  const rows = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.workspaceId, input.workspaceId), eq(purchaseOrders.orderId, input.orderId)))
    .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id));
  const [vendorMap, emails] = await Promise.all([
    vendorsById(db, input.workspaceId, rows.map((row) => row.vendorId)),
    notificationEmailsOf(db, input.workspaceId),
  ]);
  return Promise.all(rows.map((row) => poView(row, vendorMap.get(row.vendorId), emails, input.now)));
}

// The stored PDF of a PO in this workspace, for the PDF route: only a key
// under this PO's own pos/<workspaceId>/<poId>- prefix is ever read. null
// when there is none.
export async function openPoPdf(
  db: Db,
  bucket: Pick<R2Bucket, "get">,
  workspaceId: string,
  poId: string,
): Promise<{ body: ReadableStream; size: number; filename: string } | null> {
  const row = await loadPoRow(db, workspaceId, poId);
  if (!row?.pdfKey || !isPoPdfKeyFor(row.pdfKey, workspaceId, poId)) {
    return null;
  }
  const object = await bucket.get(row.pdfKey);
  if (!object) {
    return null;
  }
  return {
    body: object.body,
    size: object.size,
    filename: isMintedPoNumber(row.poNumber) ? `${row.poNumber}.pdf` : "purchase-order.pdf",
  };
}

// ---- Input ---------------------------------------------------------------

function parseLines(value: unknown): PoLine[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > PO_LINES_MAX) {
    return `A purchase order needs 1 to ${PO_LINES_MAX} lines`;
  }
  const lines: PoLine[] = [];
  for (const [index, raw] of value.entries()) {
    const n = index + 1;
    if (!isRecord(raw)) {
      return `Line ${n} is not readable`;
    }
    const description = typeof raw.description === "string" ? oneLine(raw.description) : "";
    if (description.length === 0 || description.length > PO_DESCRIPTION_MAX) {
      return `Line ${n}: add a description of up to ${PO_DESCRIPTION_MAX} characters`;
    }
    if (raw.sku !== undefined && raw.sku !== null && typeof raw.sku !== "string") {
      return `Line ${n}: the SKU must be text`;
    }
    const sku = typeof raw.sku === "string" ? oneLine(raw.sku) : "";
    if (sku.length > PO_SKU_MAX) {
      return `Line ${n}: the SKU must be ${PO_SKU_MAX} characters or fewer`;
    }
    const quantity = raw.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > PO_QUANTITY_MAX) {
      return `Line ${n}: the quantity must be a whole number from 1 to ${PO_QUANTITY_MAX.toLocaleString("en-US")}`;
    }
    let unitCost: string | null = null;
    if (raw.unitCost !== undefined && raw.unitCost !== null && raw.unitCost !== "") {
      const cents = typeof raw.unitCost === "string" ? costToCents(raw.unitCost.trim()) : null;
      if (cents === null) {
        return `Line ${n}: the unit cost must be an amount like 12.50`;
      }
      unitCost = centsToDecimal(cents);
    }
    lines.push({ description, sku, quantity, unitCost });
  }
  return lines;
}

function parseShipTo(value: unknown): string[] | string {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) {
    return "Ship to takes lines of text";
  }
  const lines = (value as string[]).map(oneLine).filter((line) => line.length > 0);
  if (lines.length > PO_SHIP_TO_LINES_MAX || lines.some((line) => line.length > PO_SHIP_TO_LINE_MAX)) {
    return `Ship to takes up to ${PO_SHIP_TO_LINES_MAX} lines of up to ${PO_SHIP_TO_LINE_MAX} characters`;
  }
  return lines;
}

function parseNotes(value: unknown): string | null | { error: string } {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return { error: "Notes must be text" };
  }
  const notes = value.replace(/\r\n?/g, "\n").replace(CONTROL_KEEP_NEWLINE, " ").trim();
  if (notes.length > PO_NOTES_MAX) {
    return { error: `Notes must be ${PO_NOTES_MAX.toLocaleString("en-US")} characters or fewer` };
  }
  return notes.length > 0 ? notes : null;
}

export function parsePoDraft(body: unknown): PoDraftInput | string {
  if (!isRecord(body)) {
    return "Send the purchase order as a JSON object";
  }
  if (typeof body.vendorId !== "string" || !ID.test(body.vendorId)) {
    return "Pick a vendor";
  }
  const lines = parseLines(body.lines);
  if (typeof lines === "string") {
    return lines;
  }
  const shipTo = parseShipTo(body.shipTo);
  if (typeof shipTo === "string") {
    return shipTo;
  }
  const notes = parseNotes(body.notes);
  if (notes !== null && typeof notes === "object") {
    return notes.error;
  }
  return { vendorId: body.vendorId, lines, shipTo, notes };
}

async function activeVendor(db: Db, workspaceId: string, vendorId: string): Promise<VendorRow | undefined> {
  const rows = await db
    .select()
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.workspaceId, workspaceId), eq(vendors.archived, false)))
    .limit(1);
  return rows[0];
}

const NO_VENDOR = "That vendor is not in this workspace's vendor list. Pick another, or add it.";

function currencyOf(snapshot: unknown): string {
  const currency = isRecord(snapshot) && typeof snapshot.currency === "string" ? snapshot.currency.toUpperCase() : "";
  return CURRENCY.test(currency) ? currency : "USD";
}

// ---- Writing -------------------------------------------------------------

// Purchase orders are only for order cards (decision D11): a request has
// no Shopify order to buy for yet.
export const PO_NEEDS_ORDER = "Approve the request first. A purchase order needs the Shopify order.";

export type CreatePoResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  // The card is still a request (draft orders spec section 13): 409.
  | { kind: "draft"; error: string }
  | { kind: "created"; po: PoView; event: EventView };

// A new draft for the order, with a po_draft event in the same batch. The
// number comes at the first send attempt; the currency is the order's.
export async function createPurchaseOrder(
  db: Db,
  ctx: { workspaceId: string; orderId: string; userId: string; now: number },
  body: unknown,
): Promise<CreatePoResult> {
  const input = parsePoDraft(body);
  if (typeof input === "string") {
    return { kind: "invalid", error: input };
  }
  const [orderRows, vendor] = await Promise.all([
    db
      .select({ id: orders.id, shopify: orders.shopify, shopifyOrderId: orders.shopifyOrderId })
      .from(orders)
      .where(and(eq(orders.id, ctx.orderId), eq(orders.workspaceId, ctx.workspaceId)))
      .limit(1),
    activeVendor(db, ctx.workspaceId, input.vendorId),
  ]);
  const order = orderRows[0];
  if (!order) {
    return { kind: "not-found" };
  }
  if (order.shopifyOrderId === null) {
    return { kind: "draft", error: PO_NEEDS_ORDER };
  }
  if (!vendor) {
    return { kind: "invalid", error: NO_VENDOR };
  }
  const id = crypto.randomUUID();
  const row = {
    id,
    workspaceId: ctx.workspaceId,
    orderId: order.id,
    vendorId: vendor.id,
    poNumber: draftPoNumber(id),
    lineItems: input.lines,
    shipTo: input.shipTo,
    notes: input.notes,
    status: "draft" as const,
    createdBy: ctx.userId,
    createdAt: ctx.now,
    currency: currencyOf(order.shopify),
    updatedAt: ctx.now,
  };
  const event = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: order.id,
    type: "po_draft" as const,
    text: `Purchase order drafted for ${vendor.name}`,
    actorId: ctx.userId,
    meta: { poId: id },
    createdAt: ctx.now,
    source: "app" as const,
  };
  await applyBatch(db, [db.insert(purchaseOrders).values(row), db.insert(events).values(event)]);
  const view = await loadPoView(db, ctx.workspaceId, id, ctx.now);
  if (!view) {
    return { kind: "not-found" };
  }
  return { kind: "created", po: view, event: eventView(event) };
}

export type UpdatePoResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "conflict"; error: string; po: PoView }
  | { kind: "updated"; po: PoView };

// Replaces a draft's (or failed PO's) vendor, lines, ship-to and notes,
// only while no send attempt holds it.
export async function updatePurchaseOrder(
  db: Db,
  ctx: { workspaceId: string; poId: string; now: number },
  body: unknown,
): Promise<UpdatePoResult> {
  const input = parsePoDraft(body);
  if (typeof input === "string") {
    return { kind: "invalid", error: input };
  }
  const existing = await loadPoRow(db, ctx.workspaceId, ctx.poId);
  if (!existing) {
    return { kind: "not-found" };
  }
  const vendor = await activeVendor(db, ctx.workspaceId, input.vendorId);
  if (!vendor) {
    return { kind: "invalid", error: NO_VENDOR };
  }
  const updated = await db
    .update(purchaseOrders)
    .set({ vendorId: vendor.id, lineItems: input.lines, shipTo: input.shipTo, notes: input.notes, updatedAt: ctx.now })
    .where(
      and(
        eq(purchaseOrders.id, ctx.poId),
        eq(purchaseOrders.workspaceId, ctx.workspaceId),
        inArray(purchaseOrders.status, ["draft", "failed"]),
        leaseFree(ctx.now),
      ),
    )
    .returning({ id: purchaseOrders.id });
  const view = await loadPoView(db, ctx.workspaceId, ctx.poId, ctx.now);
  if (!view) {
    return { kind: "not-found" };
  }
  if (updated.length === 0) {
    return {
      kind: "conflict",
      error:
        view.state === "sending"
          ? "This purchase order is being sent right now, so it cannot be changed."
          : "This purchase order was sent, so it can no longer be changed.",
      po: view,
    };
  }
  return { kind: "updated", po: view };
}
