// The desk's filters as URL parameters (comprehensive desk design section
// 1): view, status, kind, q and sort, so push and email links open the
// exact view. Pure and shared: the orders API reads the view with it (the
// server owns the default: Open), and the desk reads and writes its address
// with it. Unknown values fall back to the defaults.

export const DESK_VIEWS = ["open", "approval", "all", "closed"] as const;
export type DeskView = (typeof DESK_VIEWS)[number];

export const DESK_SORTS = ["newest", "oldest", "waiting"] as const;
export type SortKey = (typeof DESK_SORTS)[number];

// All: every card except requests whose draft Shopify deleted (they have
// their own filter, Deleted).
export const DESK_KINDS = ["all", "drafts", "orders", "deleted"] as const;
export type DeskKind = (typeof DESK_KINDS)[number];

// Cards per view over every card (the server counts them).
export type ViewCounts = { open: number; approval: number; all: number; closed: number };

export type DeskQuery = { view: DeskView; status: string | null; kind: DeskKind; q: string; sort: SortKey };

export const DESK_QUERY_MAX = 200;
const STATUS_KEY = /^[a-z0-9_]{1,64}$/;

type ParamSource = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function read(source: ParamSource, name: string): string | null {
  if (typeof (source as { get?: unknown }).get === "function") {
    return (source as { get(name: string): string | null }).get(name);
  }
  const value = (source as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

// Waiting longest first in the approval queue; newest first elsewhere.
export function defaultSort(view: DeskView): SortKey {
  return view === "approval" ? "waiting" : "newest";
}

export function parseDeskQuery(source: ParamSource): DeskQuery {
  const view = oneOf(read(source, "view"), DESK_VIEWS) ?? "open";
  const status = read(source, "status");
  return {
    view,
    status: status !== null && STATUS_KEY.test(status) ? status : null,
    kind: oneOf(read(source, "kind"), DESK_KINDS) ?? "all",
    q: (read(source, "q") ?? "").slice(0, DESK_QUERY_MAX),
    sort: oneOf(read(source, "sort"), DESK_SORTS) ?? defaultSort(view),
  };
}

// The address's query string for a desk query: defaults left out (the plain
// desk is just its path), the open order kept.
export function deskSearch(query: DeskQuery, order: string | null = null): string {
  const params = new URLSearchParams();
  if (query.view !== "open") {
    params.set("view", query.view);
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (query.kind !== "all") {
    params.set("kind", query.kind);
  }
  if (query.q.trim().length > 0) {
    params.set("q", query.q);
  }
  if (query.sort !== defaultSort(query.view)) {
    params.set("sort", query.sort);
  }
  if (order) {
    params.set("order", order);
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}

// The address's query string after a filter change: the current query with
// patch applied, the open order kept. A sort left at its view's default
// follows the view (the approval queue waits longest first).
export function mergeDeskSearch(currentSearch: string, patch: Partial<DeskQuery>): string {
  const params = new URLSearchParams(currentSearch);
  const current = parseDeskQuery(params);
  const next: DeskQuery = { ...current, ...patch };
  if (patch.view !== undefined && patch.sort === undefined && current.sort === defaultSort(current.view)) {
    next.sort = defaultSort(patch.view);
  }
  return deskSearch(next, params.get("order"));
}
