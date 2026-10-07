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

  it("compare order numbers with or without the hash", () => {
    expect(sameOrderNumber("#D19", "d19")).toBe(true);
    expect(sameOrderNumber("1024", "#1024")).toBe(true);
    expect(sameOrderNumber("#D19", "#1019")).toBe(false);
    expect(sameOrderNumber("#D19", "#D190")).toBe(false);
  });
});
