// What the top bar's sync chip says, from GET /api/workspaces/[id]/sync.
// Pure so every state is tested; the chip, the account menu and the problem
// banner all read it.

import type { SyncConnectionView } from "@/server/desk/sync";
import { relativeTime } from "./format";

export type SyncLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; connection: SyncConnectionView | null };

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
