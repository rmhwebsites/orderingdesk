import { describe, it, expect } from "vitest";
import { aiClientLabel, eventSource, isAiClient, viaLabel, withVia } from "./via";

// "Via AI" (comprehensive desk design section 4): a change made through an
// AI app is the person's own change, written with source "ai" and the app.
describe("via AI", () => {
  it("writes source ai and the app only for a change made through an AI app", () => {
    expect(eventSource(undefined)).toBe("app");
    expect(eventSource({ client: "claude" })).toBe("ai");
    expect(withVia({ from: "new", to: "processing" }, undefined)).toEqual({ from: "new", to: "processing" });
    expect(withVia(null, undefined)).toBeNull();
    expect(withVia({ from: "new" }, { client: "chatgpt" })).toEqual({ from: "new", ai: { client: "chatgpt" } });
    expect(withVia(null, { client: "claude-code" })).toEqual({ ai: { client: "claude-code" } });
  });

  it("labels entries from a fixed list of apps, never from text the app chose", () => {
    expect(viaLabel({ source: "ai", meta: { ai: { client: "claude" } } })).toBe("via Claude");
    expect(viaLabel({ source: "ai", meta: { ai: { client: "claude-code" } } })).toBe("via Claude Code");
    expect(viaLabel({ source: "ai", meta: { ai: { client: "chatgpt" } } })).toBe("via ChatGPT");
    expect(viaLabel({ source: "ai", meta: { ai: { client: "Totally Claude <b>" } } })).toBe("via an AI app");
    expect(viaLabel({ source: "ai", meta: null })).toBe("via an AI app");
    expect(viaLabel({ source: "app", meta: { ai: { client: "claude" } } })).toBeNull();
    expect(viaLabel({ source: "shopify", meta: {} })).toBeNull();
    expect(isAiClient("other")).toBe(true);
    expect(isAiClient("Claude")).toBe(false);
    expect(aiClientLabel(undefined)).toBe("an AI app");
  });
});
