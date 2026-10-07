"use client";

import { Spinner } from "@/components/kit";
import { ui } from "@/components/ui";

// The rest of history, one page at a time. Busy keeps full opacity
// (aria-busy, not disabled), like every busy button since Wave 1a.
export function LoadMore({ remaining, busy, onLoad }: { remaining: number; busy: boolean; onLoad: () => void }) {
  if (remaining <= 0) {
    return null;
  }
  return (
    <div className="flex justify-center py-2">
      <button
        type="button"
        onClick={() => {
          if (!busy) {
            onLoad();
          }
        }}
        aria-busy={busy || undefined}
        className={`${ui.buttonSecondary} min-h-11 min-w-48`}
      >
        {busy ? <Spinner /> : null}
        {busy ? "Loading older cards" : `Show older cards (${remaining.toLocaleString("en-US")} more)`}
      </button>
    </div>
  );
}
