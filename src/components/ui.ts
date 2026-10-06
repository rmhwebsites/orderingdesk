// Shared class lists for the few control shapes the app uses. One radius
// system: every interactive control is rounded-control, panels and cards
// are rounded-panel; both come from the workspace's radius choice (pill
// controls on 12px panels by default). Colors come from the tokens in
// globals.css. A busy button (aria-busy) keeps full opacity: it is working,
// not unavailable (comprehensive desk design section 1).

const control =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control text-sm font-semibold transition-[background-color,border-color,color,transform] duration-150 ease-out-soft motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 aria-busy:cursor-progress aria-busy:opacity-100";

// Text fields: a hover and a focus border, and a red border and ring when
// aria-invalid is set.
const field =
  "w-full border border-line-strong bg-surface text-sm text-ink transition-colors placeholder:text-ink-3 hover:border-ink-3 focus-visible:border-ink aria-[invalid=true]:border-bad aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-bad/25";

export const ui = {
  buttonPrimary: `${control} h-10 bg-primary px-4 text-primary-ink hover:bg-primary-hover`,
  buttonSecondary: `${control} h-10 border border-line-strong bg-surface px-4 text-ink hover:bg-surface-2`,
  buttonQuiet: `${control} h-9 px-3 text-ink-2 hover:bg-surface-2 hover:text-ink`,
  // Confirms a destructive step; sits inside a data-tone="red" element.
  buttonDanger: `${control} h-10 bg-tone-fill px-4 text-tone-text hover:bg-tone-fill-hover`,
  // Opens a destructive step (Reject, Remove): quiet until it is confirmed.
  buttonDangerSecondary: `${control} h-10 border border-line-strong bg-surface px-4 text-bad hover:bg-surface-2`,
  iconButton: `${control} size-10 text-ink-2 hover:bg-surface-2 hover:text-ink`,
  input: `h-10 rounded-control px-4 ${field}`,
  // Multi-line text takes the panel radius (a pill would clip its corners).
  textarea: `min-h-20 rounded-panel px-4 py-2.5 ${field}`,
  label: "text-sm font-medium text-ink",
  panel: "rounded-panel border border-line bg-surface",
  errorText: "text-sm text-bad",
} as const;
