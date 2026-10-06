"use client";

import { useId, useRef, useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { IDLE_STATUS_INPUT, statusInput, type StatusInput } from "@/lib/status-commit";
import type { StatusView } from "@/server/desk/shapes";
import { Spinner } from "@/components/kit";

// The inline status control: a native select (keyboard, screen reader and
// phone pickers for free) dressed as the status chip, so it always shows
// the status's text label in its semantic color. An order whose key has no
// status row any more shows "Unknown: <key>" in slate and can be moved to
// any real status.
//
// It saves only on an explicit choice (src/lib/status-commit.ts): a status
// reached with the keyboard is staged (dashed outline, "Press Enter to
// save") until Enter or leaving the control, Escape drops it, and a mouse
// or touch pick saves at once. While a change for the order is saving
// (busy), nothing else is saved; the control stays focusable so a keyboard
// user keeps their place.
export function StatusSelect({
  statuses,
  value,
  onChange,
  label,
  size = "sm",
  disabled = false,
  busy = false,
  hint = null,
}: {
  statuses: StatusView[];
  value: string;
  onChange: (statusKey: string) => void;
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
  busy?: boolean;
  // Why the control is disabled (for example "Only a manager can reopen a
  // rejected request."), read with it and shown on hover.
  hint?: string | null;
}) {
  const hintId = useId();
  const whyId = useId();
  const input = useRef(IDLE_STATUS_INPUT);
  const [staged, setStaged] = useState<string | null>(null);
  const shown = staged ?? value;
  const current = statuses.find((status) => status.key === shown);
  const height = size === "md" ? "h-9 text-sm pl-3.5 pr-9" : "h-8 text-xs pl-3 pr-8";

  function step(event: StatusInput) {
    const result = statusInput(input.current, event, value, busy);
    input.current = result.state;
    setStaged(result.state.staged);
    if (result.commit !== null) {
      onChange(result.commit);
    }
    return result;
  }

  return (
    <span data-tone={current?.color ?? "slate"} className="relative inline-flex max-w-full">
      <select
        aria-label={current ? label : `${label}. Unknown status ${shown}`}
        aria-describedby={[staged !== null ? hintId : null, hint ? whyId : null].filter(Boolean).join(" ") || undefined}
        aria-busy={busy || undefined}
        title={
          staged !== null
            ? "Press Enter to save this status"
            : hint
              ? hint
              : current
                ? undefined
                : `Unknown status: ${shown}. Choose a status to move this order.`
        }
        value={shown}
        disabled={disabled}
        onPointerDown={() => step({ kind: "pointer" })}
        onKeyDown={(event) => {
          if (step({ kind: "key", key: event.key }).handled) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onChange={(event) => step({ kind: "change", value: event.target.value })}
        onBlur={() => step({ kind: "blur" })}
        onClick={(event) => event.stopPropagation()}
        className={`${height} max-w-full cursor-pointer appearance-none truncate rounded-control border bg-tone-fill font-semibold text-tone-text transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60 ${
          staged !== null ? "border-dashed border-tone-text" : "border-transparent"
        }`}
      >
        {current ? null : (
          <option value={shown} disabled>
            Unknown: {shown}
          </option>
        )}
        {statuses.map((status) => (
          <option key={status.key} value={status.key}>
            {status.label}
          </option>
        ))}
      </select>
      {busy ? (
        <span className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-tone-text ${size === "md" ? "right-3.5" : "right-3"}`}>
          <Spinner size={12} />
        </span>
      ) : (
        <CaretDownIcon
          size={12}
          aria-hidden
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-tone-text ${size === "md" ? "right-3.5" : "right-3"}`}
        />
      )}
      {hint ? (
        <span id={whyId} className="sr-only">
          {hint}
        </span>
      ) : null}
      {staged !== null ? (
        <span id={hintId} className="sr-only">
          Not saved yet. Press Enter to save, or Escape to keep the current status.
        </span>
      ) : null}
    </span>
  );
}
