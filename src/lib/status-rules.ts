// The status rules every change obeys (draft orders spec section 8.2 with
// section 18 item 5; bulk moves from the comprehensive desk design section
// 1), in one place: one change and a bulk move on the server
// (src/server/desk/mutations.ts), and the bulk confirmation on the desk,
// which says which cards will stay before anything is sent. The server
// checks every card again.

import type { StatusView } from "../server/desk/shapes";
import { roleAtLeast, type Role } from "./roles";

// A bulk move takes at most this many cards: after the response the moved
// cards' statuses are written to Shopify four cards at a time, within the
// time a Worker has after its response (the bulk status route).
export const BULK_STATUS_MAX = 25;

type RuleStatus = { label: string; shopifyLink: string | null };

export type MoveCheck = { ok: true } | { ok: false; forbidden: boolean; error: string };

// - A request moves freely between statuses with no Shopify link, staff
//   included; never into a status linked to fulfilled or delivered (it is
//   not an order yet), nor to draft_completed or draft_rejected (Approve and
//   Reject do that, with their own checks and the reason).
// - Out of the draft_rejected status only for a manager or platform admin
//   (forbidden: the single change answers 403, as before).
// - An order never moves into the draft_rejected status.
export function checkStatusMove(input: {
  isDraft: boolean;
  role: Role;
  current: RuleStatus | undefined;
  target: RuleStatus;
}): MoveCheck {
  const { isDraft, role, current, target } = input;
  if (isDraft) {
    if (current?.shopifyLink === "draft_rejected" && !roleAtLeast(role, "manager")) {
      return { ok: false, forbidden: true, error: "Only a manager can reopen a rejected request." };
    }
    switch (target.shopifyLink) {
      case "fulfilled":
      case "delivered":
        return {
          ok: false,
          forbidden: false,
          error: `A draft cannot be marked ${target.label} until it is approved and becomes an order.`,
        };
      case "draft_completed":
        return { ok: false, forbidden: false, error: "Use Approve to approve this request. It creates the order in Shopify." };
      case "draft_rejected":
        return { ok: false, forbidden: false, error: "Use Reject to reject this request. It asks for a reason." };
      default:
        return { ok: true };
    }
  }
  if (target.shopifyLink === "draft_rejected") {
    return { ok: false, forbidden: false, error: "Rejected is for requests that are still drafts." };
  }
  return { ok: true };
}

export type BulkCard = { id: string; name: string; customerName: string; kind: "draft" | "order"; statusKey: string };
export type BulkPlanRow = { card: BulkCard; stays: string | null };

// Each selected card and, when it will not move, why: already there, or
// the rule that keeps it.
export function planBulkMove(cards: BulkCard[], target: StatusView, statuses: StatusView[], role: Role): BulkPlanRow[] {
  return cards.map((card) => {
    if (card.statusKey === target.key) {
      return { card, stays: `Already in ${target.label}.` };
    }
    const check = checkStatusMove({
      isDraft: card.kind === "draft",
      role,
      current: statuses.find((status) => status.key === card.statusKey),
      target,
    });
    return { card, stays: check.ok ? null : check.error };
  });
}
