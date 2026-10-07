// Who wrote a timeline entry, and through which AI app (src/lib/via.ts).
// Moved out of the drawer so it is testable without rendering it.

import { APP_NAME } from "@/lib/brand";
import { viaLabel } from "@/lib/via";
import type { EventView } from "@/server/desk/shapes";
import type { MemberView } from "./order-drawer";

function actorName(event: EventView, members: Map<string, MemberView>, selfUserId: string): string {
  if (!event.actorId) {
    return event.source === "shopify" || event.type === "order_new" ? "Shopify" : APP_NAME;
  }
  if (event.actorId === selfUserId) {
    return "You";
  }
  const member = members.get(event.actorId);
  if (member) {
    return member.name?.trim() || member.email || "Team member";
  }
  // Not a member: a platform admin from outside the workspace (who may
  // approve and reject), named by the server; else someone who left.
  return event.actorName?.trim() || "Former member";
}

export function timelineActor(
  event: EventView,
  members: Map<string, MemberView>,
  selfUserId: string,
): { name: string; via: string | null } {
  return { name: actorName(event, members, selfUserId), via: viaLabel(event) };
}
