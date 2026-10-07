import { describe, it, expect } from "vitest";
import { AI_SEARCH_MAX_TOKENS, AI_SEARCH_MODEL, translateQuery, type AiRunner } from "./ai";
import type { SearchVocabulary } from "./ai-filter";

const vocab: SearchVocabulary = {
  statuses: [{ key: "new", label: "New" }],
  locations: [{ id: "loc_north", name: "North Yard" }],
  items: ["Hard Hat"],
};
const input = { query: "hard hats for north yard last month", vocab, today: "2026-10-05 (Monday)" };

function stubAi(answer: () => Promise<unknown>) {
  const calls: { model: string; inputs: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
  const ai: AiRunner = {
    run: async (model, inputs, options) => {
      calls.push({ model, inputs, options });
      return answer();
    },
  };
  return { ai, calls };
}

describe("translateQuery", () => {
  it("calls the model with thinking off, temperature 0, 200 tokens, a strict schema, rejectIfBusy and a timeout", async () => {
    const { ai, calls } = stubAi(async () => ({ choices: [{ message: { content: '{"kind":"orders"}' } }] }));
    expect(await translateQuery(ai, input)).toEqual({ kind: "ok", raw: { kind: "orders" } });
    expect(AI_SEARCH_MODEL).toBe("@cf/zai-org/glm-4.7-flash");
    expect(calls[0].model).toBe(AI_SEARCH_MODEL);
    expect(calls[0].inputs).toMatchObject({
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
      max_completion_tokens: AI_SEARCH_MAX_TOKENS,
      response_format: { type: "json_schema", json_schema: { name: "desk_filter", strict: true } },
    });
    expect(AI_SEARCH_MAX_TOKENS).toBe(200);
    const messages = calls[0].inputs.messages as { role: string; content: string }[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[1].content).toBe(input.query);
    expect(messages[0].content).toContain("2026-10-05 (Monday)");
    expect(calls[0].options).toMatchObject({ rejectIfBusy: true, tags: ["search"] });
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads an answer given as an object too", async () => {
    const { ai } = stubAi(async () => ({ response: { kind: "orders" } }));
    expect(await translateQuery(ai, input)).toEqual({ kind: "ok", raw: { kind: "orders" } });
  });

  it("falls back on a timeout, a busy model, unmet JSON mode, unreadable text and any other error", async () => {
    expect(await translateQuery(stubAi(() => new Promise(() => {})).ai, input, { timeoutMs: 20 })).toEqual({ kind: "fallback", reason: "timeout" });
    expect(await translateQuery(stubAi(async () => Promise.reject(new Error("AiError: 3040: Capacity temporarily exceeded"))).ai, input)).toEqual({
      kind: "fallback",
      reason: "busy",
    });
    expect(await translateQuery(stubAi(async () => Promise.reject(new Error("JSON Mode couldn't be met"))).ai, input)).toEqual({
      kind: "fallback",
      reason: "invalid",
    });
    expect(await translateQuery(stubAi(async () => ({ choices: [{ message: { content: "not json" } }] })).ai, input)).toEqual({
      kind: "fallback",
      reason: "invalid",
    });
    expect(await translateQuery(stubAi(async () => Promise.reject(new Error("socket hang up"))).ai, input)).toEqual({
      kind: "fallback",
      reason: "error",
    });
  });
});
