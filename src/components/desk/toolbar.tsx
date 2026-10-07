"use client";

import { useEffect, useRef, useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { FunnelSimpleIcon } from "@phosphor-icons/react/FunnelSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/X";
import { defaultSort, type DeskView, type ViewCounts } from "@/lib/desk-query";
import type { DeskKind, SortKey, StatusChip } from "@/lib/desk-state";
import { Segmented, type SegmentedOption } from "@/components/kit";
import { ui } from "@/components/ui";
import { DeskSearchField, matchLabel } from "./search-field";

// The desk's filters (comprehensive desk design section 1): one row from
// 880px (view, status, kind, search, sort); on phones one row with the
// view, a search button and a filter button, whose rows open beneath it.
// Each button is marked while what it holds is on, open or closed.

const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "waiting", label: "Waiting longest" },
];

export type KindFilter = {
  kind: DeskKind;
  onKind: (kind: DeskKind) => void;
  draftCount: number;
  deletedCount: number;
};

export type ToolbarProps = {
  layout: "row" | "phone";
  statusKey: string | null;
  onStatus: (statusKey: string | null) => void;
  statusChips: StatusChip[];
  // The search box (search-field.tsx): its text as the desk knows it, the
  // reset counter, typing (debounced by the desk) and Enter.
  query: string;
  resetKey: number;
  onQuery: (query: string) => void;
  onSubmit: (query: string) => void;
  // AI search is answering, and whether it is on for this workspace.
  asking: boolean;
  aiHint: boolean;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  // The requests and orders filter, when the workspace has requests.
  kindFilter: KindFilter | null;
  // Cards matching the filter over all history, the server's count
  // (announced politely).
  count: number;
  view: DeskView;
  onView: (view: DeskView) => void;
  viewCounts: ViewCounts;
  // Managers and platform admins see the Needs approval view.
  showApproval: boolean;
};

const ALL = "";

