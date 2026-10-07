"use client";

import Link from "next/link";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { ClipboardTextIcon } from "@phosphor-icons/react/ClipboardText";
import { CloudSlashIcon } from "@phosphor-icons/react/CloudSlash";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { PauseIcon } from "@phosphor-icons/react/Pause";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { APP_NAME } from "@/lib/brand";
import type { BrandImages } from "@/lib/brand-assets";
import { roleAtLeast } from "@/lib/roles";
import { CHIP_TONE_COLOR, syncChipState, type ChipTone } from "@/lib/sync-status";
import { useNow } from "@/lib/use-now";
import type { AccountView } from "@/server/account";
import { ui } from "@/components/ui";
import { AccountMenu, type AccountSync } from "./account-menu";
import { Bell } from "./bell";
import { useWorkspace } from "./workspace-provider";
import { WorkspaceBrandSlot } from "./workspace-brand-slot";
import { WorkspaceNav } from "./workspace-nav";

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
  if (label === "Checking sync") {
    return <ArrowsClockwiseIcon size={14} aria-hidden />;
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

// The sync state: from sm up, and at every width when something is wrong
// (phones also get it in the account menu). Its words from md: below it
// the icon and tone carry it (the words are in the account menu below lg),
// so the workspace name keeps room beside Desk, People and Locations.
function SyncChip() {
  const { sync, liveStatus } = useWorkspace();
  const now = useNow(30000);
  const state = syncChipState(sync, now || Date.now());

  if (state.kind === "loading") {
    return <span className="od-skeleton hidden h-8 w-8 sm:block md:w-36" aria-label="Loading sync status" />;
  }
  // A quiet state stays hidden on phones; a problem shows at every width,
  // as its icon below md.
  const quiet = state.tone === "good" || state.tone === "neutral" || state.tone === "info";
  return (
    // shrink-0: the chip never collapses below its icon and label; a long
    // workspace name truncates instead.
    <span
      data-tone={CHIP_TONE_COLOR[state.tone]}
      title={state.tip ?? LIVE_TEXT[liveStatus]}
      className={`${quiet ? "hidden sm:inline-flex" : "inline-flex"} h-8 shrink-0 items-center gap-1.5 rounded-control bg-tone-fill px-2.5 text-xs font-semibold text-tone-text md:px-3`}
    >
      {chipIcon(state.tone, state.label)}
      <span className="sr-only md:not-sr-only">{state.label}</span>
      {state.tip ? <span className="sr-only">. {state.tip}</span> : null}
      <span className="sr-only">. {LIVE_TEXT[liveStatus]}.</span>
    </span>
  );
}

// From lg; below it, Sync now lives in the account menu.
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
      aria-busy={manual.running || undefined}
      aria-label={coolingDown ? `Sync available in ${waitSeconds} seconds` : "Sync orders from Shopify now"}
      className={`${ui.buttonPrimary} h-9 min-w-[6.5rem] tabular-nums max-lg:hidden`}
    >
      <ArrowsClockwiseIcon size={16} aria-hidden className={manual.running ? "od-spin" : undefined} />
      {label}
    </button>
  );
}

// Managers and platform admins: the approval queue, with how many wait.
// Below lg a 40px icon with the count on its corner, like the bell's: inline
// it was 66px, and a phone row with a sync problem chip ran 25px over and
// slid the workspace symbol under Desk.
function ApprovalLink() {
  const { workspace, role, needsApproval } = useWorkspace();
  if (!roleAtLeast(role, "manager")) {
    return null;
  }
  const count = needsApproval ?? 0;
  const href = `${workspace.basePath === "" ? "/" : workspace.basePath}?view=approval`;
  return (
    <Link
      href={href}
      aria-label={count > 0 ? `Needs approval, ${count} waiting` : "Needs approval"}
      className={`${ui.buttonQuiet} relative h-10 max-lg:w-10 max-lg:px-0`}
    >
      <ClipboardTextIcon size={18} aria-hidden />
      <span aria-hidden className="max-lg:hidden">
        Needs approval
      </span>
      {count > 0 ? (
        <span
          aria-hidden
          className="grid h-5 min-w-5 place-items-center rounded-control bg-primary px-1 text-xs font-semibold tabular-nums text-primary-ink max-lg:absolute max-lg:right-0 max-lg:top-0 max-lg:ring-2 max-lg:ring-surface"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}

// The account menu with this workspace's Settings and Sync now.
function WorkspaceAccount({ account }: { account: AccountView }) {
  const { workspace, sync, manual, runManualSync } = useWorkspace();
  const now = useNow(30000);
  const state = syncChipState(sync, now || Date.now());
  const coolingDown = now > 0 && manual.cooldownUntil > now;
  const syncItem: AccountSync | null =
    state.kind === "ready"
      ? { label: state.label, tip: state.tip, running: manual.running, disabled: manual.running || coolingDown, onSync: runManualSync }
      : null;
  return <AccountMenu account={account} settingsHref={`${workspace.basePath}/settings`} sync={syncItem} />;
}

// One 56px row at every width: the workspace (its name truncates first;
// phones show its symbol only), Desk, People and Locations (icons only
// below xl), the sync chip from sm (its words from md), the Sync button
// from lg, Needs approval for those who approve (its label from lg),
// Settings from sm, the bell, and the account menu last so its panel,
// right aligned to it, stays on screen.
export function TopBar({ name, images, account }: { name: string; images: BrandImages; account: AccountView }) {
  const { workspace } = useWorkspace();
  return (
    // z-30: the top layer of the page itself; the drawer (z-40) and toasts
    // (z-50) sit above it.
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-6">
        {/* On a client host "/" is this workspace itself; on the hub it
            is the workspace list. */}
        <Link
          href="/"
          title={workspace.basePath === "" ? "Orders" : "All workspaces"}
          className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-control p-1 lg:flex-initial"
        >
          <WorkspaceBrandSlot name={name} images={images} />
          {/* Phones keep the symbol only, so the workspace links fit the
              row; the name stays for screen readers. */}
          <span className="min-w-0 max-sm:sr-only">
            <span className="block truncate font-display text-[15px] font-semibold leading-tight text-ink">{name}</span>
            <span className="block truncate text-xs leading-tight text-ink-2">{APP_NAME}</span>
          </span>
        </Link>

        <WorkspaceNav />

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <SyncChip />
          <SyncButton />
          <ApprovalLink />
          {/* Every member: each role sees its own Settings sections. */}
          <Link href={`${workspace.basePath}/settings`} className={`${ui.buttonQuiet} h-10 max-sm:hidden`}>
            <GearSixIcon size={18} aria-hidden />
            <span className="sr-only lg:not-sr-only">Settings</span>
          </Link>
          <Bell />
          <WorkspaceAccount account={account} />
        </div>
      </div>
    </header>
  );
}
