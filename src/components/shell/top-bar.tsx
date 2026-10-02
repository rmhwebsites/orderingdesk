"use client";

import Link from "next/link";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CloudSlashIcon } from "@phosphor-icons/react/CloudSlash";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { PauseIcon } from "@phosphor-icons/react/Pause";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { APP_NAME } from "@/lib/brand";
import { CHIP_TONE_COLOR, syncChipState, type ChipTone } from "@/lib/sync-status";
import { useNow } from "@/lib/use-now";
import { ThemeToggle } from "@/components/theme-toggle";
import { ui } from "@/components/ui";
import { useWorkspace } from "./workspace-provider";
import { WorkspaceBrandSlot } from "./workspace-brand-slot";
import { SETTINGS_PAGE_AVAILABLE } from "@/lib/features";

const LIVE_TEXT = {
  live: "Live updates on",
  connecting: "Connecting live updates",
  offline: "Live updates paused; checking every 30 seconds",
} as const;

function chipIcon(tone: ChipTone, label: string) {
  if (label === "Catching up") {
    return <ArrowsClockwiseIcon size={14} aria-hidden className="od-spin" />;
  }
  if (label === "Sync paused") {
    return <PauseIcon size={14} aria-hidden />;
  }
  switch (tone) {
    case "good":
      return <CheckCircleIcon size={14} aria-hidden />;
    case "warn":
      return <WarningIcon size={14} aria-hidden />;
    case "bad":
      return <WarningCircleIcon size={14} aria-hidden />;
    default:
      return <CloudSlashIcon size={14} aria-hidden />;
  }
}

function SyncChip() {
  const { sync, liveStatus } = useWorkspace();
  const now = useNow(30000);
  const state = syncChipState(sync, now || Date.now());

  if (state.kind === "loading") {
    return <span className="od-skeleton h-8 w-36" aria-label="Loading sync status" />;
  }
  return (
    <span
      data-tone={CHIP_TONE_COLOR[state.tone]}
      title={LIVE_TEXT[liveStatus]}
      className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-tone-fill px-3 text-xs font-semibold text-tone-text"
    >
      {chipIcon(state.tone, state.label)}
      <span className="truncate">{state.label}</span>
      <span className="sr-only">. {LIVE_TEXT[liveStatus]}.</span>
    </span>
  );
}

function SyncButton() {
  const { manual, runManualSync } = useWorkspace();
  const now = useNow(1000);
  const waitSeconds = now > 0 ? Math.ceil((manual.cooldownUntil - now) / 1000) : 0;
  const coolingDown = waitSeconds > 0;
  const label = manual.running ? "Syncing" : coolingDown ? `Wait ${waitSeconds}s` : "Sync";

  return (
    <button
      type="button"
      onClick={runManualSync}
      disabled={manual.running || coolingDown}
      aria-label={coolingDown ? `Sync available in ${waitSeconds} seconds` : "Sync orders from Shopify now"}
      className={`${ui.buttonPrimary} h-9 min-w-[6.5rem] tabular-nums`}
    >
      <ArrowsClockwiseIcon size={16} aria-hidden className={manual.running ? "od-spin" : undefined} />
      {label}
    </button>
  );
}

export function TopBar({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const { workspace } = useWorkspace();
  return (
    // z-30: the top layer of the page itself; the drawer (z-40) and toasts
    // (z-50) sit above it.
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:flex-nowrap sm:px-6">
        {/* On a client host "/" is this workspace itself; on the hub it
            is the workspace list. */}
        <Link
          href="/"
          title={workspace.basePath === "" ? "Orders" : "All workspaces"}
          className="order-1 -m-1 flex min-w-0 flex-1 items-center gap-3 rounded-full p-1 sm:flex-none"
        >
          <WorkspaceBrandSlot name={name} logoUrl={logoUrl} />
          <span className="min-w-0">
            <span className="block truncate font-display text-[15px] font-semibold leading-tight text-ink">
              {name}
            </span>
            <span className="block text-xs leading-tight text-ink-2">{APP_NAME}</span>
          </span>
        </Link>

        <div className="order-3 flex w-full min-w-0 items-center justify-between gap-2 sm:order-2 sm:ml-auto sm:w-auto sm:justify-end">
          <SyncChip />
          <SyncButton />
        </div>

        <div className="order-2 flex items-center gap-1 sm:order-3">
          <ThemeToggle />
          {/* Hidden for everyone until the settings page exists. SETTINGS
              STAGE: restore it through SETTINGS_PAGE_AVAILABLE in
              src/lib/features.ts. */}
          {SETTINGS_PAGE_AVAILABLE ? (
            <Link href={`${workspace.basePath}/settings`} className={`${ui.buttonQuiet} h-10`}>
              <GearSixIcon size={18} aria-hidden />
              <span className="sr-only sm:not-sr-only">Settings</span>
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}
