// The request fields of a card (draft orders spec section 11.1 and section
// 18): the company and location of a B2B draft, and the cart attributes a
// storefront sets at checkout. Pure and defensive like the other snapshot
// readers; shared by the server (desk summaries, notification emails) and
// the drawer. Relative imports only (the cron bundle reaches this through
// src/server/notify.ts).
//
// - Public attributes: keys starting with an underscore are an app's own
//   data and stay hidden; empty values are left out (never an empty
//   placeholder). IMPACT's four request keys come first, in this order,
//   when present; every other attribute follows in Shopify's order.
// - A card reads its current snapshot first, then the draft snapshot an
//   order card keeps (whether cart attributes carry over to the order is
//   not known), so a request's fields survive its approval.

export type RequestAttribute = { key: string; value: string };

// The two fields a card shows in its headline line.
export const HEADLINE_ATTRIBUTES = [
  { field: "requestFor", match: /^for employee name$/i },
  { field: "branch", match: /^ship to branch$/i },
] as const;

const LEADING_ATTRIBUTES = [/^ship to branch$/i, /^for employee name$/i, /^reason for request$/i, /^internal notes$/i];

export type RequestFields = {
  company: string;
  location: string;
  // "For Employee Name"
  requestFor: string;
  // "Ship to Branch", else the location.
  branch: string;
  attributes: RequestAttribute[];
};

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function leadingRank(key: string): number {
  const rank = LEADING_ATTRIBUTES.findIndex((pattern) => pattern.test(key.trim()));
  return rank === -1 ? LEADING_ATTRIBUTES.length : rank;
}

// The attributes a person may see, request keys first (see the header).
export function publicAttributes(raw: unknown): RequestAttribute[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const list = raw
    .filter(isDict)
    .map((entry) => ({ key: str(entry.key), value: str(entry.value) }))
    .filter((entry) => entry.key.trim().length > 0 && !entry.key.startsWith("_") && entry.value.trim().length > 0);
  // A stable sort keeps Shopify's order within each rank.
  return list
    .map((entry, index) => ({ entry, index, rank: leadingRank(entry.key) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry }) => entry);
}

function headline(field: (typeof HEADLINE_ATTRIBUTES)[number]["field"], lists: RequestAttribute[][]): string {
  const pattern = HEADLINE_ATTRIBUTES.find((entry) => entry.field === field)!.match;
  for (const list of lists) {
    const found = list.find((entry) => pattern.test(entry.key.trim()));
    if (found) {
      return found.value.trim();
    }
  }
  return "";
}

export function requestFieldsOf(current: unknown, draftSnapshot: unknown): RequestFields {
  const now = isDict(current) ? current : {};
  const draft = isDict(draftSnapshot) ? draftSnapshot : {};
  const own = publicAttributes(now.attributes);
  const kept = publicAttributes(draft.attributes);
  const company = str(now.company) || str(draft.company);
  const location = str(now.location) || str(draft.location);
  return {
    company,
    location,
    requestFor: headline("requestFor", [own, kept]),
    branch: headline("branch", [own, kept]) || location,
    attributes: own.length > 0 ? own : kept,
  };
}
