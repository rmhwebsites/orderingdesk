"use client";

import { SparkleIcon } from "@phosphor-icons/react/Sparkle";
import { XIcon } from "@phosphor-icons/react/X";
import type { DeskQuery, FilterChip } from "@/lib/desk-query";
import { ui } from "@/components/ui";

// What a fallback tells the person (null: nothing worth saying).
export function aiFallbackNotice(reason: string): string | null {
  switch (reason) {
    case "limit":
      return "AI search is used up for today, so these are keyword matches.";
    case "timeout":
    case "busy":
    case "error":
      return "AI search did not answer in time, so these are keyword matches.";
    case "invalid":
      return "AI search could not read that question, so these are keyword matches.";
    default:
      return null;
  }
}

// The filters with no control of their own (src/lib/desk-query.ts
// filterChips), each removable. understood: AI search set them just now.
export function FilterChips({
  chips,
  understood,
  onRemove,
  onClear,
}: {
  chips: FilterChip[];
  understood: boolean;
  onRemove: (patch: Partial<DeskQuery>) => void;
  onClear: () => void;
}) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-2">
      {understood ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2">
          <SparkleIcon size={14} aria-hidden />
          Understood as
        </span>
      ) : null}
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onRemove(chip.patch)}
          aria-label={`Remove filter ${chip.label}`}
          className="inline-flex h-10 max-w-full items-center gap-1.5 rounded-control border border-line bg-surface-2 pl-3.5 pr-2.5 text-sm font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface"
        >
          <span className="truncate">{chip.label}</span>
          <XIcon size={14} aria-hidden className="shrink-0 text-ink-2" />
        </button>
      ))}
      <button type="button" onClick={onClear} className={`${ui.buttonQuiet} h-10`}>
        Clear all
      </button>
    </div>
  );
}
