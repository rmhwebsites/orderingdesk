"use client";

// Small building blocks shared by the Settings sections: the section frame,
// labeled fields with help and inline errors, an in-page confirmation step,
// focus hand-off and a JSON request helper.
// Tokens and the shared control shapes (src/components/ui.ts) only.

import { useEffect, useId, useRef } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { Spinner } from "@/components/kit";
import { ui } from "@/components/ui";

export type RequestResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; data: Record<string, unknown> | null };

const OFFLINE = "Could not reach the server. Check your connection and try again.";

// fetch with a JSON body (or a raw body for uploads), answering the parsed
// JSON or the server's plain-language error.
export async function requestJson<T>(
  url: string,
  init: { method: string; json?: unknown; body?: BodyInit; contentType?: string },
): Promise<RequestResult<T>> {
  let response: Response;
  try {
    const headers: Record<string, string> = {};
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
    } else if (init.contentType) {
      headers["content-type"] = init.contentType;
    }
    response = await fetch(url, {
      method: init.method,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, error: OFFLINE, data: null };
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    return { ok: true, status: response.status, data: data as T };
  }
  const error =
    typeof data?.error === "string" && data.error.length > 0
      ? data.error
      : response.status === 404
        ? "This is not available to you. Reload the page and try again."
        : `Something went wrong (HTTP ${response.status}). Try again.`;
  return { ok: false, status: response.status, error, data };
}