function NativeSelect({
  id,
  label,
  value,
  onChange,
  className = "",
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`relative ${className}`.trim()}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${ui.input} cursor-pointer appearance-none truncate pr-9 font-medium`}
      >
        {children}
      </select>
      <CaretDownIcon size={12} aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2" />
    </div>
  );
}

function StatusFilter({
  statusKey,
  onStatus,
  chips,
  className,
}: {
  statusKey: string | null;
  onStatus: (statusKey: string | null) => void;
  chips: StatusChip[];
  className?: string;
}) {
  return (
    <NativeSelect
      id="desk-status"
      label="Filter by status"
      value={statusKey ?? ALL}
      onChange={(value) => onStatus(value === ALL ? null : value)}
      className={className}
    >
      <option value={ALL}>All statuses</option>
      {chips.map((chip) => (
        <option key={chip.key} value={chip.key}>
          {`${chip.known ? chip.label : `Unknown: ${chip.key}`} (${chip.count.toLocaleString("en-US")})`}
        </option>
      ))}
    </NativeSelect>
  );
}

function SortSelect({ sort, onSort, className }: { sort: SortKey; onSort: (sort: SortKey) => void; className?: string }) {
  return (
    <NativeSelect id="desk-sort" label="Sort orders" value={sort} onChange={(value) => onSort(value as SortKey)} className={className}>
      {SORTS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  );
}

function viewOptions(counts: ViewCounts, approval: boolean): SegmentedOption<DeskView>[] {
  return [
    { value: "open", label: "Open", count: counts.open },
    ...(approval ? [{ value: "approval" as const, label: "Needs approval", count: counts.approval }] : []),
    { value: "all", label: "All", count: counts.all },
    { value: "closed", label: "Closed", count: counts.closed },
  ];
}

function kindOptions(filter: KindFilter): SegmentedOption<DeskKind>[] {
  return [
    { value: "all", label: "All" },
    { value: "drafts", label: "Drafts", count: filter.draftCount },
    { value: "orders", label: "Orders" },
    ...(filter.deletedCount > 0 ? [{ value: "deleted" as const, label: "Deleted", count: filter.deletedCount }] : []),
  ];
}

function KindSegments({ filter, className }: { filter: KindFilter; className?: string }) {
  return (
    <Segmented
      name="desk-kind"
      legend="Show requests and orders"
      value={filter.kind}
      options={kindOptions(filter)}
      onChange={filter.onKind}
      className={className}
    />
  );
}

function MatchCount({ count }: { count: number }) {
  return (
    <p className="sr-only" aria-live="polite">
      {matchLabel(count)}
    </p>
  );
}

function RowToolbar({
  statusKey,
  onStatus,
  statusChips,
  query,
  resetKey,
  onQuery,
  onSubmit,
  asking,
  aiHint,
  sort,
  onSort,
  kindFilter,
  count,
  view,
  onView,
  viewCounts,
  showApproval,
}: ToolbarProps) {
  return (
    // Wraps to a second line only between 880px and about 1280px; one row
    // at 1440.
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-2">
      <Segmented
        name="desk-view"
        legend="Show"
        value={view}
        options={viewOptions(viewCounts, showApproval || view === "approval")}
        onChange={onView}
        className="shrink-0"
      />
      <StatusFilter statusKey={statusKey} onStatus={onStatus} chips={statusChips} className="w-52 shrink-0" />
      {kindFilter ? <KindSegments filter={kindFilter} className="shrink-0" /> : null}
      <DeskSearchField
        value={query}
        resetKey={resetKey}
        onChange={onQuery}
        onSubmit={onSubmit}
        asking={asking}
        aiHint={aiHint}
        className="min-w-40 max-w-md flex-1"
      />
      <SortSelect sort={sort} onSort={onSort} className="ml-auto w-44 shrink-0" />
      <MatchCount count={count} />
    </div>
  );
}

function PhoneToolbar({
  statusKey,
  onStatus,
  statusChips,
  query,
  resetKey,
  onQuery,
  onSubmit,
  asking,
  aiHint,
  sort,
  onSort,
  kindFilter,
  count,
  view,
  onView,
  viewCounts,
  showApproval,
}: ToolbarProps) {
  const [searching, setSearching] = useState(query.length > 0);
  const [filtering, setFiltering] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  // Focus the search only when the person opened it (not on a page that
  // loads with a search in its address).
  const focusSearch = useRef(false);
  useEffect(() => {
    if (searching && focusSearch.current) {
      focusSearch.current = false;
      searchRef.current?.focus();
    }
  }, [searching]);
  const active =
    (statusKey ? 1 : 0) + (kindFilter && kindFilter.kind !== "all" ? 1 : 0) + (sort !== defaultSort(view) ? 1 : 0);
  // The search keeps filtering when its row is closed, so the button says
  // so (blank words search nothing, src/lib/desk-query.ts).
  const searchOn = query.trim().length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <NativeSelect id="desk-view" label="Show" value={view} onChange={(value) => onView(value as DeskView)} className="min-w-0 flex-1">
          {viewOptions(viewCounts, showApproval || view === "approval").map((option) => (
            <option key={option.value} value={option.value}>
              {`${option.label} (${(option.count ?? 0).toLocaleString("en-US")})`}
            </option>
          ))}
        </NativeSelect>
        <button
          type="button"
          aria-expanded={searching}
          aria-controls="desk-search-row"
          onClick={() => {
            focusSearch.current = !searching;
            setSearching((current) => !current);
          }}
          className={`${ui.iconButton} relative border border-line-strong`}
        >
          <MagnifyingGlassIcon size={18} aria-hidden />
          <span className="sr-only">{searchOn ? "Search, on" : "Search"}</span>
          {searchOn ? <span aria-hidden className="absolute -right-0.5 -top-0.5 size-3 rounded-full bg-primary-strong ring-2 ring-surface" /> : null}
        </button>
        <button
          type="button"
          aria-expanded={filtering}
          aria-controls="desk-filter-row"
          onClick={() => setFiltering((current) => !current)}
          className={`${ui.iconButton} relative border border-line-strong`}
        >
          <FunnelSimpleIcon size={18} aria-hidden />
          <span className="sr-only">{active > 0 ? `More filters, ${active} on` : "More filters"}</span>
          {active > 0 ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-control bg-primary px-1 text-xs font-semibold tabular-nums text-primary-ink"
            >
              {active}
            </span>
          ) : null}
        </button>
      </div>
      {searching ? (
        <div id="desk-search-row" className="flex items-center gap-2">
          <DeskSearchField
            value={query}
            resetKey={resetKey}
            onChange={onQuery}
            onSubmit={onSubmit}
            asking={asking}
            aiHint={aiHint}
            inputRef={searchRef}
            className="min-w-0 flex-1"
          />
          {query ? (
            <button type="button" onClick={() => onSubmit("")} className={ui.iconButton}>
              <XIcon size={18} aria-hidden />
              <span className="sr-only">Clear the search</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {filtering ? (
        <div id="desk-filter-row" className="flex flex-col gap-2">
          <StatusFilter statusKey={statusKey} onStatus={onStatus} chips={statusChips} className="w-full" />
          {kindFilter ? <KindSegments filter={kindFilter} /> : null}
          <SortSelect sort={sort} onSort={onSort} className="w-full" />
        </div>
      ) : null}
      <MatchCount count={count} />
    </div>
  );
}

export function Toolbar(props: ToolbarProps) {
  return props.layout === "row" ? <RowToolbar {...props} /> : <PhoneToolbar {...props} />;
}
