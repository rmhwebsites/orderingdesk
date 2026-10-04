// Shared class lists for the few control shapes the app uses. One radius
// system: every interactive control is rounded-control, panels and cards
// are rounded-panel; both come from the workspace's radius choice (pill
// controls on 12px panels by default). Colors come from the tokens in
// globals.css.

const control =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control text-sm font-semibold transition-[background-color,color,transform] duration-150 ease-out-soft motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100";

export const ui = {
  buttonPrimary: `${control} h-10 bg-primary px-4 text-primary-ink hover:brightness-95`,
  buttonSecondary: `${control} h-10 border border-line-strong bg-surface px-4 text-ink hover:bg-surface-2`,
  buttonQuiet: `${control} h-9 px-3 text-ink-2 hover:bg-surface-2 hover:text-ink`,
  // Confirms a destructive step; sits inside a data-tone="red" element.
  buttonDanger: `${control} h-10 bg-tone-fill px-4 text-tone-text hover:brightness-95`,
  iconButton: `${control} size-10 text-ink-2 hover:bg-surface-2 hover:text-ink`,
  input:
    "h-10 w-full rounded-control border border-line-strong bg-surface px-4 text-sm text-ink placeholder:text-ink-3",
  // Multi-line text takes the panel radius (a pill would clip its corners).
  textarea:
    "min-h-20 w-full rounded-panel border border-line-strong bg-surface px-4 py-2.5 text-sm text-ink placeholder:text-ink-3",
  label: "text-sm font-medium text-ink",
  panel: "rounded-panel border border-line bg-surface",
  errorText: "text-sm text-bad",
} as const;
