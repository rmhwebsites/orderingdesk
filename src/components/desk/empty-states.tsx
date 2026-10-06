"use client";

import { useId } from "react";
import Link from "next/link";
import { ListMagnifyingGlassIcon } from "@phosphor-icons/react/ListMagnifyingGlass";
import { StorefrontIcon } from "@phosphor-icons/react/Storefront";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { ui } from "@/components/ui";
import type { DeskView } from "@/lib/desk-query";
import type { DeskKind } from "@/lib/desk-state";

function Frame({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-panel border border-line bg-surface px-6 py-10 shadow-panel sm:items-center sm:px-10 sm:py-14 sm:text-center">
      <span className="grid size-12 place-items-center rounded-control bg-surface-2 text-ink-2">{icon}</span>
      <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
      {children}
    </div>
  );
}

// No orders at all yet: say exactly how to get some. The link to the store
// connection is for platform admins only, since connecting the store is
// theirs.
export function EmptyDesk({ basePath, canConnect }: { basePath: string; canConnect: boolean }) {
  return (
    <Frame icon={<StorefrontIcon size={24} aria-hidden />} title="No orders yet">
      <p className="max-w-[46ch] text-sm text-ink-2">
        Orders appear here once the Shopify store is connected. After that, press Sync or wait for the next automatic sync.
      </p>
      {canConnect ? (
        <Link href={`${basePath}/settings#store`} className={`${ui.buttonSecondary} mt-1`}>
          Connect the store
        </Link>
      ) : null}
    </Frame>
  );
}

// What an empty list says, by what emptied it: the view, the search, the
// status, and the All / Drafts / Orders / Deleted filter. Drafts plus New is
// the review queue (draft orders spec section 11.2), empty whenever every
// request has been handled, so it reads as a normal state, not a failed
// search. An empty view with nothing else filtering it says so in its own
// words (comprehensive desk design section 1).
function noMatchesCopy(
  query: string,
  kind: DeskKind,
  statusLabel: string | null,
  view: DeskView,
): { title: string; body: string } {
  if (query.length === 0 && kind === "all" && statusLabel === null) {
    switch (view) {
      case "open":
        return { title: "Nothing open", body: "Every card is in a closed status. New requests and orders land here." };
      case "approval":
        return { title: "No requests need approval", body: "New requests from the store show up here." };
      case "closed":
        return {
          title: "Nothing closed yet",
          body: "Cards move here when they reach a closed status, such as Delivered or Rejected.",
        };
      case "all":
        break;
    }
  }
  if (query.length > 0) {
    const where = statusLabel ? ` in ${statusLabel}` : "";
    const title = { all: "No orders match", drafts: "No requests match", orders: "No orders match", deleted: "No deleted requests match" }[kind];
    return { title, body: `Nothing matches "${query}"${where}.` };
  }
  switch (kind) {
    case "drafts":
      return statusLabel
        ? { title: "No requests have this status", body: `No requests are in ${statusLabel}.` }
        : { title: "No requests waiting", body: "New requests from the store show up here." };
    case "deleted":
      return statusLabel
        ? { title: "No deleted requests have this status", body: `No deleted requests are in ${statusLabel}.` }
        : { title: "No deleted requests", body: "Requests whose draft was deleted in Shopify show up here." };
    case "orders":
      return statusLabel
        ? { title: "No orders have this status", body: `No orders are in ${statusLabel}.` }
        : { title: "No orders yet", body: "Orders from the store, and requests once approved, show up here." };
    case "all":
      return {
        title: "No orders match",
        body: statusLabel ? "No loaded orders have this status." : "Nothing to show with the current filters.",
      };
  }
}

export function NoMatches({
  query,
  kind,
  statusLabel,
  view = "all",
  onClear,
}: {
  query: string;
  kind: DeskKind;
  // The label of the status picked in the strip, or null for every status.
  statusLabel: string | null;
  // The view the list shows (src/lib/desk-query.ts).
  view?: DeskView;
  // Clears the search and the status, and goes back to All.
  onClear: () => void;
}) {
  const copy = noMatchesCopy(query.trim(), kind, statusLabel, view);
  const hintId = useId();
  // Clear filters only when something besides the view filters the list.
  const canClear = query.trim().length > 0 || kind !== "all" || statusLabel !== null;
  return (
    <Frame icon={<ListMagnifyingGlassIcon size={24} aria-hidden />} title={copy.title}>
      <p className="max-w-[46ch] break-words text-sm text-ink-2">{copy.body}</p>
      {canClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-describedby={kind !== "all" ? hintId : undefined}
          className={`${ui.buttonSecondary} mt-1`}
        >
          Clear filters
        </button>
      ) : null}
      {canClear && kind !== "all" ? (
        <p id={hintId} className="max-w-[46ch] text-xs text-ink-2">
          Clear filters goes back to All, with no search or status.
        </p>
      ) : null}
    </Frame>
  );
}

export function DeskLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert">
      <Frame icon={<WarningCircleIcon size={24} aria-hidden />} title="Orders did not load">
        <p className="max-w-[46ch] text-sm text-ink-2">{message}</p>
        <button type="button" onClick={onRetry} className={`${ui.buttonSecondary} mt-1`}>
          Try again
        </button>
      </Frame>
    </div>
  );
}