// Moves focus to target once the current update has rendered. For the
// moment an element that holds focus goes away (an inline step closes, a
// row is removed, a form swaps in): without it focus falls back to the page
// body and keyboard and screen reader users land at the top of the page.
// target is read when it runs, so it can name an element that only exists
// after the update (the trigger shown again, the next row). It runs on the
// next frame, and again shortly after in case no frame comes (a hidden tab
// gets no animation frames; timers still run there).
export function focusSoon(target: () => HTMLElement | null | undefined): void {
  const run = () => {
    const element = target();
    if (element && document.activeElement !== element) {
      element.focus();
    }
  };
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

// After the row at `index` of a list was removed (`length` rows are left):
// the order in which to look for the row whose control takes focus. The
// row that took its place first, then the rows after it, then the rows
// before it, nearest first. The caller skips rows with nothing to focus.
export function nearestRowOrder(length: number, index: number): number[] {
  const start = Math.min(Math.max(index, 0), length);
  const after = Array.from({ length: length - start }, (_, i) => start + i);
  const before = Array.from({ length: start }, (_, i) => start - 1 - i);
  return [...after, ...before];
}

// The heading of a Settings section, focusable from script (not by Tab):
// where focus goes when what it was on disappears with nothing nearer.
export function sectionHeading(id: string): HTMLElement | null {
  return document.getElementById(`${id}-heading`);
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // scroll-mt clears the sticky workspace header when a section link
    // opens the section: two rows (about 109px) up to lg, phones and
    // tablets alike, one row (about 61px) from lg.
    <section id={id} aria-labelledby={`${id}-heading`} className="flex scroll-mt-32 flex-col gap-4 lg:scroll-mt-24">
      <div>
        <h2 id={`${id}-heading`} tabIndex={-1} className="font-display text-lg font-semibold text-ink">
          {title}
        </h2>
        <div className="mt-1 max-w-[65ch] text-sm text-ink-2">{description}</div>
      </div>
      {children}
    </section>
  );
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`${ui.panel} p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function describedBy(id: string, parts: { help?: unknown; error?: unknown }): string | undefined {
  const ids = [parts.help ? `${id}-help` : null, parts.error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

// Label above, help under the label, the control, then the error under it.
// The control itself sets aria-describedby={describedBy(id, {help, error})}.
export function Field({
  id,
  label,
  help,
  error,
  children,
  className = "",
}: {
  id: string;
  label: string;
  help?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <label htmlFor={id} className={ui.label}>
        {label}
      </label>
      {help ? (
        <p id={`${id}-help`} className="-mt-1 text-sm text-ink-2">
          {help}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className={ui.errorText}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Select({
  className = "",
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <div className={`relative ${className}`}>
      <select {...props} className={`${ui.input} cursor-pointer appearance-none pr-9`}>
        {children}
      </select>
      <CaretDownIcon
        size={12}
        aria-hidden
        className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2"
      />
    </div>
  );
}

// The inline message lives in the shared kit (src/components/kit.tsx); it
// is re-exported so Settings sections keep importing it from here.
export { InlineMessage } from "@/components/kit";

// The in-page confirmation step for a destructive action: says what will
// happen and takes focus on its confirm button, which the question
// describes (aria-describedby), so a screen reader announces what is being
// confirmed along with the button. Cancel and Esc call
// onCancel and give focus back to returnFocus (the control that opened the
// step, as it is after the step closes). After a confirm, the caller moves
// focus itself (focusSoon), since what should hold it depends on what the
// action removed: the next row, the list heading, the field it cleared.
export function ConfirmStep({
  message,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  message: React.ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocus: () => HTMLElement | null | undefined;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  const wasBusy = useRef(busy);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  // The buttons are disabled while the action runs, which drops focus to
  // the page; when it fails and the step stays open, take it back.
  useEffect(() => {
    if (wasBusy.current && !busy) {
      confirmRef.current?.focus();
    }
    wasBusy.current = busy;
  }, [busy]);
  const cancel = () => {
    onCancel();
    focusSoon(returnFocus);
  };
  return (
    <div
      data-tone="red"
      className="flex flex-col gap-3 rounded-panel border border-line bg-surface-2 p-3.5 sm:flex-row sm:items-center"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <p id={messageId} className="min-w-0 flex-1 text-sm text-ink">
        {message}
      </p>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={cancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-describedby={messageId}
          className={ui.buttonDanger}
        >
          {busy ? <Spinner /> : null}
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </div>
  );
}

// A checkbox drawn as a switch; the native input keeps keyboard and screen
// reader behavior.
export function Switch({
  id,
  checked,
  onChange,
  label,
  disabled,
  busy,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  // Unavailable for a moment (a change is saving): it keeps keyboard focus
  // (aria-disabled, not disabled, which would drop focus to the page) and
  // ignores changes until it is not busy.
  busy?: boolean;
  // The id of help text about the switch, read with it.
  describedBy?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="inline-flex cursor-pointer items-center gap-2.5 text-sm text-ink has-[:disabled]:cursor-not-allowed has-[[aria-disabled=true]]:cursor-progress"
    >
      <span className="relative inline-flex h-6 w-10 shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-disabled={busy ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            if (!busy) {
              onChange(event.target.checked);
            }
          }}
          className="peer absolute inset-0 z-10 cursor-pointer opacity-0 disabled:cursor-not-allowed aria-disabled:cursor-progress"
        />
        <span
          aria-hidden
          className="absolute inset-0 rounded-control border border-line-strong bg-surface-2 transition-colors duration-150 peer-checked:border-primary-strong peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:opacity-60 peer-aria-disabled:opacity-60"
        />
        <span
          aria-hidden
          className="absolute left-1 top-1 size-4 rounded-control bg-ink-2 transition-transform duration-150 ease-out-soft peer-checked:translate-x-4 peer-checked:bg-primary-ink motion-reduce:transition-none"
        />
      </span>
      {label}
    </label>
  );
}

// A polite live region for a finished action. While empty it is taken out
// of the flow (still in the page, so the next message is announced).
export function SaveStatus({ text }: { text: string | null }) {
  return (
    <p aria-live="polite" className="inline-flex min-h-5 items-center gap-1.5 text-sm text-ink-2 empty:absolute">
      {text ? (
        <>
          <CheckCircleIcon size={16} aria-hidden data-tone="green" className="text-tone-text" />
          {text}
        </>
      ) : null}
    </p>
  );
}
