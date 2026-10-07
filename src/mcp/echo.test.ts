import { describe, it, expect } from "vitest";
import { sameOrderNumber, sameText } from "./echo";

// The readable fields a confirm tool repeats (design section 4).
describe("confirm echoes", () => {
  it("compare text ignoring case, spacing and Unicode form", () => {
    expect(sameText("On Hold", "  on   hold ")).toBe(true);
    expect(sameText("Duplicate order", "Duplicate order.")).toBe(false);
    expect(sameText("", "")).toBe(false);
    expect(sameText(undefined, "x")).toBe(false);
  });

  // Tool output drops hidden characters (src/mcp/output.ts), so an echo is
  // compared with what the person actually saw.
  it("compare text ignoring hidden characters", () => {
    expect(sameText("On\u200b Hold\u{e0041}", "on hold")).toBe(true);
    expect(sameText("Duplicate\u2066 order\ufe0f", "Duplicate order")).toBe(true);
    expect(sameText("Cafe\u200d\u0301", "Caf\u00e9")).toBe(true);
    expect(sameText("\u200b\u{e0020}", "\u2060")).toBe(false);
  });

  it("compare order numbers with or without the hash", () => {
    expect(sameOrderNumber("#D19", "d19")).toBe(true);
    expect(sameOrderNumber("1024", "#1024")).toBe(true);
    expect(sameOrderNumber("#D19", "#1019")).toBe(false);
    expect(sameOrderNumber("#D19", "#D190")).toBe(false);
    expect(sameOrderNumber("#D19", "d\u200b19")).toBe(true);
  });
});
