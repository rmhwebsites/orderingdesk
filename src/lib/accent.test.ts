import { describe, it, expect } from "vitest";
import {
  DARK_SURFACES,
  DEFAULT_ACCENT,
  LIGHT_SURFACES,
  accentStyle,
  accentTokens,
  contrastRatio,
} from "./accent";

const worstAgainst = (color: string, surfaces: readonly string[]) =>
  Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a color on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#91d500", "#91d500")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#101820", "#91d500")).toBeCloseTo(contrastRatio("#91d500", "#101820"), 10);
  });
});

describe("accentTokens", () => {
  it("keeps the IMPACT lime as the fill with ink text on it", () => {
    const tokens = accentTokens("#91d500");
    expect(tokens.accent).toBe("#91d500");
    expect(tokens.accentInk).toBe("#101820");
    expect(contrastRatio(tokens.accentInk, tokens.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("darkens a light accent until it reads as text on every light surface", () => {
    const tokens = accentTokens("#91d500");
    expect(tokens.accentStrongLight).not.toBe("#91d500");
    expect(worstAgainst(tokens.accentStrongLight, LIGHT_SURFACES)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a light accent unchanged on dark surfaces when it already passes", () => {
    const tokens = accentTokens("#91d500");
    expect(tokens.accentStrongDark).toBe("#91d500");
    expect(worstAgainst(tokens.accentStrongDark, DARK_SURFACES)).toBeGreaterThanOrEqual(4.5);
  });

  it("puts light text on a dark accent and lightens it for dark surfaces", () => {
    const tokens = accentTokens("#1d3b8f");
    expect(contrastRatio(tokens.accentInk, tokens.accent)).toBeGreaterThanOrEqual(4.5);
    expect(tokens.accentInk).not.toBe("#101820");
    expect(tokens.accentStrongLight).toBe("#1d3b8f");
    expect(tokens.accentStrongDark).not.toBe("#1d3b8f");
    expect(worstAgainst(tokens.accentStrongDark, DARK_SURFACES)).toBeGreaterThanOrEqual(4.5);
  });

  it("normalizes case", () => {
    expect(accentTokens("#91D500")).toEqual(accentTokens("#91d500"));
  });

  it("falls back to the default accent for anything that is not #rrggbb", () => {
    const fallback = accentTokens(DEFAULT_ACCENT);
    for (const bad of ["red", "#fff", "#91d500;color:red", "", "#91d5000"]) {
      expect(accentTokens(bad)).toEqual(fallback);
    }
  });
});

describe("accentStyle", () => {
  it("maps the tokens onto the primary variables of a brand scope", () => {
    const tokens = accentTokens("#91d500");
    expect(accentStyle("#91d500")).toEqual({
      "--primary-light": tokens.accent,
      "--primary-dark": tokens.accent,
      "--primary-ink-light": tokens.accentInk,
      "--primary-ink-dark": tokens.accentInk,
      "--primary-strong-light": tokens.accentStrongLight,
      "--primary-strong-dark": tokens.accentStrongDark,
    });
  });
});
