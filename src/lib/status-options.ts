// The statuses a card's status control offers (draft orders spec section
// 11.5 with section 18 item 5). The server enforces the same rules in
// changeOrderStatus (src/server/desk/mutations.ts); this only keeps choices
// it would refuse out of the list.
//
// - A request (draft card) moves between statuses with no Shopify link;
//   Approve and Reject put it in the linked ones. Its current status is
//   always listed. A rejected request is locked for staff: only a manager
//   or platform admin reopens it.
// - An order takes every status except the one linked to draft_rejected
//   (unless it is already there).
// - The cancelled status is never offered (Cancel order sets it); a
//   cancelled order is locked for staff and moves only to statuses with no
//   Shopify link.

import type { StatusView } from "../server/desk/shapes";
import { roleAtLeast, type Role } from "./roles";

export type StatusOptions = { options: StatusView[]; disabled: boolean; hint: string | null };

export function statusOptionsFor(input: {
  kind: "draft" | "order";
  role: Role;
  currentKey: string;
  statuses: StatusView[];
}): StatusOptions {
  const { kind, role, currentKey, statuses } = input;
  const current = statuses.find((status) => status.key === currentKey);
  if (kind === "draft") {
    const locked = current?.shopifyLink === "draft_rejected" && !roleAtLeast(role, "manager");
    return {
      options: statuses.filter((status) => status.shopifyLink === null || status.key === currentKey),
      disabled: locked,
      hint: locked ? "Only a manager can reopen a rejected request." : null,
    };
  }
  if (current?.shopifyLink === "cancelled") {
    const locked = !roleAtLeast(role, "manager");
    return {
      options: statuses.filter((status) => status.shopifyLink === null || status.key === currentKey),
      disabled: locked,
      hint: locked ? "Only a manager can move a cancelled order." : null,
    };
  }
  return {
    options: statuses.filter(
      (status) => (status.shopifyLink !== "draft_rejected" && status.shopifyLink !== "cancelled") || status.key === currentKey,
    ),
    disabled: false,
    hint: null,
  };
}
