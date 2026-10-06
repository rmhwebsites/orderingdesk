// What the top bar's sync chip says, from GET /api/workspaces/[id]/sync.
// Pure so every state is tested; the chip, the account menu and the problem
// banner all read it. startSyncRechecks keeps the provider's copy fresh.

import type { SyncConnectionView } from "@/server/desk/sync";
import { relativeTime } from "./format";

export type SyncLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  // checkedAt: when this answer arrived (this browser's clock).
  | { status: "ready"; connection: SyncConnectionView | null; checkedAt: number };

export type ChipTone = "good" | "warn" | "bad" | "info" | "neutral";

export type SyncChipState =
  | { kind: "loading" }
  | {
      kind: "ready";
      tone: ChipTone;
      label: string;
      // Problem text for the banner under the top bar (the last error).
      detail: string | null;
      // What to do about a late sync (the chip's tooltip, the account menu).
      tip: string | null;
    };

// The automatic sync runs every 10 minutes: half an hour without one is
// late, three hours means orders may be missing (comprehensive desk design
// section 1).
export const SYNC_LATE_MS = 30 * 60 * 1000;
export const SYNC_STALE_MS = 3 * 60 * 60 * 1000;

// The cron moves lastSyncAt forward every 10 minutes even when nothing
// changed, but only a run that landed orders is broadcast to open desks
// (orders.synced). So an open desk re-reads the status every
// SYNC_RECHECK_MS while it is visible (startSyncRechecks), which keeps its
// copy at most about 10 + 5 minutes old, well inside SYNC_LATE_MS. A copy
// that has missed two rechecks (a background tab, a phone resumed after
// hours) no longer says how late the sync is now: the chip waits for the
// fresh answer instead of raising a false alarm.
export const SYNC_RECHECK_MS = 5 * 60 * 1000;
export const SYNC_COPY_MAX_AGE_MS = 2 * SYNC_RECHECK_MS;

const LATE_TIP = "The automatic sync runs every 10 minutes and is late. Press Sync to fetch new orders now.";
const STALE_TIP =
  "Orders may be missing: the automatic sync has not finished for hours. Press Sync, and if it fails, check the store connection in Settings.";

// Status tone names in globals.css for each chip tone.
export const CHIP_TONE_COLOR: Record<ChipTone, string> = {
  good: "green",
  warn: "amber",
  bad: "red",
  info: "blue",
  neutral: "slate",
};

function ready(tone: ChipTone, label: string, detail: string | null = null, tip: string | null = null): SyncChipState {
  return { kind: "ready", tone, label, detail, tip };
}

export function syncChipState(state: SyncLoadState, now: number): SyncChipState {
  if (state.status === "loading") {
    return { kind: "loading" };
  }
  if (state.status === "error") {
    return ready("warn", "Sync status unavailable");
  }
  const connection = state.connection;
  if (!connection) {
    return ready("neutral", "Store not connected");
  }
  if (connection.status === "disabled") {
    return ready("neutral", "Sync paused");
  }
  if (connection.status === "error") {
    return ready("bad", "Sync error", connection.lastError);
  }
  if (connection.lastError) {
    return ready("warn", "Last sync failed", connection.lastError);
  }
  if (connection.catchingUp) {
    return ready("info", "Catching up");
  }
  if (connection.lastSyncAt === 0) {
    return ready("neutral", "Not synced yet");
  }
  // What the copy says outright (above) stays true until a later answer
  // replaces it; only its age keeps changing after it arrives.
  if (now - state.checkedAt > SYNC_COPY_MAX_AGE_MS) {
    return ready("neutral", "Checking sync");
  }
  const label = `Synced ${relativeTime(connection.lastSyncAt, now)}`;
  const elapsed = now - connection.lastSyncAt;
  if (elapsed >= SYNC_STALE_MS) {
    return ready("bad", label, null, STALE_TIP);
  }
  if (elapsed >= SYNC_LATE_MS) {
    return ready("warn", label, null, LATE_TIP);
  }
  return ready("good", label);
}

// A re-read that failed: keep showing the last good answer through a blip,
// but once that answer is too old to vouch for, say the status is
// unavailable rather than keep checking forever.
export function syncAfterFailedCheck(current: SyncLoadState, message: string, now: number): SyncLoadState {
  if (current.status === "ready" && now - current.checkedAt <= SYNC_COPY_MAX_AGE_MS) {
    return current;
  }
  return { status: "error", message };
}

// The page's visibility, as document provides it (a stand-in in tests).
export type PageVisibility = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

// Calls reload every SYNC_RECHECK_MS while the page is visible, and at once
// when it comes back into view. Returns the function that stops it.
export function startSyncRechecks(reload: () => void, page: PageVisibility): () => void {
  function recheckIfVisible() {
    if (page.visibilityState === "visible") {
      reload();
    }
  }
  const timer = setInterval(recheckIfVisible, SYNC_RECHECK_MS);
  page.addEventListener("visibilitychange", recheckIfVisible);
  return () => {
    clearInterval(timer);
    page.removeEventListener("visibilitychange", recheckIfVisible);
  };
}
