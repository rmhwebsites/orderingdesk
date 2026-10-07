import { describe, it, expect } from "vitest";
import { customRange, describeToday, isTimeZone, presetRange, startOfDay } from "./date-range";

const NY = "America/New_York";
// Monday, October 5, 2026, 10:00 in New York (EDT, UTC-4).
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const iso = (range: { from: number; to: number }) => [new Date(range.from).toISOString(), new Date(range.to).toISOString()];

describe("startOfDay", () => {
  it("finds local midnight on both sides of a daylight saving change", () => {
    expect(new Date(startOfDay(2026, 10, 5, NY)).toISOString()).toBe("2026-10-05T04:00:00.000Z");
    expect(new Date(startOfDay(2026, 11, 1, NY)).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(startOfDay(2026, 11, 2, NY)).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(new Date(startOfDay(2026, 3, 9, NY)).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(new Date(startOfDay(2026, 13, 1, NY)).toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });
});

describe("presetRange", () => {
  it("computes every preset in the workspace's zone, weeks from Monday", () => {
    expect(iso(presetRange("today", NOW, NY))).toEqual(["2026-10-05T04:00:00.000Z", "2026-10-06T04:00:00.000Z"]);
    expect(iso(presetRange("yesterday", NOW, NY))).toEqual(["2026-10-04T04:00:00.000Z", "2026-10-05T04:00:00.000Z"]);
    expect(iso(presetRange("this_week", NOW, NY))).toEqual(["2026-10-05T04:00:00.000Z", "2026-10-12T04:00:00.000Z"]);
    expect(iso(presetRange("last_week", NOW, NY))).toEqual(["2026-09-28T04:00:00.000Z", "2026-10-05T04:00:00.000Z"]);
    expect(iso(presetRange("this_month", NOW, NY))).toEqual(["2026-10-01T04:00:00.000Z", "2026-11-01T04:00:00.000Z"]);
    expect(iso(presetRange("last_month", NOW, NY))).toEqual(["2026-09-01T04:00:00.000Z", "2026-10-01T04:00:00.000Z"]);
    expect(iso(presetRange("last_7_days", NOW, NY))).toEqual(["2026-09-29T04:00:00.000Z", "2026-10-06T04:00:00.000Z"]);
    expect(iso(presetRange("last_30_days", NOW, NY))).toEqual(["2026-09-06T04:00:00.000Z", "2026-10-06T04:00:00.000Z"]);
  });

  it("follows the zone's calendar, not UTC's, late in the evening and across DST", () => {
    // 23:30 on Sunday Oct 4 in New York is already Monday in UTC.
    const lateSunday = Date.parse("2026-10-05T03:30:00.000Z");
    expect(iso(presetRange("today", lateSunday, NY))).toEqual(["2026-10-04T04:00:00.000Z", "2026-10-05T04:00:00.000Z"]);
    expect(iso(presetRange("this_month", Date.parse("2026-11-03T15:00:00.000Z"), NY))).toEqual([
      "2026-11-01T04:00:00.000Z",
      "2026-12-01T05:00:00.000Z",
    ]);
    expect(iso(presetRange("today", NOW, "UTC"))).toEqual(["2026-10-05T00:00:00.000Z", "2026-10-06T00:00:00.000Z"]);
  });
});

describe("customRange and describeToday", () => {
  it("covers whole days from the first to the last date", () => {
    expect(iso(customRange("2026-09-01", "2026-09-30", NY))).toEqual(["2026-09-01T04:00:00.000Z", "2026-10-01T04:00:00.000Z"]);
    expect(describeToday(NOW, NY)).toBe("2026-10-05 (Monday)");
  });
});

describe("isTimeZone", () => {
  it("accepts IANA zones the runtime knows and nothing else", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(42)).toBe(false);
  });
});
