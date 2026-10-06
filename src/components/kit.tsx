"use client";

// One component kit (comprehensive desk design section 1, taste v2 audit):
// Chip in three sizes, InlineMessage, Section, DetailRow, RadioCard,
// Segmented, Monogram and Spinner. Desk, shell and Settings screens build
// from these instead of local copies (src/components/kit-adoption.test.ts
// keeps it that way). Tokens and the shared control shapes
// (src/components/ui.ts) only. A client module, so server components can
// render the hook-free pieces (Monogram, Chip) as client components.

import type { ReactNode } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";

export type ChipSize = "sm" | "md" | "lg";

// 24, 28 and 32px tall. Chip text is never under 12px (phone ergonomics).
const CHIP_SIZES: Record<ChipSize, string> = {
  sm: "min-h-6 gap-1 px-2 py-0.5 text-xs leading-tight",
  md: "h-7 gap-1.5 px-2.5 text-xs",
  lg: "h-8 gap-1.5 px-3 text-sm",
};

// A state label on its semantic tone (data-tone, src/app/globals.css).
export function Chip({
  tone,
  size = "md",
  title,
  className = "",
  children,
}: {
  tone: string;
  size?: ChipSize;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={`inline-flex shrink-0 items-center rounded-control bg-tone-fill font-semibold text-tone-text ${CHIP_SIZES[size]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}

export type MessageTone = "good" | "bad" | "warn" | "info";

const MESSAGE: Record<MessageTone, { tone: string; Icon: typeof InfoIcon }> = {
  good: { tone: "green", Icon: CheckCircleIcon },
  bad: { tone: "red", Icon: WarningCircleIcon },
  warn: { tone: "amber", Icon: WarningIcon },
  info: { tone: "blue", Icon: InfoIcon },
};

// A persistent inline message (a result, a problem, a heads-up), on its
// semantic tone. Errors are announced at once, the rest politely. action:
// a control at its end (a dismiss button).
export function InlineMessage({
  tone,
  children,
  id,
  action,
}: {
  tone: MessageTone;
  children: ReactNode;
  id?: string;
  action?: ReactNode;
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
      {action ? <div className="-my-1.5 -mr-1.5 shrink-0">{action}</div> : null}
    </div>
  );
}

// A drawer section with its heading, separated from the one before it.
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <h3 className="mb-3 font-display text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

// One term and its value inside a dl: stacked on phones, side by side from
// sm.
export function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-sm text-ink-2 sm:w-40">{term}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

// One choice of a short list drawn as a card: a native radio (keyboard and
// screen readers for free), its label and an optional line of help.
export function RadioCard({
  name,
  value,
  checked,
  onChange,
  label,
  help,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  help?: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-panel border px-3.5 py-3 transition-colors ${
        checked ? "border-primary-strong bg-surface" : "border-line hover:bg-surface-2"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 accent-[var(--primary-strong)]"
      />
      <span>
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {help ? <span className="block text-sm text-ink-2">{help}</span> : null}
      </span>
    </label>
  );
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
  icon?: ReactNode;
  // Show only the icon; the label stays for screen readers and as a tooltip.
  iconOnly?: boolean;
};

// A one-of-several choice as a native radio group: arrow keys move between
// options and the group is one tab stop. The active option carries a bar in
// primary-strong (a plain primary can read under 3:1 on light surfaces;
// lime reads at 1.76:1). 40px tall on touch screens. The focus ring sits
// inside each option: the track scrolls, and a scrolling box clips anything
// drawn outside it.
export function Segmented<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  size = "md",
  className = "",
}: {
  name: string;
  legend: string;
  value: T | null;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <fieldset className={`min-w-0 ${className}`.trim()}>
      <legend className="sr-only">{legend}</legend>
      <div className="inline-flex max-w-full overflow-x-auto rounded-control border border-line bg-surface-2 p-0.5 [scrollbar-width:none]">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              title={option.iconOnly ? option.label : undefined}
              className={`relative inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control text-sm transition-colors pointer-coarse:h-10 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-focus ${
                size === "sm" ? "h-8 px-2.5" : "h-9 px-3.5"
              } ${checked ? "bg-surface font-semibold text-ink shadow-panel" : "text-ink-2 hover:text-ink"}`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.icon}
              <span className={option.iconOnly ? "sr-only" : undefined}>{option.label}</span>
              {option.count !== undefined ? (
                <span className="font-mono text-xs tabular-nums text-ink-2">{option.count.toLocaleString("en-US")}</span>
              ) : null}
              {checked ? (
                <span aria-hidden className="absolute inset-x-2 bottom-0.5 h-0.5 rounded-control bg-primary-strong" />
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const MONOGRAM_SIZES = {
  sm: "size-8 text-sm",
  md: "size-9 text-sm",
  lg: "size-10 text-base",
} as const;

// One or two letters on a primary tile: a workspace without a symbol, or a
// person in the account menu. Decorative: the name beside it (or the
// control's label) carries the meaning.
export function Monogram({ text, size = "md" }: { text: string; size?: keyof typeof MONOGRAM_SIZES }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-control bg-primary font-display font-semibold text-primary-ink ${MONOGRAM_SIZES[size]}`}
    >
      {text}
    </span>
  );
}

// The busy mark inside a button that is working (the button carries
// aria-busy). Still under reduced motion (.od-spin in globals.css).
export function Spinner({ size = 16 }: { size?: number }) {
  return <CircleNotchIcon size={size} aria-hidden className="od-spin shrink-0" />;
}
