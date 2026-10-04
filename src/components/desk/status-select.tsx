"use client";

import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import type { StatusView } from "@/server/desk/shapes";

// The inline status control: a native select (keyboard, screen reader and
// phone pickers for free) dressed as the status chip, so it always shows
// the status's text label in its semantic color. An order whose key has no
// status row any more shows "Unknown: <key>" in slate and can be moved to
// any real status.
export function StatusSelect({
  statuses,
  value,
  onChange,
  label,
  size = "sm",
  disabled = false,
}: {
  statuses: StatusView[];
  value: string;
  onChange: (statusKey: string) => void;
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const current = statuses.find((status) => status.key === value);
  const height = size === "md" ? "h-9 text-sm pl-3.5 pr-9" : "h-8 text-xs pl-3 pr-8";
  return (
    <span data-tone={current?.color ?? "slate"} className="relative inline-flex max-w-full">
      <select
        aria-label={current ? label : `${label}. Unknown status ${value}`}
        title={current ? undefined : `Unknown status: ${value}. Choose a status to move this order.`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        className={`${height} max-w-full cursor-pointer appearance-none truncate rounded-control border border-transparent bg-tone-fill font-semibold text-tone-text transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {current ? null : (
          <option value={value} disabled>
            Unknown: {value}
          </option>
        )}
        {statuses.map((status) => (
          <option key={status.key} value={status.key}>
            {status.label}
          </option>
        ))}
      </select>
      <CaretDownIcon
        size={12}
        aria-hidden
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-tone-text ${size === "md" ? "right-3.5" : "right-3"}`}
      />
    </span>
  );
}
