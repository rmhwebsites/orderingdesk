// The desk's filters as URL parameters (comprehensive desk design section
// 1): view, status, kind, q and sort, so push and email links open the
// exact view. Pure and shared: the orders API reads the view with it (the
// server owns the default: Open), and the desk reads and writes its address
// with it. Unknown values fall back to the defaults. Wave 1c adds the search
// filters AI search fills in (location, requester, person, item,
// personalization, leftover words, order number, dates, days waiting); they
// are plain URL params too.

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

export const DATE_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "last_7_days",
  "last_30_days",
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const FILTER_TEXT_MAX = 60;
export const LIST_MAX = 20;
export const DAYS_MAX = 365;
// The desk loads one page at a time; a reload keeps what was loaded, up to
// the cap (older cards stay one "Show older cards" press away).
export const DESK_PAGE_SIZE = 200;
export const DESK_PAGE_MAX = 1000;

// Wave 1c's search filters (design section 3).
export type SearchFilters = {
  // Company locations by their Shopify legacy id (orders.location_id).
  locations: string[];
  // A people id: that person's cards.
  requester: string | null;
  // Free text AI search found: a person, an item, personalization.
  person: string;
  item: string;
  pz: string;
  // An AI answer's leftover words (every word must match, like q's), kept
  // inside the view the answer chose. AI search never writes q (listScope).
  words: string;
  // "#1024" or "#d19", lowercased.
  number: string;
  date: DatePreset | null;
  // YYYY-MM-DD, both or neither.
  from: string | null;
  to: string | null;
  // Days in the current status.
  older: number | null;
  newer: number | null;
};

export const SEARCH_DEFAULTS: SearchFilters = {
  locations: [],
  requester: null,
  person: "",
  item: "",
  pz: "",
  words: "",
  number: "",
  date: null,
  from: null,
  to: null,
  older: null,
  newer: null,
};

export type DeskQuery = { view: DeskView; status: string | null; kind: DeskKind; q: string; sort: SortKey } & SearchFilters;

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

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

// Control characters out, every whitespace run one space, trimmed, capped.
export function cleanText(value: string, max: number): string {
  return value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function idList(value: string | null): string[] {
  const out: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const id = part.trim();
    if (ID.test(id) && !out.includes(id)) {
      out.push(id);
    }
    if (out.length >= LIST_MAX) {
      break;
    }
  }
  return out;
}

