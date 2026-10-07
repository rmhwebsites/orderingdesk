// Calendar ranges in a workspace's time zone (design section 3: dates are
// computed on the server in the workspace time zone, never by the model).
// Pure; Intl does the zone math. Weeks start on Monday. Every range is
// [from, to): from inclusive, to exclusive, in ms. Relative imports only.

type DatePreset = "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month" | "last_7_days" | "last_30_days";

export const DEFAULT_TIME_ZONE = "America/New_York";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

type Parts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number };

function partsAt(ms: number, timeZone: string): Parts {
  const out: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    weekday: WEEKDAYS.indexOf(out.weekday),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

// How far the zone's wall clock is ahead of UTC at this instant, in ms.
function offsetAt(ms: number, timeZone: string): number {
  const p = partsAt(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

// The instant a calendar day starts in the zone. Day and month may overflow
// (day 0, month 13): Date.UTC carries them.
export function startOfDay(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

export type Day = { year: number; month: number; day: number; weekday: number };

export function todayIn(now: number, timeZone: string): Day {
  const p = partsAt(now, timeZone);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ymd(day: { year: number; month: number; day: number }): string {
  return `${day.year}-${pad(day.month)}-${pad(day.day)}`;
}

// "2026-10-05 (Monday)": what the model is told today is.
export function describeToday(now: number, timeZone: string): string {
  const today = todayIn(now, timeZone);
  return `${ymd(today)} (${DAY_NAMES[today.weekday]})`;
}

export function presetRange(preset: DatePreset, now: number, timeZone: string): { from: number; to: number } {
  const t = todayIn(now, timeZone);
  const day = (offset: number) => startOfDay(t.year, t.month, t.day + offset, timeZone);
  const sinceMonday = (t.weekday + 6) % 7;
  switch (preset) {
    case "today":
      return { from: day(0), to: day(1) };
    case "yesterday":
      return { from: day(-1), to: day(0) };
    case "this_week":
      return { from: day(-sinceMonday), to: day(7 - sinceMonday) };
    case "last_week":
      return { from: day(-sinceMonday - 7), to: day(-sinceMonday) };
    case "this_month":
      return { from: startOfDay(t.year, t.month, 1, timeZone), to: startOfDay(t.year, t.month + 1, 1, timeZone) };
    case "last_month":
      return { from: startOfDay(t.year, t.month - 1, 1, timeZone), to: startOfDay(t.year, t.month, 1, timeZone) };
    case "last_7_days":
      return { from: day(-6), to: day(1) };
    case "last_30_days":
      return { from: day(-29), to: day(1) };
  }
}

// Two YYYY-MM-DD dates (already validated), both days included.
export function customRange(from: string, to: string, timeZone: string): { from: number; to: number } {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return { from: startOfDay(fy, fm, fd, timeZone), to: startOfDay(ty, tm, td + 1, timeZone) };
}
