import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { AiRunner } from "./ai";
import { aiSearch } from "./ai-search";
import { AI_SEARCH_DAILY_CAP, usageDay } from "./usage";
import { openTestDb, seedLocation, seedWorkspace } from "@/server/desk/test-helpers";

const WS = "ws_impact";
const NOW = Date.parse("2026-10-05T14:00:00.000Z");
const ctx = { workspaceId: WS, userId: "u_staff", now: NOW };
const QUESTION = "orders shipped to north yard last month";

const answer = (filter: Record<string, unknown>) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          kind: "any",
          status: null,
          state: "any",
          locations: [],
          person: null,
          itemTitle: null,
          itemText: null,
          personalization: null,
          orderNumber: null,
          date: "any",
          from: null,
          to: null,
          olderThanDays: null,
          newerThanDays: null,
          sort: "newest",
          text: null,
          ...filter,
        }),
      },
    },
  ],
});

function model(result: unknown) {
  const run = vi.fn(async () => result);
  return { ai: { run } as AiRunner, run };
}

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedLocation(db, WS, { shopifyLocationId: "loc_north", name: "North Yard" });
  return db;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aiSearch", () => {
  it("turns a question into a validated desk query", async () => {
    const db = await setup();
    const { ai, run } = model(answer({ kind: "orders", locations: ["North Yard"], date: "last_month" }));
    const outcome = await aiSearch(db, ai, ctx, { q: QUESTION });
    expect(outcome).toMatchObject({ kind: "filter", query: { kind: "orders", locations: ["loc_north"], date: "last_month", view: "all" } });
    expect(run).toHaveBeenCalledTimes(1);
    const [usage] = await db.select().from(schema.aiUsage);
    expect(usage).toMatchObject({ principalId: "u_staff", day: usageDay(NOW), kind: "search", count: 1 });
  });

  it("answers numbers and short searches without the model", async () => {
    const db = await setup();
    const { ai, run } = model(answer({}));
    expect(await aiSearch(db, ai, ctx, { q: "#1024" })).toEqual({ kind: "fallback", reason: "shortcut" });
    expect(await aiSearch(db, ai, ctx, { q: "hard hat" })).toEqual({ kind: "fallback", reason: "shortcut" });
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back when the workspace turned AI search off or has no binding", async () => {
    const db = await setup();
    const { ai, run } = model(answer({}));
    expect(await aiSearch(db, undefined, ctx, { q: QUESTION })).toEqual({ kind: "fallback", reason: "off" });
    await db.update(schema.workspaceSettings).set({ aiSearch: false }).where(eq(schema.workspaceSettings.workspaceId, WS));
    expect(await aiSearch(db, ai, ctx, { q: QUESTION })).toEqual({ kind: "fallback", reason: "off" });
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back once the person's daily cap is used", async () => {
    const db = await setup();
    await db.insert(schema.aiUsage).values({ workspaceId: WS, principalId: "u_staff", day: usageDay(NOW), kind: "search", count: AI_SEARCH_DAILY_CAP });
    const { ai, run } = model(answer({ kind: "orders" }));
    expect(await aiSearch(db, ai, ctx, { q: QUESTION })).toEqual({ kind: "fallback", reason: "limit" });
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back on an answer that is invalid or understood nothing", async () => {
    const db = await setup();
    expect(await aiSearch(db, model({ choices: [{ message: { content: '{"sql":"drop"}' } }] }).ai, ctx, { q: QUESTION })).toEqual({
      kind: "fallback",
      reason: "invalid",
    });
    expect(await aiSearch(db, model(answer({})).ai, ctx, { q: QUESTION })).toEqual({ kind: "fallback", reason: "invalid" });
  });

  it("refuses a missing question and never logs the question's text", async () => {
    const db = await setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await aiSearch(db, model(answer({})).ai, ctx, {})).toEqual({ kind: "invalid", error: "Send the question as q" });
    await aiSearch(db, model(answer({ kind: "orders" })).ai, ctx, { q: QUESTION });
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.startsWith("[search]"))).toBe(true);
    expect(lines.some((line) => line.includes("north yard") || line.includes("North Yard"))).toBe(false);
  });
});
