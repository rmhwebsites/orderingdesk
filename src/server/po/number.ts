// Purchase order numbers: <prefix>-<YYYY>-<NNNN> (IMP-2026-0041), the
// prefix from workspace settings, sequential per workspace, prefix and
// calendar year (UTC), four digits and more past 9999.
//
// A PO gets its number at its first send attempt, so abandoned drafts never
// leave gaps; until then its po_number holds a placeholder, "draft:<id>",
// which keeps the column NOT NULL and unique and can never look like a
// minted number (prefixes are uppercase letters and digits, never a colon).
//
// Race safety on D1: the next number is read (the highest of this
// workspace, prefix and year, plus one) and written only while the PO still
// holds its placeholder. Two mints that read the same highest number both
// try to write it; the (workspace_id, po_number) unique index refuses the
// second, which reads again and tries the next number, at most
// PO_NUMBER_ATTEMPTS times.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { purchaseOrders } from "@/db/schema";

export const PO_NUMBER_ATTEMPTS = 5;

const DRAFT_PREFIX = "draft:";
const MINTED = /^[A-Z0-9]{1,8}-\d{4}-\d{4,}$/;

export class PoNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoNumberError";
  }
}

export function draftPoNumber(poId: string): string {
  return DRAFT_PREFIX + poId;
}

export function isMintedPoNumber(value: string): boolean {
  return MINTED.test(value);
}

function yearOf(now: number): number {
  return new Date(now).getUTCFullYear();
}

function formatNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${year}-${String(sequence).padStart(4, "0")}`;
}

// The highest sequence already used by this workspace for prefix and year
// (0 when none). GLOB is case-sensitive and matches only digits after the
// head, so placeholders and other prefixes never count.
async function highestSequence(db: Db, workspaceId: string, prefix: string, year: number): Promise<number> {
  const head = `${prefix}-${year}-`;
  const rows = await db
    .select({ top: sql<number | null>`max(cast(substr(${purchaseOrders.poNumber}, ${head.length + 1}) as integer))` })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.workspaceId, workspaceId), sql`${purchaseOrders.poNumber} glob ${head + "[0-9]*"}`));
  const top = rows[0]?.top;
  return typeof top === "number" && Number.isFinite(top) ? top : 0;
}

// The number the next mint for this workspace would take now. Nothing is
// reserved: another send can take it first (the review modal says so).
export async function previewPoNumber(db: Db, workspaceId: string, prefix: string, now: number): Promise<string> {
  const year = yearOf(now);
  return formatNumber(prefix, year, (await highestSequence(db, workspaceId, prefix, year)) + 1);
}

function isUniqueViolation(e: unknown): boolean {
  for (let current: unknown = e, depth = 0; current && depth < 5; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    const code = (current as { code?: unknown }).code;
    if (message.includes("UNIQUE constraint failed") || code === "SQLITE_CONSTRAINT_UNIQUE") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function currentNumber(db: Db, workspaceId: string, poId: string): Promise<string | null> {
  const rows = await db
    .select({ poNumber: purchaseOrders.poNumber })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.workspaceId, workspaceId)))
    .limit(1);
  return rows[0]?.poNumber ?? null;
}

// Mints the PO's number if it still has its placeholder and returns its
// number either way (a retry after a failed send keeps the number the
// first attempt minted). Throws PoNumberError for a PO that is not in the
// workspace, or after PO_NUMBER_ATTEMPTS lost races (the PO stays a draft).
export async function nextPoNumber(
  db: Db,
  input: { workspaceId: string; poId: string; prefix: string; now: number },
): Promise<string> {
  const { workspaceId, poId, prefix, now } = input;
  const year = yearOf(now);
  for (let attempt = 0; attempt < PO_NUMBER_ATTEMPTS; attempt++) {
    const existing = await currentNumber(db, workspaceId, poId);
    if (existing === null) {
      throw new PoNumberError("This purchase order is not in this workspace");
    }
    if (isMintedPoNumber(existing)) {
      return existing;
    }
    const candidate = formatNumber(prefix, year, (await highestSequence(db, workspaceId, prefix, year)) + 1);
    try {
      const rows = await db
        .update(purchaseOrders)
        .set({ poNumber: candidate })
        .where(
          and(
            eq(purchaseOrders.id, poId),
            eq(purchaseOrders.workspaceId, workspaceId),
            eq(purchaseOrders.poNumber, draftPoNumber(poId)),
          ),
        )
        .returning({ poNumber: purchaseOrders.poNumber });
      if (rows.length > 0) {
        return candidate;
      }
      // Another attempt minted this PO meanwhile: the loop reads its number.
    } catch (e) {
      if (!isUniqueViolation(e)) {
        throw e;
      }
      // Another PO took the candidate first: read again and try the next.
    }
  }
  throw new PoNumberError("Could not assign a purchase order number. Try again.");
}
