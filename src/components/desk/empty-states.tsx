"use client";

import Link from "next/link";
import { ListMagnifyingGlassIcon } from "@phosphor-icons/react/ListMagnifyingGlass";
import { StorefrontIcon } from "@phosphor-icons/react/Storefront";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { ui } from "@/components/ui";
import { SETTINGS_PAGE_AVAILABLE } from "@/lib/features";

function Frame({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-panel border border-line bg-surface px-6 py-10 shadow-panel sm:items-center sm:px-10 sm:py-14 sm:text-center">
      <span className="grid size-12 place-items-center rounded-control bg-surface-2 text-ink-2">{icon}</span>
      <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
      {children}
    </div>
  );
}

// No orders at all yet: say exactly how to get some.
// The Settings link stays hidden until the settings page exists (see
// SETTINGS_PAGE_AVAILABLE); the settings stage restores it, for platform
// admins only, since connecting the store is theirs.
export function EmptyDesk({ basePath }: { basePath: string }) {
  return (
    <Frame icon={<StorefrontIcon size={24} aria-hidden />} title="No orders yet">
      <p className="max-w-[46ch] text-sm text-ink-2">
        Orders appear here once the Shopify store is connected. After that, press Sync or wait for the next automatic sync.
      </p>
      {SETTINGS_PAGE_AVAILABLE ? (
        <Link href={`${basePath}/settings`} className={`${ui.buttonSecondary} mt-1`}>
          Open Settings
        </Link>
      ) : null}
    </Frame>
  );
}

export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <Frame icon={<ListMagnifyingGlassIcon size={24} aria-hidden />} title="No orders match">
      <p className="max-w-[46ch] break-words text-sm text-ink-2">
        {query.trim().length > 0
          ? `Nothing matches "${query.trim()}" with the current status filter.`
          : "No loaded orders have this status."}
      </p>
      <button type="button" onClick={onClear} className={`${ui.buttonSecondary} mt-1`}>
        Clear filters
      </button>
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
