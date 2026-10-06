import { describe, it, expect, vi, afterEach } from "vitest";
import type { SyncConnectionView } from "@/server/desk/sync";
import {
  SYNC_COPY_MAX_AGE_MS,
  SYNC_LATE_MS,
  SYNC_RECHECK_MS,
  startSyncRechecks,
  syncAfterFailedCheck,
  syncChipState,
  type SyncLoadState,
} from "./sync-status";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

function connection(overrides: Partial<SyncConnectionView> = {}): SyncConnectionView {
  return {
    shopDomain: "impact-rentals.myshopify.com",
    adminShopDomain: "impact-rentals.myshopify.com",
    status: "ok",
    lastSyncAt: NOW - 4 * 60000,
    lastError: null,
    catchingUp: false,
    ...overrides,
  };
}

// An answer from GET /api/workspaces/[id]/sync, received at checkedAt.
function answer(conn: SyncConnectionView | null, checkedAt: number = NOW): SyncLoadState {
  return { status: "ready", connection: conn, checkedAt };
}

describe("syncChipState", () => {
  it("is loading until the first answer", () => {
    expect(syncChipState({ status: "loading" }, NOW)).toEqual({ kind: "loading" });
  });

  it("says when the status could not be read", () => {
    expect(syncChipState({ status: "error", message: "offline" }, NOW)).toMatchObject({
      kind: "ready",
      tone: "warn",
      label: "Sync status unavailable",
    });
  });

  it("says when no store is connected", () => {
    expect(syncChipState(answer(null), NOW)).toMatchObject({
      tone: "neutral",
      label: "Store not connected",
      detail: null,
    });
  });

  it("shows a healthy connection with the relative sync time", () => {
    expect(syncChipState(answer(connection()), NOW)).toMatchObject({
      tone: "good",
      label: "Synced 4 min ago",
      detail: null,
    });
  });

  it("puts a connection error first, with its text", () => {
    expect(
      syncChipState(
        answer(connection({ status: "error", lastError: "Shopify rejected the token." })),
        NOW,
      ),
    ).toMatchObject({ tone: "bad", label: "Sync error", detail: "Shopify rejected the token." });
  });

  it("flags a failed last run on an otherwise healthy connection", () => {
    expect(
      syncChipState(answer(connection({ lastError: "Shopify timed out" })), NOW),
    ).toMatchObject({ tone: "warn", label: "Last sync failed", detail: "Shopify timed out" });
  });

  it("shows catching up while a backlog drains, and paused and never-synced states", () => {
    expect(
      syncChipState(answer(connection({ catchingUp: true, lastSyncAt: 0 })), NOW),
    ).toMatchObject({ tone: "info", label: "Catching up" });
    expect(syncChipState(answer(connection({ status: "disabled" })), NOW)).toMatchObject({
      tone: "neutral",
      label: "Sync paused",
    });
    expect(syncChipState(answer(connection({ lastSyncAt: 0 })), NOW)).toMatchObject({
      tone: "neutral",
      label: "Not synced yet",
    });
  });

  // Comprehensive desk design section 1: an old sync must not look healthy.
  it("turns amber after 30 minutes and red after 3 hours, with a tip", () => {
    const at = (minutesAgo: number) =>
      syncChipState(answer(connection({ lastSyncAt: NOW - minutesAgo * 60000 })), NOW);
    expect(at(29)).toMatchObject({ tone: "good", label: "Synced 29 min ago", tip: null });
    const late = at(30);
    expect(late).toMatchObject({ tone: "warn", label: "Synced 30 min ago", detail: null });
    expect(late.kind === "ready" ? late.tip : "").toContain("Press Sync");
    const old = at(17 * 60);
    expect(old).toMatchObject({ tone: "bad", label: "Synced 17 h ago", detail: null });
    expect(old.kind === "ready" ? old.tip : "").toContain("check the store connection");
  });

  // The cron moves lastSyncAt forward every 10 minutes even when nothing
  // changed, but only a run that landed orders is broadcast to open desks,
  // so an open desk re-reads the status every SYNC_RECHECK_MS. A copy read
  // once and left to age turned a healthy, quiet store amber within the
  // half hour.
  it("never looks late on a healthy store with no new orders, between rechecks", () => {
    const CRON_MS = 10 * 60000;
    // The server's answer at t: the window before the current one, as if the
    // current run had not finished yet (the oldest a healthy answer gets).
    const serverLastSyncAt = (t: number) => Math.floor(t / CRON_MS) * CRON_MS - CRON_MS;
    const start = NOW - 24 * 3600000;
    let copy = answer(connection({ lastSyncAt: serverLastSyncAt(start) }), start);
    for (let t = start; t <= NOW; t += 60000) {
      if ((t - start) % SYNC_RECHECK_MS === 0) {
        copy = answer(connection({ lastSyncAt: serverLastSyncAt(t) }), t);
      }
      expect(syncChipState(copy, t)).toMatchObject({ tone: "good" });
    }
    expect(SYNC_RECHECK_MS).toBe(5 * 60000);
  });

  // A copy that missed two rechecks (a background tab, a phone resumed after
  // hours) cannot say how late the sync is now; the fresh answer decides.
  it("waits for a fresh answer instead of raising an alarm on a copy too old to vouch for", () => {
    expect(SYNC_COPY_MAX_AGE_MS).toBe(2 * SYNC_RECHECK_MS);
    const resumed = answer(connection({ lastSyncAt: NOW - 5 * 3600000 - 4 * 60000 }), NOW - 5 * 3600000);
    expect(syncChipState(resumed, NOW)).toMatchObject({ tone: "neutral", label: "Checking sync", tip: null });

    const lastSyncAt = NOW - SYNC_LATE_MS - 60000;
    expect(syncChipState(answer(connection({ lastSyncAt }), NOW - SYNC_COPY_MAX_AGE_MS), NOW)).toMatchObject({
      tone: "warn",
    });
    expect(syncChipState(answer(connection({ lastSyncAt }), NOW - SYNC_COPY_MAX_AGE_MS - 1), NOW)).toMatchObject({
      label: "Checking sync",
    });
    // A fresh answer that is still late is late.
    expect(syncChipState(answer(connection({ lastSyncAt: NOW - 5 * 3600000 }), NOW - 60000), NOW)).toMatchObject({
      tone: "bad",
    });
    // What an old copy says outright still shows: only its age goes stale.
    expect(
      syncChipState(answer(connection({ lastError: "Shopify timed out" }), NOW - 5 * 3600000), NOW),
    ).toMatchObject({ tone: "warn", label: "Last sync failed" });
  });
});

describe("syncAfterFailedCheck", () => {
  it("keeps the last good answer through a blip, and says the status is unavailable once it is too old", () => {
    const fresh = answer(connection(), NOW - 60000);
    expect(syncAfterFailedCheck(fresh, "HTTP 503", NOW)).toBe(fresh);
    expect(syncAfterFailedCheck(answer(connection(), NOW - SYNC_COPY_MAX_AGE_MS - 1), "HTTP 503", NOW)).toEqual({
      status: "error",
      message: "HTTP 503",
    });
    expect(syncAfterFailedCheck({ status: "loading" }, "offline", NOW)).toEqual({ status: "error", message: "offline" });
  });
});

describe("startSyncRechecks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads every 5 minutes while the page is visible, and at once when it comes back into view", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const reload = vi.fn();
    const stop = startSyncRechecks(reload, page);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SYNC_RECHECK_MS);
    expect(reload).toHaveBeenCalledTimes(1);

    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(3 * SYNC_RECHECK_MS);
    expect(reload).toHaveBeenCalledTimes(1);

    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(reload).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(3 * SYNC_RECHECK_MS);
    page.dispatchEvent(new Event("visibilitychange"));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