function days(value: string | null): number | null {
  if (value === null || !/^\d{1,3}$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return n <= DAYS_MAX ? n : null;
}

export function isCalendarDate(value: string): boolean {
  if (!YMD.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// "#1024", "1024", "# D 19" and "d19" become "#1024" and "#d19"; anything
// else is not a number ("").
export function normalizeOrderNumber(value: string): string {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  const match = compact.match(/^#?(d?)(\d{1,10})$/);
  return match ? `#${match[1]}${match[2]}` : "";
}

function searchFiltersOf(source: ParamSource): SearchFilters {
  const from = read(source, "from");
  const to = read(source, "to");
  const range = from !== null && to !== null && isCalendarDate(from) && isCalendarDate(to) && from <= to ? { from, to } : null;
  return {
    locations: idList(read(source, "location")),
    requester: idList(read(source, "requester"))[0] ?? null,
    person: cleanText(read(source, "person") ?? "", FILTER_TEXT_MAX),
    item: cleanText(read(source, "item") ?? "", FILTER_TEXT_MAX),
    pz: cleanText(read(source, "pz") ?? "", FILTER_TEXT_MAX),
    words: cleanText(read(source, "words") ?? "", DESK_QUERY_MAX),
    number: normalizeOrderNumber(read(source, "number") ?? ""),
    date: range ? null : oneOf(read(source, "date"), DATE_PRESETS),
    from: range?.from ?? null,
    to: range?.to ?? null,
    older: days(read(source, "older")),
    newer: days(read(source, "newer")),
  };
}

export function parseDeskQuery(source: ParamSource): DeskQuery {
  const view = oneOf(read(source, "view"), DESK_VIEWS) ?? "open";
  const status = read(source, "status");
  const q = (read(source, "q") ?? "").slice(0, DESK_QUERY_MAX);
  return {
    view,
    status: status !== null && STATUS_KEY.test(status) ? status : null,
    kind: oneOf(read(source, "kind"), DESK_KINDS) ?? "all",
    q,
    sort: oneOf(read(source, "sort"), DESK_SORTS) ?? querySortDefault({ view, q }),
    ...searchFiltersOf(source),
  };
}

// The query's URL params, defaults left out (the plain desk is its path).
export function deskParams(query: DeskQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.view !== "open") params.set("view", query.view);
  if (query.status) params.set("status", query.status);
  if (query.kind !== "all") params.set("kind", query.kind);
  if (query.q.trim().length > 0) params.set("q", query.q);
  if (query.sort !== querySortDefault(query)) params.set("sort", query.sort);
  if (query.locations.length > 0) params.set("location", query.locations.join(","));
  if (query.requester) params.set("requester", query.requester);
  if (query.person) params.set("person", query.person);
  if (query.item) params.set("item", query.item);
  if (query.pz) params.set("pz", query.pz);
  if (query.words) params.set("words", query.words);
  if (query.number) params.set("number", query.number);
  if (query.from && query.to) {
    params.set("from", query.from);
    params.set("to", query.to);
  } else if (query.date) {
    params.set("date", query.date);
  }
  if (query.older !== null) params.set("older", String(query.older));
  if (query.newer !== null) params.set("newer", String(query.newer));
  return params;
}

// The address's query string for a desk query, the open order kept.
export function deskSearch(query: DeskQuery, order: string | null = null): string {
  const params = deskParams(query);
  if (order) {
    params.set("order", order);
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}

// The address's query string after a filter change: the current query with
// patch applied, the open order kept. A sort left at its default follows
// the default (querySortDefault): the approval queue waits longest first, a
// search lists newest first, and clearing the words gives the queue its
// own sort back. (A newest sort picked while searching reads as the
// search's default, so it too goes back to the view's sort.)
export function mergeDeskSearch(currentSearch: string, patch: Partial<DeskQuery>): string {
  const params = new URLSearchParams(currentSearch);
  const current = parseDeskQuery(params);
  const next: DeskQuery = { ...current, ...patch };
  if (patch.sort === undefined && current.sort === querySortDefault(current)) {
    next.sort = querySortDefault(next);
  }
  return deskSearch(next, params.get("order"));
}

// The query with nothing in the URL: Open, newest first, no filter.
export const EMPTY_QUERY: DeskQuery = parseDeskQuery(new URLSearchParams());

// The view a query's list covers: All while plain words search, the picked
// view otherwise (listScope).
function scopeView(query: Pick<DeskQuery, "view" | "q">): DeskView {
  return query.q.trim().length > 0 ? "all" : query.view;
}

// The sort a query has when its address names none: the default of the
// view its list really covers, so a search started from the approval queue
// lists the newest cards of all history first instead of the oldest.
export function querySortDefault(query: Pick<DeskQuery, "view" | "q">): SortKey {
  return defaultSort(scopeView(query));
}

// Which cards a query's list covers, by view and kind. Owner decision
// (Wave 1c): plain words search every card, open and closed, over all
// history, whatever view is picked, and clearing them goes back to that
// view (it stays in the address). Every other filter keeps the view, so an
// AI answer keeps the view (state) it chose. The contract that makes this
// hold: q holds only words a person typed; AI search never writes q, and
// its leftover words go to words. The approval queue shows every kind (the
// desk hides the kind filter there). One rule for the server search
// (src/server/search/query.ts) and the desk's list filter.
export function listScope(query: DeskQuery): { view: DeskView; kind: DeskKind } {
  return {
    view: scopeView(query),
    kind: query.view === "approval" ? "all" : query.kind,
  };
}

// How many cards a reload asks for: what is loaded, at least one page, at
// most the cap.
export function reloadLimit(loaded: number): number {
  return Math.min(DESK_PAGE_MAX, Math.max(DESK_PAGE_SIZE, loaded));
}

// A removable chip: patch is the change that removes it (useDeskFilter's
// update takes it as is).
export type FilterChip = { key: string; label: string; patch: Partial<DeskQuery> };
export type ChipVocabulary = { locations: { id: string; name: string }[]; requesterName: string | null };

const PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
};

function dayLabel(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const plural = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

// The chips under the toolbar: the search filters, which have no control of
// their own (view, status, kind, sort and the words do).
export function filterChips(query: DeskQuery, vocab: ChipVocabulary): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const id of query.locations) {
    chips.push({
      key: `location:${id}`,
      label: vocab.locations.find((location) => location.id === id)?.name ?? "Unknown location",
      patch: { locations: query.locations.filter((other) => other !== id) },
    });
  }
  if (query.requester) chips.push({ key: "requester", label: vocab.requesterName ?? "One person", patch: { requester: null } });
  if (query.person) chips.push({ key: "person", label: `Person: ${query.person}`, patch: { person: "" } });
  if (query.item) chips.push({ key: "item", label: `Item: ${query.item}`, patch: { item: "" } });
  if (query.pz) chips.push({ key: "pz", label: `Printed: ${query.pz}`, patch: { pz: "" } });
  if (query.words) chips.push({ key: "words", label: `Words: ${query.words}`, patch: { words: "" } });
  if (query.number) chips.push({ key: "number", label: query.number.toUpperCase(), patch: { number: "" } });
  if (query.from && query.to) {
    chips.push({ key: "range", label: `${dayLabel(query.from)} to ${dayLabel(query.to)}`, patch: { from: null, to: null } });
  } else if (query.date) {
    chips.push({ key: "date", label: PRESET_LABELS[query.date], patch: { date: null } });
  }
  if (query.older !== null) chips.push({ key: "older", label: `Waiting over ${plural(query.older)}`, patch: { older: null } });
  if (query.newer !== null) chips.push({ key: "newer", label: `Waiting under ${plural(query.newer)}`, patch: { newer: null } });
  return chips;
}

const VIEW_CHIP_LABELS: Record<DeskView, string> = {
  open: "Open cards",
  approval: "Needs approval",
  all: "All cards",
  closed: "Closed cards",
};
const KIND_CHIP_LABELS: Record<Exclude<DeskKind, "all">, string> = { drafts: "Drafts only", orders: "Orders only", deleted: "Deleted drafts" };
const SORT_CHIP_LABELS: Record<SortKey, string> = { newest: "Newest first", oldest: "Oldest first", waiting: "Waiting longest" };

// The chips for the parts of an AI answer that have a control of their own
// (view, kind, status, sort), each while it is still in force: every part
// of the understanding is a chip (owner decision), so an answer that sets
// no search filter still shows what it did, and a kind set while the kind
// control is hidden is never an invisible filter. Removing one undoes only
// that part: the view goes back to the one the person was on (fromView,
// null once they picked a view themselves), the kind to every kind, the
// status to none, the sort to the default.
export function understoodChips(
  answer: DeskQuery,
  current: DeskQuery,
  fromView: DeskView | null,
  statuses: { key: string; label: string }[],
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (fromView !== null && answer.view !== fromView && current.view === answer.view) {
    chips.push({ key: "view", label: VIEW_CHIP_LABELS[answer.view], patch: { view: fromView } });
  }
  if (answer.kind !== "all" && current.kind === answer.kind) {
    chips.push({ key: "kind", label: KIND_CHIP_LABELS[answer.kind], patch: { kind: "all" } });
  }
  if (answer.status !== null && current.status === answer.status) {
    const label = statuses.find((status) => status.key === answer.status)?.label ?? answer.status;
    chips.push({ key: "status", label: `Status: ${label}`, patch: { status: null } });
  }
  if (answer.sort !== querySortDefault(answer) && current.sort === answer.sort) {
    chips.push({ key: "sort", label: SORT_CHIP_LABELS[answer.sort], patch: { sort: querySortDefault(current) } });
  }
  return chips;
}

// The change Clear all makes: every search filter, the words, the status
// and the kind go, and the view goes back to the one the person was on
// (fromView, null once they picked a view themselves). While an AI answer
// holds (answer, null when none), the sort it set goes too, as its chip
// does (understoodChips), to the default of the view the person lands on;
// a sort the person picked themselves stays.
export function clearAllPatch(answer: DeskQuery | null, current: DeskQuery, fromView: DeskView | null): Partial<DeskQuery> {
  const view = fromView ?? current.view;
  const patch: Partial<DeskQuery> = { ...SEARCH_DEFAULTS, q: "", status: null, kind: "all", view };
  if (answer !== null && answer.sort !== querySortDefault(answer) && current.sort === answer.sort) {
    patch.sort = querySortDefault({ view, q: "" });
  }
  return patch;
}

// The search box's text after the address's q changes. The box keeps its
// own text (an input controlled by the router's transition drops typed keys
// and moves the cursor), so it keeps that text while the address still
// holds it as it reads back (a blank search is none, cut at 200), whatever
// useSearchParams last said, and takes the address's q otherwise: Back, a
// link, Clear filters.
export function searchBoxText(boxText: string, addressSearch: string): string {
  const addressQ = parseDeskQuery(new URLSearchParams(addressSearch)).q;
  const boxQ = boxText.trim().length > 0 ? boxText.slice(0, DESK_QUERY_MAX) : "";
  return boxQ === addressQ ? boxText : addressQ;
}

// Whether two addresses hold the same desk query: the open order (?order=,
// the drawer) and anything the desk does not read are left out, and a
// default spelled out reads as none. An AI answer replaces the query only
// while the address still holds the one it was asked from; a view, status,
// sort, kind, chip or words the person changed while it was on its way win.
export function sameDeskQuery(a: string, b: string): boolean {
  const key = (search: string) => deskParams(parseDeskQuery(new URLSearchParams(search))).toString();
  return key(a) === key(b);
}
