import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrastRatio } from "./accent";
import {
  DEFAULT_DARK_PALETTE,
  DEFAULT_LIGHT_PALETTE,
  DEFAULT_RADIUS,
  RADIUS_SCALE,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  TEXT_MIN,
  brandStyle,
  brandTokens,
  checkBrandColors,
  deriveDarkPalette,
  deriveLightPalette,
  fontFamilyCss,
  googleFontsHref,
  nearestPassingShade,
  surfacesOf,
  type Palette,
} from "./brand-theme";

const worst = (color: string, surfaces: readonly string[]) =>
  Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));

function expectReadable(palette: Palette, semantic: readonly string[]) {
  const surfaces = surfacesOf(palette);
  for (const text of [palette.ink, palette.ink2, palette.ink3, ...semantic]) {
    expect(worst(text, surfaces)).toBeGreaterThanOrEqual(TEXT_MIN);
  }
  expect(worst(palette.lineStrong, surfaces)).toBeGreaterThanOrEqual(3);
}

const IMPACT = { primary: "#91d500", ink: "#101820", background: "#ffffff" };

describe("default palettes", () => {
  it("mirror the tokens in globals.css", () => {
    const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf("}", start));
    };
    const read = (text: string, name: string) => text.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`))?.[1];
    const names: Array<[keyof Palette, string]> = [
      ["bg", "bg"],
      ["surface", "surface"],
      ["surface2", "surface-2"],
      ["ink", "ink"],
      ["ink2", "ink-2"],
      ["ink3", "ink-3"],
      ["line", "line"],
      ["lineStrong", "line-strong"],
    ];
    const light = block(":root");
    const dark = block(':root[data-theme="dark"]');
    for (const [key, name] of names) {
      expect(read(light, name), name).toBe(DEFAULT_LIGHT_PALETTE[key]);
      expect(read(dark, name), name).toBe(DEFAULT_DARK_PALETTE[key]);
    }
    expect(read(light, "good")).toBe(SEMANTIC_LIGHT[0]);
    expect(read(dark, "bad")).toBe(SEMANTIC_DARK[2]);
  });
});

describe("deriveLightPalette and deriveDarkPalette", () => {
  it("keep every text token readable for a typical brand", () => {
    const light = deriveLightPalette(IMPACT);
    expect(light.bg).toBe("#ffffff");
    expect(light.ink).toBe("#101820");
    expectReadable(light, SEMANTIC_LIGHT);
    const dark = deriveDarkPalette(IMPACT);
    expectReadable(dark, SEMANTIC_DARK);
  });

  it("derive a dark mode from a cream and brown brand", () => {
    const colors = { primary: "#c2410c", ink: "#3b2a1a", background: "#f6f1e7" };
    expectReadable(deriveLightPalette(colors), SEMANTIC_LIGHT);
    const dark = deriveDarkPalette(colors);
    expectReadable(dark, SEMANTIC_DARK);
    expect(contrastRatio(dark.bg, "#000000")).toBeLessThan(1.5);
  });

  it("use dark overrides when given", () => {
    const dark = deriveDarkPalette(IMPACT, { background: "#101418", ink: "#f0f0f0" });
    expect(dark.bg).toBe("#101418");
    expect(dark.ink).toBe("#f0f0f0");
  });
});

describe("checkBrandColors", () => {
  it("passes a readable brand", () => {
    expect(checkBrandColors(IMPACT)).toEqual([]);
    expect(checkBrandColors({ primary: "#1d3b8f", ink: "#111111", background: "#f6f1e7" })).toEqual([]);
  });

  it("fails text that is too light, with the ratio and a passing suggestion", () => {
    const issues = checkBrandColors({ primary: "#91d500", ink: "#9aa0a6", background: "#ffffff" });
    const ink = issues.find((issue) => issue.field === "ink" && issue.mode === "light");
    expect(ink?.message).toMatch(/needs at least 4\.5:1/);
    expect(ink?.suggestion).toMatch(/^#[0-9a-f]{6}$/);
    // A light ink also fails as button text on the lime; only the ink issue
    // has to clear.
    expect(
      checkBrandColors({ primary: "#91d500", ink: ink!.suggestion!, background: "#ffffff" }).filter(
        (issue) => issue.field === "ink",
      ),
    ).toEqual([]);
  });

  it("fails a background too dark for light mode and suggests a lighter one", () => {
    const issues = checkBrandColors({ primary: "#91d500", ink: "#000000", background: "#8a8f94" });
    const background = issues.find((issue) => issue.field === "background");
    expect(background?.message).toMatch(/too dark for light mode/);
    const suggestion = background!.suggestion!;
    expect(contrastRatio(suggestion, "#000000")).toBeGreaterThan(contrastRatio("#8a8f94", "#000000"));
    expect(
      checkBrandColors({ primary: "#91d500", ink: "#000000", background: suggestion }).filter(
        (issue) => issue.field === "background",
      ),
    ).toEqual([]);
  });

  it("fails a primary color whose button text cannot reach 4.5:1", () => {
    // Mid gray: about 4.1:1 with the ink and 4.3:1 with white.
    const issues = checkBrandColors({ primary: "#7a7a7a", ink: "#101820", background: "#ffffff" });
    const primary = issues.find((issue) => issue.field === "primary");
    expect(primary?.message).toMatch(/Button text/);
    expect(
      checkBrandColors({ primary: primary!.suggestion!, ink: "#101820", background: "#ffffff" }),
    ).toEqual([]);
  });

  it("checks dark overrides", () => {
    const issues = checkBrandColors(IMPACT, { background: "#9aa0a6" });
    expect(issues.some((issue) => issue.mode === "dark" && issue.field === "background")).toBe(true);
  });
});

describe("nearestPassingShade", () => {
  it("returns the color itself when it passes, the nearest passing shade otherwise", () => {
    const passes = (color: string) => contrastRatio(color, "#ffffff") >= 4.5;
    expect(nearestPassingShade("#101820", passes)).toBe("#101820");
    const shade = nearestPassingShade("#9aa0a6", passes)!;
    expect(passes(shade)).toBe(true);
    expect(nearestPassingShade("#9aa0a6", () => false)).toBeNull();
  });
});

describe("fonts", () => {
  it("maps font ids to CSS stacks, using the app's own Sora and Red Hat Display", () => {
    expect(fontFamilyCss("inter")).toBe("'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif");
    expect(fontFamilyCss("sora")).toContain("var(--font-sora)");
    expect(fontFamilyCss("system")).toContain("-apple-system");
    expect(fontFamilyCss("comic-sans")).toBeNull();
    expect(fontFamilyCss("x'; color: red")).toBeNull();
  });

  it("builds one Google Fonts stylesheet for the chosen web fonts only", () => {
    expect(googleFontsHref(["inter", "lora"])).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:wght@400;500;600;700&display=swap",
    );
    expect(googleFontsHref(["playfair-display", "playfair-display"])).toBe(
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&display=swap",
    );
    expect(googleFontsHref(["sora", "system", "red-hat-display", "nope"])).toBeNull();
    expect(googleFontsHref(["lato"])).toContain("family=Lato:wght@400;700");
  });
});

describe("brandTokens and brandStyle", () => {
  it("sets only the primary color for a workspace without a palette", () => {
    const { style, palette, fontsHref } = brandStyle(null, "#91d500");
    expect(palette).toBe(false);
    expect(fontsHref).toBeNull();
    expect(style["--primary-light"]).toBe("#91d500");
    expect(style["--primary-ink-light"]).toBe("#101820");
    expect(worst(style["--primary-strong-light"], surfacesOf(DEFAULT_LIGHT_PALETTE))).toBeGreaterThanOrEqual(4.5);
    expect(worst(style["--primary-strong-dark"], surfacesOf(DEFAULT_DARK_PALETTE))).toBeGreaterThanOrEqual(4.5);
    expect(style["--brand-bg-light"]).toBeUndefined();
    expect(style["--font-heading"]).toBeUndefined();
    expect(style["--control-radius"]).toBeUndefined();
  });

  it("sets the palette, fonts and radius of a branded workspace", () => {
    const { style, palette, fontsHref } = brandStyle(
      { colors: IMPACT, fonts: { heading: "playfair-display", body: "inter" }, radius: "sharp" },
      "#000000",
    );
    expect(palette).toBe(true);
    expect(style["--primary-light"]).toBe("#91d500");
    expect(style["--brand-bg-light"]).toBe("#ffffff");
    expect(style["--brand-ink-light"]).toBe("#101820");
    expect(style["--brand-bg-dark"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(style["--font-heading"]).toContain("Playfair Display");
    expect(style["--font-body"]).toContain("Inter");
    expect(style["--control-radius"]).toBe(RADIUS_SCALE.sharp.control);
    expect(style["--panel-radius"]).toBe(RADIUS_SCALE.sharp.panel);
    expect(fontsHref).toContain("Playfair+Display");
  });

  it("ignores stored values that are not valid and a palette that fails contrast", () => {
    const { style, palette } = brandStyle(
      {
        colors: { primary: "#91d500", ink: "#cccccc", background: "#ffffff" },
        fonts: { heading: "x", body: "y" },
        radius: "blob" as never,
      },
      "red",
    );
    expect(palette).toBe(false);
    expect(style["--primary-light"]).toBe("#91d500");
    expect(style["--font-heading"]).toBeUndefined();
    expect(style["--control-radius"]).toBeUndefined();
  });

  it("can describe every token for the settings preview", () => {
    const { style, palette } = brandStyle(null, "#91d500", { complete: true });
    expect(palette).toBe(true);
    expect(style["--brand-bg-light"]).toBe(DEFAULT_LIGHT_PALETTE.bg);
    expect(style["--brand-bg-dark"]).toBe(DEFAULT_DARK_PALETTE.bg);
    expect(style["--control-radius"]).toBe(DEFAULT_RADIUS.control);
    expect(style["--font-heading"]).toContain("var(--font-sora)");
  });

  it("uses dark overrides for the dark primary", () => {
    const tokens = brandTokens({ colors: IMPACT, darkColors: { primary: "#b6f03c" } }, "#91d500");
    expect(tokens.primary.dark.fill).toBe("#b6f03c");
    expect(tokens.primary.light.fill).toBe("#91d500");
  });
});
