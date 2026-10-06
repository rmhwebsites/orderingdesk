"use client";

// Bulk status change (comprehensive desk design section 1): the bar at the
// bottom of the desk while cards are selected. Pick a status, then one
// confirmation lists every selected card and says which will stay where
// they are and why (src/lib/status-rules.ts; the server checks each card
// again). The outcome stays in the bar until dismissed, with every card
// that did not move, grouped by reason so a long refusal list stays short.
// The bar never takes more than 60% of the screen: the outcome and its
// Dismiss button stay put while the controls under them scroll.

import { useEffect, useId, useRef, useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { XIcon } from "@phosphor-icons/react/X";
import type { Role } from "@/lib/roles";
import { BULK_STATUS_MAX, planBulkMove, type BulkCard, type BulkPlanRow } from "@/lib/status-rules";
import type { StatusView } from "@/server/desk/shapes";
import { InlineMessage, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";

// A refusal's name is null for a card that is no longer in the workspace.
export type BulkResult = { tone: "good" | "warn"; text: string; refusals: { name: string | null; error: string }[] };

// The cards that did not move, one entry per reason, in the order the
// reasons first appear.
function groupRefusals(refusals: BulkResult["refusals"]): { error: string; names: (string | null)[] }[] {
  const groups = new Map<string, (string | null)[]>();
  for (const { name, error } of refusals) {
    groups.set(error, [...(groups.get(error) ?? []), name]);
  }
  return [...groups].map(([error, names]) => ({ error, names }));
}

// Up to the safe area at the foot of a phone screen.
const SAFE_BOTTOM = "pb-[max(0.75rem,env(safe-area-inset-bottom))]";

export function BulkConfirm({
  target,
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  target: StatusView;
  plan: BulkPlanRow[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const questionRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    questionRef.current?.focus();
  }, []);
  const movable = plan.filter((row) => row.stays === null).length;
  return (
    <div
      role="group"
      aria-labelledby={`${id}-question`}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
        {`Move ${movable} of ${plan.length} selected ${plan.length === 1 ? "card" : "cards"} to ${target.label}?`}
      </p>
      <ul aria-label="Selected cards" className="flex max-h-48 flex-col divide-y divide-line overflow-y-auto rounded-panel border border-line bg-surface text-sm">
        {plan.map(({ card, stays }) => (
          <li key={card.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
            <span className="font-mono font-semibold tabular-nums text-ink">{card.name}</span>
            <span className="min-w-0 flex-1 truncate text-ink-2">{card.customerName || "No customer name"}</span>
            {stays ? <span className="w-full text-xs text-warn">{`Stays: ${stays}`}</span> : null}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || movable === 0}
          aria-busy={busy || undefined}
          aria-describedby={`${id}-question`}
          className={ui.buttonPrimary}
        >
          {busy ? <Spinner /> : null}
          {busy ? "Moving" : `Move ${movable} ${movable === 1 ? "card" : "cards"}`}
        </button>
      </div>
    </div>
  );
}

export function BulkBar({
  cards,
  statuses,
  role,
  busy,
  result,
  onMove,
  onClear,
  onDismissResult,
}: {
  // The selected cards, in list order.
  cards: BulkCard[];
  statuses: StatusView[];
  role: Role;
  busy: boolean;
  result: BulkResult | null;
  onMove: (statusKey: string) => Promise<void>;
  onClear: () => void;
  onDismissResult: () => void;
}) {
  const [target, setTarget] = useState<StatusView | null>(null);
  // Reject has its own step with a reason; it is never a bulk move.
  const options = statuses.filter((status) => status.shopifyLink !== "draft_rejected");
  if (cards.length === 0 && !result) {
    return null;
  }
  const controls =
    cards.length > 0 && target ? (
      <BulkConfirm
        target={target}
        plan={planBulkMove(cards, target, statuses, role)}
        busy={busy}
        onConfirm={async () => {
          await onMove(target.key);
          setTarget(null);
        }}
        onCancel={() => setTarget(null)}
      />
    ) : cards.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-ink" aria-live="polite">
          {`${cards.length} selected`}
        </p>
        <div className="relative ml-auto">
          <label htmlFor="bulk-status" className="sr-only">
            Move the selected cards to
          </label>
          <select
            id="bulk-status"
            value=""
            onChange={(event) => {
              const next = options.find((status) => status.key === event.target.value);
              if (next) {
                setTarget(next);
              }
            }}
            className={`${ui.input} w-auto cursor-pointer appearance-none pr-9 font-medium`}
          >
            <option value="" disabled>
              Move to a status
            </option>
            {options.map((status) => (
              <option key={status.key} value={status.key}>
                {status.label}
              </option>
            ))}
          </select>
          <CaretDownIcon size={12} aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-2" />
        </div>
        <button type="button" onClick={onClear} className={ui.buttonQuiet}>
          Clear
        </button>
        <p className="w-full text-xs text-ink-2">
          {`Up to ${BULK_STATUS_MAX} at a time.`}
          <span className="max-desk:hidden"> Shift-click selects a range.</span>
        </p>
      </div>
    ) : null;
  return (
    // z-20: under the top bar (z-30), the drawer (z-40) and toasts (z-50);
    // the open drawer makes it inert with the rest of the page.
    <div className="fixed inset-x-0 bottom-0 z-20 flex max-h-[60dvh] flex-col border-t border-line bg-surface shadow-lift">
      {result ? (
        <div className={`mx-auto w-full max-w-[1400px] px-4 pt-3 sm:px-6 ${controls ? "" : SAFE_BOTTOM}`}>
          <InlineMessage
            tone={result.tone === "good" ? "good" : "warn"}
            action={
              <button type="button" onClick={onDismissResult} className={`${ui.iconButton} size-9 text-tone-text`}>
                <XIcon size={16} aria-hidden />
                <span className="sr-only">Dismiss</span>
              </button>
            }
          >
            {result.text}
            {result.refusals.length > 0 ? (
              // Focusable so a keyboard can scroll it when it overflows.
              <ul
                aria-label="Cards that did not move"
                tabIndex={0}
                className="mt-1 max-h-28 list-disc overflow-y-auto overscroll-contain pl-5"
              >
                {groupRefusals(result.refusals).map(({ error, names }) => {
                  const named = names.filter((name): name is string => name !== null);
                  return names.length === 1 ? (
                    <li key={error}>{`${names[0] ?? "A card"}: ${error}`}</li>
                  ) : (
                    <li key={error}>
                      {`${names.length} cards did not move: ${error}`}
                      {named.length > 0 ? <span className="block text-xs">{named.join(", ")}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </InlineMessage>
        </div>
      ) : null}
      {controls ? (
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <div className={`mx-auto max-w-[1400px] px-4 pt-3 sm:px-6 ${SAFE_BOTTOM}`}>{controls}</div>
        </div>
      ) : null}
    </div>
  );
}
