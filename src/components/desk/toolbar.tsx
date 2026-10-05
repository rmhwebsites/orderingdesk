"use client";

import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import type { DeskKind, SortKey } from "@/lib/desk-state";
import { ui } from "@/components/ui";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "total", label: "Highest total" },
];

// All / Drafts / Orders, and Deleted while requests whose draft Shopify
// deleted exist (draft orders spec section 11.2 with section 18 item 7).
// Native radios: arrow keys move between them, the group has one tab stop.
function KindFilter({
  kind,
  onKind,
  draftCount,
  deletedCount,
}: {
  kind: DeskKind;
  onKind: (kind: DeskKind) => void;
  draftCount: number;
  deletedCount: number;
}) {
  const options: { value: DeskKind; label: string; count?: number }[] = [
    { value: "all", label: "All" },
    { value: "drafts", label: "Drafts", count: draftCount },
    { value: "orders", label: "Orders" },
    ...(deletedCount > 0 ? [{ value: "deleted" as const, label: "Deleted", count: deletedCount }] : []),
  ];
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">Show requests and orders</legend>
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <div className="inline-flex rounded-control border border-line bg-surface-2 p-0.5">
          {options.map((option) => (
            <label
              key={option.value}
              className={`relative inline-flex h-9 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control px-3.5 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                kind === option.value ? "bg-surface font-semibold text-ink shadow-panel" : "text-ink-2 hover:text-ink"
              }`}
            >
              <input
                type="radio"
                name="desk-kind"
                value={option.value}
                checked={kind === option.value}
                onChange={() => onKind(option.value)}
                className="sr-only"
              />
              {option.label}
              {option.count !== undefined ? (
                <span className="font-mono text-xs tabular-nums text-ink-2">{option.count.toLocaleString("en-US")}</span>
              ) : null}
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

export function Toolbar({
  query,
  onQuery,
  sort,
  onSort,
  shown,
  loaded,
  kindFilter,
}: {
  query: string;
  onQuery: (query: string) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  shown: number;
  loaded: number;
  // The requests and orders filter, when the workspace has requests.
  kindFilter?: {
    kind: DeskKind;
    onKind: (kind: DeskKind) => void;
    draftCount: number;
    deletedCount: number;
  } | null;
}) {
  const filtered = shown !== loaded;
  return (
    <div className="flex flex-col gap-2 desk:flex-row desk:items-center desk:gap-3">
      {kindFilter ? <KindFilter {...kindFilter} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <label htmlFor="desk-search" className="sr-only">
          Search orders
        </label>
        <MagnifyingGlassIcon
          size={16}
          aria-hidden
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
        <input
          id="desk-search"
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={kindFilter ? "Search order, request, name or item" : "Search order, customer, email or item"}
          autoComplete="off"
          spellCheck={false}
          className={`${ui.input} pl-10`}
        />
      </div>
      <div className="flex items-center justify-between gap-3 sm:ml-auto sm:justify-end">
        <p className="text-sm tabular-nums text-ink-2" aria-live="polite">
          {filtered
            ? `${shown.toLocaleString("en-US")} of ${loaded.toLocaleString("en-US")} shown`
            : `${loaded.toLocaleString("en-US")} ${kindFilter ? "orders and requests" : loaded === 1 ? "order" : "orders"}`}
        </p>
        <div className="relative">
          <label htmlFor="desk-sort" className="sr-only">
            Sort orders
          </label>
          <select
            id="desk-sort"
            value={sort}
            onChange={(event) => onSort(event.target.value as SortKey)}
            className={`${ui.input} w-auto cursor-pointer appearance-none pr-9 font-medium`}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <CaretDownIcon
            size={12}
            aria-hidden
            className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2"
          />
        </div>
      </div>
      </div>
    </div>
  );
}
