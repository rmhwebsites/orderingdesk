// Response shapes shared by the desk services and API routes. Phase 5 builds
// the desk UI against these, so change them deliberately.

import type { events, ShopifyLinkValue, statuses, workspaceSettings } from "@/db/schema";
import { DEFAULT_TIME_ZONE, isTimeZone } from "@/lib/date-range";

export type StatusView = {
  key: string;
  label: string;
  color: string;
  sort: number;
  triggersPo: boolean;
  // The Shopify state this status mirrors (platform amendment section 4),
  // or the draft order outcome it receives (draft orders spec section 8),
  // or null.
  shopifyLink: ShopifyLinkValue | null;
  // Finished work: cards in it leave the Open view (migration 0011).
  closed: boolean;
};

export type EventView = {
  id: string;
  orderId: string | null;
  type: (typeof events.$inferSelect)["type"];
  text: string;
  actorId: string | null;
  meta: unknown;
  createdAt: number;
  // Where the change came from: a person in the app, Shopify, or the system.
  source: (typeof events.$inferSelect)["source"];
  // The person who did it, as their name, else their email; null when
  // nobody (or nobody who still has an account) did it. Set where the
  // server reads it with the event (the timeline read, Approve and
  // Reject), so a platform admin who is not a member of the workspace is
  // named instead of reading as a former member. Absent elsewhere: the
  // drawer then names workspace members from its member list.
  actorName?: string | null;
};

// The name an event's actor goes by (see EventView.actorName).
export function personName(name: string | null | undefined, email: string | null | undefined): string | null {
  return name?.trim() || email || null;
}

export type SettingsView = {
  notificationEmails: string[];
  poPrefix: string;
  replyTo: string | null;
  fromName: string | null;
  // Search (Settings > Search): the zone search dates follow, and whether
  // questions go to AI search.
  timeZone: string;
  aiSearch: boolean;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function statusView(row: typeof statuses.$inferSelect): StatusView {
  return {
    key: row.key,
    label: row.label,
    color: row.color,
    sort: row.sort,
    triggersPo: row.triggersPo,
    shopifyLink: row.shopifyLink ?? null,
    closed: row.closed,
  };
}

export function eventView(row: typeof events.$inferSelect): EventView {
  return {
    id: row.id,
    orderId: row.orderId,
    type: row.type,
    text: row.text,
    actorId: row.actorId,
    meta: row.meta ?? null,
    createdAt: row.createdAt,
    source: row.source,
  };
}

// Every workspace gets a settings row at creation; the defaults (the column
// defaults) only cover a row that is missing anyway.
export function settingsView(row: typeof workspaceSettings.$inferSelect | undefined): SettingsView {
  return {
    notificationEmails: Array.isArray(row?.notificationEmails) ? row.notificationEmails : [],
    poPrefix: row?.poPrefix ?? "PO",
    replyTo: row?.replyTo ?? null,
    fromName: row?.fromName ?? null,
    timeZone: row && isTimeZone(row.timeZone) ? row.timeZone : DEFAULT_TIME_ZONE,
    aiSearch: row ? Boolean(row.aiSearch) : true,
  };
}
