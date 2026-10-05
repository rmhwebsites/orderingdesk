import { describe, it, expect } from "vitest";
import { FIRST_SYNC_WINDOW_MS } from "@/server/sync/run";
import type { BackfillView } from "@/server/sync/backfill";
import {
  HISTORY_WITHOUT_ALL_ORDERS_MS,
  dateInputValue,
  historyRangeLabel,
  historySummary,
  latestStartDate,
  rangeNeedsAllOrders,
  startOfLocalDay,
} from "./order-history";

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function view(overrides: Partial<BackfillView>): BackfillView {
  return {
    status: "idle",
    since: null,
    imported: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    paused: null,
    canReadAllOrders: true,
    ...overrides,
  };
}

describe("order history dates", () => {
  it("reads a date field as the start of that day where the admin is", () => {
    const ms = startOfLocalDay("2025-03-01");
    expect(ms).toBe(new Date(2025, 2, 1).getTime());
    expect(dateInputValue(ms!)).toBe("2025-03-01");
  });

  it("refuses what is not a real calendar date", () => {
    for (const value of ["", "2025-02-30", "2025-13-01", "03/01/2025", "2025-3-1", "yesterday"]) {
      expect(startOfLocalDay(value), value).toBeNull();
    }
  });

  it("offers yesterday as the latest start date", () => {
    const now = new Date(2026, 9, 4, 0, 30).getTime();
    expect(latestStartDate(now)).toBe("2026-10-03");
  });

  it("knows when a range reaches back further than Shopify serves without read_all_orders", () => {
    expect(HISTORY_WITHOUT_ALL_ORDERS_MS).toBe(FIRST_SYNC_WINDOW_MS);
    const now = Date.parse("2026-10-04T12:00:00.000Z");
    expect(rangeNeedsAllOrders(null, now)).toBe(true);
    expect(rangeNeedsAllOrders(now - FIRST_SYNC_WINDOW_MS - 1, now)).toBe(true);
    expect(rangeNeedsAllOrders(now - FIRST_SYNC_WINDOW_MS + 60000, now)).toBe(false);
  });
});

describe("historySummary", () => {
  it("names the range", () => {
    expect(historyRangeLabel(null, fmt)).toBe("all orders");
    expect(historyRangeLabel(Date.parse("2025-03-01T00:00:00Z"), fmt)).toBe("orders since 2025-03-01");
    expect(historyRangeLabel(Date.parse("2025-03-01T00:00:00Z"), null)).toBe("orders since the chosen date");
  });

  it("has nothing to say before the first import or while one runs", () => {
    expect(historySummary(view({}), fmt)).toBeNull();
    expect(historySummary(view({ status: "running", imported: 4 }), fmt)).toBeNull();
  });

  it("sums up a finished import, including one that found nothing new", () => {
    const finishedAt = Date.parse("2026-10-03T10:00:00Z");
    expect(historySummary(view({ status: "done", imported: 1240, finishedAt }), fmt)).toEqual({
      tone: "good",
      text: "Imported 1,240 orders (all orders). Finished 2026-10-03.",
    });
    expect(historySummary(view({ status: "done", imported: 1, finishedAt, since: Date.parse("2025-03-01T00:00:00Z") }), fmt)).toEqual({
      tone: "good",
      text: "Imported 1 order (orders since 2025-03-01). Finished 2026-10-03.",
    });
    expect(historySummary(view({ status: "done", imported: 0, finishedAt }), fmt)).toEqual({
      tone: "good",
      text: "Finished 2026-10-03. Every order in that range (all orders) was already in Ordering Desk.",
    });
  });

  it("says what a stopped or failed import left behind", () => {
    const finishedAt = Date.parse("2026-10-03T10:00:00Z");
    expect(historySummary(view({ status: "cancelled", imported: 35, finishedAt }), fmt)).toEqual({
      tone: "info",
      text: "Import stopped 2026-10-03 after 35 orders. Those orders stay.",
    });
    expect(historySummary(view({ status: "failed", imported: 0, finishedAt, error: "Shopify said no" }), fmt)).toEqual({
      tone: "bad",
      text: "Import failed 2026-10-03 after 0 orders: Shopify said no",
    });
  });

  it("leaves dates out until they can be shown in the viewer's time zone", () => {
    expect(historySummary(view({ status: "done", imported: 2, finishedAt: 1 }), null)).toEqual({
      tone: "good",
      text: "Imported 2 orders (all orders).",
    });
  });
});
