// What the bell shows, as pure functions (src/components/shell/bell.tsx):
// the badge text, who did something, where an item links, and which new
// items become a live toast.

import type { ActivityItem } from "@/server/activity";
import { APP_NAME } from "./brand";
import { viaLabel } from "./via";

const TOAST_TYPES = new Set<ActivityItem["type"]>(["status", "note", "po_sent"]);
const MAX_TOASTS = 3;
const NOTE_PREVIEW = 100;

export function unreadBadge(count: number | null): string | null {
  if (count === null || count <= 0) {
    return null;
  }
  return count > 99 ? "99+" : String(count);
}

export function actorLabel(item: ActivityItem): string {
  const base = item.mine
    ? "You"
    : item.actorId
      ? (item.actorName ?? "Former member")
      : item.source === "shopify" || item.type === "order_new"
        ? "Shopify"
        : APP_NAME;
  const via = viaLabel(item);
  return via ? `${base} ${via}` : base;
}

// The order in the desk, which opens its drawer from ?order=.
export function orderHref(basePath: string, orderId: string): string {
  return `${basePath === "" ? "/" : basePath}?order=${encodeURIComponent(orderId)}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

export type ActivityToast = { title: string; body?: string; tone: "info" };

// Items that arrived since the last load (known: the ids loaded before;
// null on the first load, which announces nothing): status changes,
// notes and sent purchase orders by someone else. New orders are left to
// the desk, which announces them itself.
export function activityToasts(known: ReadonlySet<string> | null, items: ActivityItem[]): ActivityToast[] {
  if (!known) {
    return [];
  }
  return items
    .filter((item) => !known.has(item.id) && !item.mine && TOAST_TYPES.has(item.type))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_TOASTS)
    .map((item) => {
      const order = item.orderName ?? "An order";
      if (item.type === "note") {
        return { title: `Note on ${order}`, body: `${actorLabel(item)}: ${clip(item.text, NOTE_PREVIEW)}`, tone: "info" };
      }
      const by = actorLabel(item);
      return { title: `${order}: ${clip(item.text, 80)}`, body: by === "Shopify" ? "From Shopify" : `By ${by}`, tone: "info" };
    });
}
