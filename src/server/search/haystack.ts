// The search text and filter columns of one card (design section 3). Pure,
// shared by the indexer (index-orders.ts) and its tests. Relative imports
// only: the sync engine, which the cron bundles, reaches this module.

import { requestFieldsOf } from "../../lib/request-fields";

export const HAYSTACK_MAX = 8000;
// One value (a long personalization text, a long title) is cut here.
export const HAYSTACK_PART_MAX = 200;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Lowercased, every run of whitespace (line breaks included) one space.
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const LINK = /^https?:\/\//i;

function itemsOf(snapshot: Dict): Dict[] {
  return Array.isArray(snapshot.items) ? snapshot.items.filter(isDict) : [];
}

// Personalization: public line item properties (no leading underscore)
// whose value is not a link (proof PDFs and previews are links).
function personalizationOf(item: Dict): string[] {
  const props = Array.isArray(item.props) ? item.props.filter(isDict) : [];
  return props
    .filter((prop) => {
      const key = str(prop.key);
      const value = str(prop.value).trim();
      return key.length > 0 && !key.startsWith("_") && value.length > 0 && !LINK.test(value);
    })
    .map((prop) => str(prop.value));
}

export type HaystackInput = {
  name: string;
  draftName: string | null;
  // The current snapshot (orders.shopify) and the draft snapshot an order
  // card keeps (orders.draft_snapshot).
  shopify: unknown;
  draftSnapshot: unknown;
  // The card's company location name (Wave 1b's locations table), if any.
  locationName: string | null;
  // Minted purchase order numbers of the card.
  poNumbers: readonly string[];
};

// Every value once, lowercased with single spaces, joined with " | " so a
// phrase never runs across two fields.
export function buildHaystack(input: HaystackInput): string {
  const current = isDict(input.shopify) ? input.shopify : {};
  const draft = isDict(input.draftSnapshot) ? input.draftSnapshot : {};
  const request = requestFieldsOf(input.shopify, input.draftSnapshot);
  const items = itemsOf(current).length > 0 ? itemsOf(current) : itemsOf(draft);
  const parts: string[] = [
    input.name,
    input.draftName ?? "",
    str(current.customerName),
    str(current.email),
    str(draft.customerName),
    str(draft.email),
    request.company,
    request.location,
    request.requestFor,
    request.branch,
    input.locationName ?? "",
    str(current.poNumber),
    str(draft.poNumber),
    ...input.poNumbers,
  ];
  for (const item of items) {
    parts.push(str(item.title), str(item.sku), str(item.variant), ...personalizationOf(item));
  }
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const text = normalizeSearchText(part).slice(0, HAYSTACK_PART_MAX);
    if (text.length > 0 && !seen.has(text)) {
      seen.add(text);
      kept.push(text);
    }
  }
  return kept.join(" | ").slice(0, HAYSTACK_MAX);
}

export type Requester = { customerId: string; name: string; email: string; contactId: string };

// Who asked: the current snapshot first, then the draft an order came from.
export function requesterOf(shopify: unknown, draftSnapshot: unknown): Requester {
  const current = isDict(shopify) ? shopify : {};
  const draft = isDict(draftSnapshot) ? draftSnapshot : {};
  return {
    customerId: str(current.customerId) || str(draft.customerId),
    name: (str(current.customerName) || str(draft.customerName)).trim(),
    email: (str(current.email) || str(draft.email)).trim().toLowerCase(),
    contactId: str(current.contactId) || str(draft.contactId),
  };
}

// The orders columns the index reads.
export type CardRow = {
  id: string;
  workspaceId: string;
  shopifyOrderId: string | null;
  name: string;
  shopify: unknown;
  statusKey: string;
  statusSetAt: number | null;
  createdAt: number;
  draftName: string | null;
  draftSnapshot: unknown;
  locationId: string | null;
};

export type SearchRow = {
  orderId: string;
  workspaceId: string;
  haystack: string;
  kind: "draft" | "order";
  statusKey: string;
  closed: number;
  locationId: string | null;
  requesterId: string | null;
  createdAt: number;
  statusSetAt: number | null;
};

export function searchRowOf(
  card: CardRow,
  ctx: { closed: boolean; locationName: string | null; poNumbers: readonly string[]; requesterId: string | null },
): SearchRow {
  return {
    orderId: card.id,
    workspaceId: card.workspaceId,
    haystack: buildHaystack({
      name: card.name,
      draftName: card.draftName,
      shopify: card.shopify,
      draftSnapshot: card.draftSnapshot,
      locationName: ctx.locationName,
      poNumbers: ctx.poNumbers,
    }),
    kind: card.shopifyOrderId === null ? "draft" : "order",
    statusKey: card.statusKey,
    closed: ctx.closed ? 1 : 0,
    locationId: card.locationId,
    requesterId: ctx.requesterId,
    createdAt: card.createdAt,
    statusSetAt: card.statusSetAt,
  };
}
