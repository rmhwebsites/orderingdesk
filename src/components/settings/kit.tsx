"use client";

// Small building blocks shared by the Settings sections: the section frame,
// labeled fields with help and inline errors, inline messages, tone chips,
// an in-page confirmation step and a JSON request helper. Tokens and the
// shared control shapes (src/components/ui.ts) only.

import { useEffect, useRef } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
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
    <section id={id} aria-labelledby={`${id}-heading`} className="flex scroll-mt-32 flex-col gap-4 sm:scroll-mt-24">
      <div>
        <h2 id={`${id}-heading`} className="font-display text-lg font-semibold text-ink">
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

type MessageTone = "good" | "bad" | "warn" | "info";

const MESSAGE: Record<MessageTone, { tone: string; Icon: typeof InfoIcon }> = {
  good: { tone: "green", Icon: CheckCircleIcon },
  bad: { tone: "red", Icon: WarningCircleIcon },
  warn: { tone: "amber", Icon: WarningIcon },
  info: { tone: "blue", Icon: InfoIcon },
};

// A persistent inline message (a result, a problem, a heads-up), on its
// semantic tone. Errors are announced at once, the rest politely.
export function InlineMessage({
  tone,
  children,
  id,
}: {
  tone: MessageTone;
  children: React.ReactNode;
  id?: string;
}) {
  const { tone: color, Icon } = MESSAGE[tone];
  return (
    <div
      id={id}
      role={tone === "bad" ? "alert" : "status"}
      data-tone={color}
      className="flex items-start gap-2.5 rounded-panel bg-tone-fill px-3.5 py-3 text-sm text-tone-text"
    >
      <Icon size={18} aria-hidden className="mt-px shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function ToneChip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      data-tone={tone}
      className="inline-flex h-6 shrink-0 items-center rounded-control bg-tone-fill px-2.5 text-xs font-semibold text-tone-text"
    >
      {children}
    </span>
  );
}

// The in-page confirmation step for a destructive action: says what will
// happen, takes focus on its confirm button, and Esc cancels.
export function ConfirmStep({
  message,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  message: React.ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div
      data-tone="red"
      className="flex flex-col gap-3 rounded-panel border border-line bg-surface-2 p-3.5 sm:flex-row sm:items-center"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="min-w-0 flex-1 text-sm text-ink">{message}</p>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={ui.buttonDanger}
        >
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
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2.5 text-sm text-ink has-[:disabled]:cursor-not-allowed">
      <span className="relative inline-flex h-6 w-10 shrink-0">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer absolute inset-0 z-10 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden
          className="absolute inset-0 rounded-control border border-line-strong bg-surface-2 transition-colors duration-150 peer-checked:border-primary-strong peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:opacity-60"
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
