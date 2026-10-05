import { describe, it, expect } from "vitest";
import type { SyncConnectionView } from "@/server/desk/sync";
import { syncChipState } from "./sync-status";

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
    expect(syncChipState({ status: "ready", connection: null }, NOW)).toMatchObject({
      tone: "neutral",
      label: "Store not connected",
      detail: null,
    });
  });

  it("shows a healthy connection with the relative sync time", () => {
    expect(syncChipState({ status: "ready", connection: connection() }, NOW)).toMatchObject({
      tone: "good",
      label: "Synced 4 min ago",
      detail: null,
    });
  });

  it("puts a connection error first, with its text", () => {
    expect(
      syncChipState(
        { status: "ready", connection: connection({ status: "error", lastError: "Shopify rejected the token." }) },
        NOW,
      ),
    ).toMatchObject({ tone: "bad", label: "Sync error", detail: "Shopify rejected the token." });
  });

  it("flags a failed last run on an otherwise healthy connection", () => {
    expect(
      syncChipState({ status: "ready", connection: connection({ lastError: "Shopify timed out" }) }, NOW),
    ).toMatchObject({ tone: "warn", label: "Last sync failed", detail: "Shopify timed out" });
  });

  it("shows catching up while a backlog drains, and paused and never-synced states", () => {
    expect(
      syncChipState({ status: "ready", connection: connection({ catchingUp: true, lastSyncAt: 0 }) }, NOW),
    ).toMatchObject({ tone: "info", label: "Catching up" });
    expect(syncChipState({ status: "ready", connection: connection({ status: "disabled" }) }, NOW)).toMatchObject({
      tone: "neutral",
      label: "Sync paused",
    });
    expect(syncChipState({ status: "ready", connection: connection({ lastSyncAt: 0 }) }, NOW)).toMatchObject({
      tone: "neutral",
      label: "Not synced yet",
    });
  });
});
