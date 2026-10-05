// The order history import as Settings shows it (the server side is
// src/server/sync/backfill.ts): the date field, the range in words and the
// summary of the last import. Pure, so it is tested without a browser.

import type { BackfillView } from "@/server/sync/backfill";
import { APP_NAME } from "./brand";

// How far back Shopify serves orders to an app without read_all_orders
// (FIRST_SYNC_WINDOW_MS on the server; a test keeps the two equal).
export const HISTORY_WITHOUT_ALL_ORDERS_MS = 60 * 24 * 60 * 60 * 1000;

const DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// A date field's value (YYYY-MM-DD) as the start of that day in the
// viewer's time zone, or null when it is not a real date.
export function startOfLocalDay(value: string): number | null {
  const parts = value.match(DATE_VALUE);
  if (!parts) {
    return null;
  }
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

// The viewer's calendar date of a moment, as a date field value.
export function dateInputValue(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The newest start date the import takes: yesterday (orders from the last
// day are the regular sync's).
export function latestStartDate(now: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() - 1);
  return dateInputValue(date.getTime());
}

export function rangeNeedsAllOrders(since: number | null, now: number): boolean {
  return since === null || since < now - HISTORY_WITHOUT_ALL_ORDERS_MS;
}

// formatDate is null until the page has mounted: dates are shown in the
// viewer's time zone, which the server render cannot know.
type DateFormat = ((ms: number) => string) | null;

export function historyRangeLabel(since: number | null, formatDate: DateFormat): string {
  if (since === null) {
    return "all orders";
  }
  return formatDate ? `orders since ${formatDate(since)}` : "orders since the chosen date";
}

function orders(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "order" : "orders"}`;
}

// What the last import came to, or null before the first one and while one
// is running (the running state has its own view).
export function historySummary(
  view: BackfillView,
  formatDate: DateFormat,
): { tone: "good" | "info" | "bad"; text: string } | null {
  const when = (verb: string) => (formatDate && view.finishedAt !== null ? `${verb} ${formatDate(view.finishedAt)}` : verb);
  const range = historyRangeLabel(view.since, formatDate);
  switch (view.status) {
    case "done":
      if (view.imported === 0) {
        return {
          tone: "good",
          text: `${when("Finished")}. Every order in that range (${range}) was already in ${APP_NAME}.`,
        };
      }
      return {
        tone: "good",
        text: `Imported ${orders(view.imported)} (${range}).${formatDate && view.finishedAt !== null ? ` ${when("Finished")}.` : ""}`,
      };
    case "cancelled":
      return { tone: "info", text: `${when("Import stopped")} after ${orders(view.imported)}. Those orders stay.` };
    case "failed":
      return {
        tone: "bad",
        text: `${when("Import failed")} after ${orders(view.imported)}${view.error ? `: ${view.error}` : "."}`,
      };
    default:
      return null;
  }
}
