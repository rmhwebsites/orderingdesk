// Workers AI for the desk's AI search (design section 3): one call turns a
// question into a filter object. The model sees only the question (200
// characters at most), today's date and the vocabulary staff control
// (status labels, location names, item titles); never notes,
// personalization, cart attributes or requester details. Every failure is a
// fallback reason and the desk keeps its keyword results. Workers AI has no
// local simulation, so tests stub the binding (AiRunner). Relative imports.

import { aiFilterSchema, aiSystemPrompt, type SearchVocabulary } from "./ai-filter";

// @cf/ibm-granite/granite-4.0-h-micro is the A/B candidate behind this
// constant (about a quarter of the price); switch only after the live test
// queries pass on it.
export const AI_SEARCH_MODEL = "@cf/zai-org/glm-4.7-flash";
export const AI_SEARCH_TIMEOUT_MS = 2500;
export const AI_SEARCH_MAX_TOKENS = 200;

// The slice of the Workers AI binding (env.AI) this module uses, so tests
// can stand it in. rejectIfBusy is not in the generated AiOptions type yet.
export type AiRunner = {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};

export type FallbackReason = "shortcut" | "off" | "limit" | "timeout" | "busy" | "invalid" | "error";
export type TranslateResult = { kind: "ok"; raw: unknown } | { kind: "fallback"; reason: FallbackReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function aiInputs(query: string, vocab: SearchVocabulary, today: string): Record<string, unknown> {
  return {
    messages: [
      { role: "system", content: aiSystemPrompt(vocab, today) },
      { role: "user", content: query },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "desk_filter", schema: aiFilterSchema(vocab), strict: true },
    },
    chat_template_kwargs: { enable_thinking: false },
    temperature: 0,
    max_completion_tokens: AI_SEARCH_MAX_TOKENS,
  };
}

// An OpenAI chat completion (choices[0].message.content), or the older
// Workers AI shape ({response}); either may hold text or an object.
function contentOf(result: unknown): unknown {
  if (!isRecord(result)) {
    return undefined;
  }
  const choices = result.choices;
  if (Array.isArray(choices) && isRecord(choices[0]) && isRecord(choices[0].message)) {
    return choices[0].message.content;
  }
  return result.response;
}

function parsed(content: unknown): unknown {
  if (isRecord(content)) {
    return content;
  }
  if (typeof content !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function reasonOf(error: unknown): FallbackReason {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return "timeout";
  }
  if (message.includes("3040") || message.includes("429")) {
    return "busy";
  }
  if (message.includes("JSON Mode")) {
    return "invalid";
  }
  return "error";
}

export async function translateQuery(
  ai: AiRunner,
  input: { query: string; vocab: SearchVocabulary; today: string },
  opts?: { timeoutMs?: number },
): Promise<TranslateResult> {
  const timeoutMs = opts?.timeoutMs ?? AI_SEARCH_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The signal asks the binding to stop; the race guarantees the desk never
  // waits longer even if the binding ignores it.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("AI search took too long");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      ai.run(AI_SEARCH_MODEL, aiInputs(input.query, input.vocab, input.today), {
        signal: AbortSignal.timeout(timeoutMs),
        rejectIfBusy: true,
        tags: ["search"],
      }),
      deadline,
    ]);
    const raw = parsed(contentOf(result));
    return raw === undefined ? { kind: "fallback", reason: "invalid" } : { kind: "ok", raw };
  } catch (e) {
    return { kind: "fallback", reason: reasonOf(e) };
  } finally {
    clearTimeout(timer);
  }
}
