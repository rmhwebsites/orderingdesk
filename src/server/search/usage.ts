// Daily AI search caps (design section 3), stored in D1 (ai_usage). Per
// person and per workspace, per UTC day (the Workers AI allowance resets at
// 00:00 UTC). One conditional upsert claims a question, so two tabs cannot
// both pass the person's last one. Relative imports only.

import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { aiUsage } from "../../db/schema";

export const AI_SEARCH_DAILY_CAP = 100;
export const AI_SEARCH_WORKSPACE_DAILY_CAP = 2000;
export const AI_USAGE_RETENTION_DAYS = 35;
const SEARCH = "search";

export function usageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// True when the question may go to the model (and is now counted).
export async function claimAiSearch(db: Db, workspaceId: string, principalId: string, now: number): Promise<boolean> {
  const day = usageDay(now);
  const totals = await db
    .select({ total: sql<number>`coalesce(sum(${aiUsage.count}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), eq(aiUsage.day, day), eq(aiUsage.kind, SEARCH)));
  if (Number(totals[0]?.total ?? 0) >= AI_SEARCH_WORKSPACE_DAILY_CAP) {
    return false;
  }
  return claimDaily(db, { workspaceId, principalId, kind: SEARCH }, AI_SEARCH_DAILY_CAP, now);
}

// One conditional upsert claims one unit of a person's daily count for a
// kind ("search", "mcp_read", "mcp_change"), so two requests cannot both
// pass the last one. False once the count reached cap.
export async function claimDaily(
  db: Db,
  key: { workspaceId: string; principalId: string; kind: string },
  cap: number,
  now: number,
): Promise<boolean> {
  if (cap <= 0) {
    return false;
  }
  const rows = await db
    .insert(aiUsage)
    .values({ ...key, day: usageDay(now), count: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.workspaceId, aiUsage.principalId, aiUsage.day, aiUsage.kind],
      set: { count: sql`${aiUsage.count} + 1` },
      setWhere: sql`${aiUsage.count} < ${cap}`,
    })
    .returning({ count: aiUsage.count });
  return rows.length > 0;
}

// Today's counts for one person, by kind.
export async function usageToday(db: Db, workspaceId: string, principalId: string, now: number): Promise<Record<string, number>> {
  const rows = await db
    .select({ kind: aiUsage.kind, count: aiUsage.count })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), eq(aiUsage.principalId, principalId), eq(aiUsage.day, usageDay(now))));
  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}

export async function pruneAiUsage(db: Db, now: number): Promise<void> {
  await db.delete(aiUsage).where(lt(aiUsage.day, usageDay(now - AI_USAGE_RETENTION_DAYS * 86400000)));
}
