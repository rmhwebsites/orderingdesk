import { describe, it, expect } from "vitest";
import * as schema from "@/db/schema";
import { AI_SEARCH_DAILY_CAP, AI_SEARCH_WORKSPACE_DAILY_CAP, AI_USAGE_RETENTION_DAYS, claimAiSearch, pruneAiUsage, usageDay } from "./usage";
import { openTestDb } from "@/server/desk/test-helpers";

const WS = "ws_impact";
const NOW = Date.parse("2026-10-05T23:59:00.000Z");
const DAY = 86400000;

describe("claimAiSearch", () => {
  it("allows each person AI_SEARCH_DAILY_CAP questions per UTC day", async () => {
    const { db } = openTestDb();
    for (let i = 0; i < AI_SEARCH_DAILY_CAP; i++) {
      expect(await claimAiSearch(db, WS, "u1", NOW)).toBe(true);
    }
    expect(await claimAiSearch(db, WS, "u1", NOW)).toBe(false);
    expect(await claimAiSearch(db, WS, "u2", NOW)).toBe(true);
    expect(await claimAiSearch(db, WS, "u1", NOW + 2 * 60000)).toBe(true);
    expect(usageDay(NOW + 2 * 60000)).toBe("2026-10-06");
  });

  it("stops the whole workspace at its daily cap", async () => {
    const { db } = openTestDb();
    await db.insert(schema.aiUsage).values({ workspaceId: WS, principalId: "u_busy", day: usageDay(NOW), kind: "search", count: AI_SEARCH_WORKSPACE_DAILY_CAP });
    expect(await claimAiSearch(db, WS, "u1", NOW)).toBe(false);
    expect(await claimAiSearch(db, "ws_other", "u1", NOW)).toBe(true);
  });
});

describe("pruneAiUsage", () => {
  it("drops counters older than the retention window", async () => {
    const { db } = openTestDb();
    await db.insert(schema.aiUsage).values([
      { workspaceId: WS, principalId: "u1", day: usageDay(NOW - (AI_USAGE_RETENTION_DAYS + 1) * DAY), kind: "search", count: 3 },
      { workspaceId: WS, principalId: "u1", day: usageDay(NOW - DAY), kind: "search", count: 3 },
    ]);
    await pruneAiUsage(db, NOW);
    expect((await db.select().from(schema.aiUsage)).map((row) => row.day)).toEqual([usageDay(NOW - DAY)]);
  });
});
