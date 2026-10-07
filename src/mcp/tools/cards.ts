// Cards as the MCP tools show them (Wave 2 plan, Decision 13): one plain
// line per card from the desk's own summary, statuses by name, what the
// caller may do next, and the label test that hides contact details in
// personalization. Relative imports only.

import { and, asc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { orders, statuses } from "../../db/schema";
import { normalizeOrderNumber } from "../../lib/desk-query";
import { roleAtLeast } from "../../lib/roles";
import type { OrderSummary } from "../../server/desk/read";
import { iso, NAME_MAX, personLabel, plainText } from "../output";
import type { Principal } from "../types";

export type CardRow = typeof orders.$inferSelect;
export type StatusRow = typeof statuses.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
// Item titles on a card's line, like the desk's preview.
const ITEMS_SHOWN = 3;
const CONTACT_LABEL = /phone|mobile|cell|fax|e-?mail/i;
export const HIDDEN_CONTACT = "[hidden here: see Ordering Desk]";

export function isContactLabel(label: string): boolean {
  return CONTACT_LABEL.test(label);
}

// By id, order number (#1024) or request number (#D19), in this workspace.
export async function findCard(db: Db, workspaceId: string, ref: string): Promise<CardRow | null> {
  const text = ref.trim();
  const number = normalizeOrderNumber(text);
  const match = number
    ? or(eq(orders.id, text), sql`lower(${orders.name}) = ${number}`, sql`lower(coalesce(${orders.draftName}, '')) = ${number}`)
    : eq(orders.id, text);
  const rows = await db.select().from(orders).where(and(eq(orders.workspaceId, workspaceId), match)).limit(3);
  return rows.find((row) => row.id === text) ?? rows.find((row) => row.name.toLowerCase() === number) ?? rows[0] ?? null;
}

export async function statusRowsOf(db: Db, workspaceId: string): Promise<StatusRow[]> {
  return db.select().from(statuses).where(eq(statuses.workspaceId, workspaceId)).orderBy(asc(statuses.sort), asc(statuses.key));
}

export function waitingDays(card: { statusSetAt: number | null; createdAt: number }, now: number): number {
  return Math.max(0, Math.floor((now - (card.statusSetAt ?? card.createdAt)) / DAY_MS));
}

export function cardLine(
  summary: OrderSummary,
  statusByKey: ReadonlyMap<string, Pick<StatusRow, "label" | "closed">>,
  now: number,
): Record<string, unknown> {
  const status = statusByKey.get(summary.statusKey);
  return {
    id: summary.id,
    number: summary.name,
    from_request: summary.kind === "order" ? summary.draftName : null,
    kind: summary.kind === "draft" ? "request" : "order",
    status: plainText(status?.label ?? summary.statusKey, 80),
    closed: status?.closed ?? false,
    waiting_days: waitingDays(summary, now),
    placed: iso(summary.createdAt),
    // Shopify's customer name can be the email or phone (personLabel).
    requester: personLabel(summary.customerName),
    for_person: personLabel(summary.requestFor),
    location: plainText(summary.locationName || summary.branch || summary.location, NAME_MAX) || null,
    items: summary.itemTitles.slice(0, ITEMS_SHOWN).map((title) => plainText(title, 120)),
    item_count: summary.itemCount,
    deleted_in_shopify: summary.draftDeleted,
  };
}

// The prepare tools the caller can use on this card right now.
export function actionsFor(p: Principal, card: CardRow, canWrite: boolean): string[] {
  if (!canWrite) {
    return [];
  }
  const manager = roleAtLeast(p.role, "manager");
  const isDraft = card.shopifyOrderId === null;
  const list = ["prepare_status_change", "prepare_add_note"];
  if (manager && isDraft && card.draftDeletedAt === null) {
    list.push("prepare_approve", "prepare_edit_request");
  }
  if (manager && isDraft) {
    list.push("prepare_reject");
  }
  if (manager && !isDraft) {
    list.push("prepare_cancel");
  }
  return list;
}

export async function loadCardById(db: Db, workspaceId: string, id: string | null): Promise<CardRow | null> {
  if (!id) {
    return null;
  }
  const rows = await db.select().from(orders).where(and(eq(orders.workspaceId, workspaceId), eq(orders.id, id))).limit(1);
  return rows[0] ?? null;
}
