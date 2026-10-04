"use client";

import type { StatusChip } from "@/lib/desk-state";

function FilterChip({
  active,
  label,
  rawKey,
  count,
  tone,
  onClick,
}: {
  active: boolean;
  label: string;
  rawKey?: string;
  count: number;
  tone?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`relative inline-flex h-9 shrink-0 snap-start items-center gap-2 rounded-control border px-3.5 text-sm transition-colors motion-safe:active:scale-[0.98] ${
        active
          ? "border-line-strong bg-surface font-semibold text-ink shadow-panel"
          : "border-line text-ink-2 hover:bg-surface hover:text-ink"
      }`}
    >
      {tone ? <span data-tone={tone} aria-hidden className="size-2 shrink-0 rounded-control bg-tone-text" /> : null}
      <span className="whitespace-nowrap">{label}</span>
      {rawKey ? <span className="font-mono text-xs text-ink-2">{rawKey}</span> : null}
      <span className="font-mono text-xs tabular-nums text-ink-2">{count.toLocaleString("en-US")}</span>
      {/* The workspace primary color marks the active filter. */}
      {active ? <span aria-hidden className="absolute inset-x-3 -bottom-px h-[3px] rounded-control bg-primary" /> : null}
    </button>
  );
}

// Status counts that double as filters. Counts cover every order, including
// keys whose status was removed ("Unknown status" with the raw key).
export function StatusStrip({
  chips,
  total,
  active,
  onSelect,
}: {
  chips: StatusChip[];
  total: number;
  active: string | null;
  onSelect: (statusKey: string | null) => void;
}) {
  return (
    <nav aria-label="Filter orders by status">
      <ul className="-mx-4 flex snap-x scroll-px-4 gap-1.5 overflow-x-auto px-4 pb-1 sm:scroll-px-6 [scrollbar-width:none] sm:-mx-6 sm:px-6 desk:mx-0 desk:flex-wrap desk:overflow-visible desk:px-0">
        <li>
          <FilterChip active={active === null} label="All" count={total} onClick={() => onSelect(null)} />
        </li>
        {chips.map((chip) => (
          <li key={chip.key}>
            <FilterChip
              active={active === chip.key}
              label={chip.label}
              rawKey={chip.known ? undefined : chip.key}
              count={chip.count}
              tone={chip.color}
              onClick={() => onSelect(active === chip.key ? null : chip.key)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}
