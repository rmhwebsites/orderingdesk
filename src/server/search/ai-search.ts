// AI search behind POST /api/workspaces/[id]/search/ai (design section 3):
// the shortcut, the workspace switch, the daily cap, the model, then
// validation in code. Every way out that is not a valid filter is a
// fallback reason, and the desk keeps its keyword results. Log lines carry
// ids, the outcome and milliseconds, never the question.

import type { Db } from "../../db";
import { describeToday } from "../../lib/date-range";
import { cleanText, isEmptyQuery, type DeskQuery } from "../../lib/desk-query";
import { AI_QUERY_MAX, shouldAskAi } from "../../lib/search-shortcut";
import { translateQuery, type AiRunner, type FallbackReason } from "./ai";
import { validateAiFilter } from "./ai-filter";
import { claimAiSearch } from "./usage";
import { loadVocabulary } from "./vocabulary";

export type AiSearchOutcome =
  | { kind: "filter"; query: DeskQuery }
  | { kind: "fallback"; reason: FallbackReason }
  | { kind: "invalid"; error: string };

type AiSearchContext = { workspaceId: string; userId: string; now: number };

// Lowercase words between single spaces, for whole-word matching.
function wordsOf(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

// The model sometimes picks a status nobody asked for (live check,
// 2026-10-07), so a status counts only when the question names its label.
function namesStatus(question: string, label: string): boolean {
  const name = wordsOf(label);
  return name.trim().length > 0 && wordsOf(question).includes(name);
}

function logged(ctx: AiSearchContext, outcome: AiSearchOutcome, ms: number): AiSearchOutcome {
  const result = outcome.kind === "filter" ? "ok" : outcome.kind === "fallback" ? outcome.reason : "invalid";
  console.log("[search] " + JSON.stringify({ workspaceId: ctx.workspaceId, ai: result, ms }));
  return outcome;
}

export async function aiSearch(
  db: Db,
  ai: AiRunner | undefined,
  ctx: AiSearchContext,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<AiSearchOutcome> {
  const raw = typeof body === "object" && body !== null ? (body as { q?: unknown }).q : undefined;
  const q = typeof raw === "string" ? cleanText(raw, AI_QUERY_MAX) : "";
  if (q.length === 0) {
    return { kind: "invalid", error: "Send the question as q" };
  }
  if (!shouldAskAi(q)) {
    return { kind: "fallback", reason: "shortcut" };
  }
  const loaded = await loadVocabulary(db, ctx.workspaceId);
  if (!loaded.aiSearch || !ai) {
    return { kind: "fallback", reason: "off" };
  }
  if (!(await claimAiSearch(db, ctx.workspaceId, ctx.userId, ctx.now))) {
    return logged(ctx, { kind: "fallback", reason: "limit" }, 0);
  }
  const started = Date.now();
  const translated = await translateQuery(ai, { query: q, vocab: loaded.vocab, today: describeToday(ctx.now, loaded.timeZone) }, opts);
  if (translated.kind === "fallback") {
    return logged(ctx, translated, Date.now() - started);
  }
  const query = validateAiFilter(translated.raw, loaded.vocab);
  if (query?.status) {
    const label = loaded.vocab.statuses.find((status) => status.key === query.status)?.label ?? "";
    if (!namesStatus(q, label)) {
      query.status = null;
    }
  }
  return logged(
    ctx,
    query && !isEmptyQuery(query) ? { kind: "filter", query } : { kind: "fallback", reason: "invalid" },
    Date.now() - started,
  );
}
