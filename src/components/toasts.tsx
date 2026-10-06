"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { XIcon } from "@phosphor-icons/react/X";

// Toasts are for transient events only (a sync finished, new orders
// arrived, a heads-up). Persistent problems are shown inline where they
// live, never only as a toast.

type ToastTone = "info" | "good" | "warn";

type Toast = { id: number; title: string; body?: string; tone: ToastTone };

type ToastInput = { title: string; body?: string; tone?: ToastTone };

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

const VISIBLE_MS = 6000;
const MAX_TOASTS = 3;

const ICONS: Record<ToastTone, typeof InfoIcon> = {
  info: InfoIcon,
  good: CheckCircleIcon,
  warn: WarningIcon,
};

const TONE_COLOR: Record<ToastTone, string> = { info: "blue", good: "green", warn: "amber" };

export function useToast(): (toast: ToastInput) => void {
  const push = useContext(ToastContext);
  if (!push) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return push;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const Icon = ICONS[toast.tone];

  useEffect(() => {
    if (paused) {
      return;
    }
    const timer = setTimeout(() => onDismiss(toast.id), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [paused, toast.id, onDismiss]);

  return (
    <li
      className="od-rise pointer-events-auto flex w-full items-start gap-3 rounded-panel border border-line bg-surface p-3 pr-2 shadow-lift sm:w-[360px]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span data-tone={TONE_COLOR[toast.tone]} className="mt-0.5 text-tone-text">
        <Icon size={18} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{toast.title}</p>
        {toast.body ? <p className="mt-0.5 text-sm text-ink-2">{toast.body}</p> : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="grid size-8 shrink-0 place-items-center rounded-control text-ink-2 hover:bg-surface-2 hover:text-ink pointer-coarse:size-10"
      >
        <XIcon size={16} aria-hidden />
        <span className="sr-only">Dismiss</span>
      </button>
    </li>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const toast: Toast = { id: nextId.current++, title: input.title, body: input.body, tone: input.tone ?? "info" };
    setToasts((current) => [...current, toast].slice(-MAX_TOASTS));
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* z-50: above the drawer (z-40) and the top bar (z-30). */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 sm:justify-end sm:p-6"
      >
        <ol className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </ol>
      </div>
    </ToastContext.Provider>
  );
}
