// Per-workspace theme (platform amendment section 6): the CSS variables a
// workspace's branding JSON turns into, and the contrast rules that decide
// which branding can be saved. Pure and shared: the server validates with
// checkBrandColors before storing, the settings page runs the same checks
// live, and the workspace shell, the client host sign-in page and the
// settings preview render brandStyle.
//
// How the variables reach the page (src/app/globals.css):
// - every element inside [data-brand-scope] reads --primary, --primary-ink
//   and --primary-strong from the -light or -dark values set here, by theme;
// - [data-brand-palette] additionally maps --bg, --surface, ... --line-strong
//   from the --brand-*-light / --brand-*-dark values set here;
// - --font-heading, --font-body, --control-radius and --panel-radius are
//   plain inherited variables (the Tailwind theme reads them).
// A workspace with no palette keeps the Ordering Desk neutrals; status
// colors are semantic and never come from the brand.
//
// Contrast (WCAG 2): text 4.5:1 on every surface of its theme, control
// borders 3:1. A light palette is derived from the brand's ink and page
// background; dark mode is derived from the same choices unless overridden.

import { contrastRatio } from "./accent";
import { BRAND_FONTS, SYSTEM_FONT_ID, SYSTEM_FONT_STACK, fontStack } from "./brand-fonts";
import { BRAND_RADII, brandHex, type BrandColors, type BrandRadius, type WorkspaceBranding } from "./branding";

export const TEXT_MIN = 4.5;
export const UI_MIN = 3;

export type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  lineStrong: string;
};

// Mirrors of the light :root and dark tokens in src/app/globals.css
// (brand-theme.test.ts pins them together).
export const DEFAULT_LIGHT_PALETTE: Palette = {
  bg: "#f3f4f1",
  surface: "#fcfdfb",
  surface2: "#eceee9",
  ink: "#101820",
  ink2: "#3b4550",
  ink3: "#58626c",
  line: "#dadfd6",
  lineStrong: "#7d868f",
};

export const DEFAULT_DARK_PALETTE: Palette = {
  bg: "#0c1116",
  surface: "#121920",
  surface2: "#1a232c",
  ink: "#eef1ec",
  ink2: "#b8c0c8",
  ink3: "#8e98a2",
  line: "#25303a",
  lineStrong: "#66717c",
};

// The good, warn and bad text tokens of each theme. They stay semantic, so
// a brand background must leave them readable.
export const SEMANTIC_LIGHT = ["#1d6b35", "#7f5200", "#a8231a"] as const;
export const SEMANTIC_DARK = ["#7fd49a", "#f0c46a", "#f4a199"] as const;

export const DEFAULT_PRIMARY = "#91d500";
const WHITE = "#ffffff";
const BLACK = "#000000";
// Text on the default primary: the default ink or paper (the Ordering Desk
// look). A branded palette uses its own ink or white instead.
const DEFAULT_ON_PRIMARY = [DEFAULT_LIGHT_PALETTE.ink, DEFAULT_LIGHT_PALETTE.surface] as const;

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

// from moved toward to by amount (0 to 1), channel by channel.
export function mixHex(from: string, to: string, amount: number): string {
  const a = toRgb(from);
  const b = toRgb(to);
  return toHex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * amount) as Rgb);
}

export function surfacesOf(palette: Palette): [string, string, string] {
  return [palette.bg, palette.surface, palette.surface2];
}

function worst(color: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

// color moved toward `toward` in 5% steps until it reaches min on every
// surface; at 100% it is `toward` itself.
function strengthen(color: string, toward: string, surfaces: readonly string[], min: number): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = mixHex(color, toward, step / 20);
    if (worst(candidate, surfaces) >= min) {
      return candidate;
    }
  }
  return toward;
}

// Light mode: the brand's page background and text color, with a raised
// card surface, a sunken surface, hairlines, and secondary text pulled
// toward the ink until it reads on all three surfaces.
export function deriveLightPalette(colors: Pick<BrandColors, "ink" | "background">): Palette {
  const { ink, background: bg } = colors;
  const surface = mixHex(bg, WHITE, 0.6);
  const surface2 = mixHex(bg, ink, 0.05);
  const surfaces = [bg, surface, surface2];
  return {
    bg,
    surface,
    surface2,
    ink,
    ink2: strengthen(mixHex(ink, bg, 0.25), ink, surfaces, TEXT_MIN),
    ink3: strengthen(mixHex(ink, bg, 0.4), ink, surfaces, TEXT_MIN),
    line: mixHex(bg, ink, 0.12),
    lineStrong: strengthen(mixHex(ink, bg, 0.5), ink, surfaces, UI_MIN),
  };
}

// The dark page background derived from the brand's ink: the ink pulled
// toward black until it is very dark (never pure black).
function darkBackgroundFrom(ink: string): string {
  let bg = mixHex(ink, BLACK, 0.3);
  for (let i = 0; i < 20 && contrastRatio(bg, BLACK) > 1.25; i++) {
    bg = mixHex(bg, BLACK, 0.15);
  }
  return bg === BLACK ? DEFAULT_DARK_PALETTE.bg : bg;
}

// Dark mode: derived from the light choices (the ink becomes the page, the
// page background becomes the text), each part overridable.
export function deriveDarkPalette(colors: BrandColors, overrides?: Partial<BrandColors> | null): Palette {
  const bg = brandHex(overrides?.background) ?? darkBackgroundFrom(colors.ink);
  const surface = mixHex(bg, WHITE, 0.04);
  const surface2 = mixHex(bg, WHITE, 0.08);
  const surfaces = [bg, surface, surface2];
  const ink = brandHex(overrides?.ink) ?? strengthen(mixHex(colors.background, WHITE, 0.3), WHITE, surfaces, 7);
  return {
    bg,
    surface,
    surface2,
    ink,
    ink2: strengthen(mixHex(ink, bg, 0.25), ink, surfaces, TEXT_MIN),
    ink3: strengthen(mixHex(ink, bg, 0.42), ink, surfaces, TEXT_MIN),
    line: mixHex(bg, WHITE, 0.14),
    lineStrong: strengthen(mixHex(ink, bg, 0.55), ink, surfaces, UI_MIN),
  };
}

export type PrimaryTokens = {
  // The fill: buttons, active filter underline, highlights.
  fill: string;
  // Text on the fill.
  ink: string;
  // The fill pulled toward the theme's ink until it reads as text, focus
  // ring or thin rule on every surface of that theme.
  strong: string;
  // The fill under the pointer: visible on light and dark fills alike.
  hover: string;
};

function bestOn(fill: string, candidates: readonly string[]): string {
  return [...candidates].sort((a, b) => contrastRatio(b, fill) - contrastRatio(a, fill))[0];
}

// The fill moved 12% toward its text (darker under dark text, lighter under
// light text), which shows on every fill; if that would bring the text
// under AA, 12% away from it instead (more contrast, still visible).
export function primaryHover(fill: string, ink: string): string {
  const toward = mixHex(fill, ink, 0.12);
  if (contrastRatio(ink, toward) >= TEXT_MIN) {
    return toward;
  }
  const away = contrastRatio(ink, WHITE) >= contrastRatio(ink, BLACK) ? WHITE : BLACK;
  return mixHex(fill, away, 0.12);
}

function primaryTokens(fill: string, palette: Palette, onFill: readonly string[]): PrimaryTokens {
  const ink = bestOn(fill, onFill);
  return {
    fill,
    ink,
    strong: strengthen(fill, palette.ink, surfacesOf(palette), TEXT_MIN),
    hover: primaryHover(fill, ink),
  };
}

export type BrandColorField = keyof BrandColors;

export type BrandColorIssue = {
  mode: "light" | "dark";
  field: BrandColorField;
  message: string;
  // The nearest shade of this field's color that clears the issue, or null.
  suggestion: string | null;
};

function ratioText(ratio: number): string {
  // Floored, so a 4.47:1 is never reported as 4.5:1.
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

// One contrast check of a theme: text on every surface (the ink field),
// the semantic warning and error text on every surface (the background
// field), and the best button text on the primary (the primary field).
// Each needs TEXT_MIN. The Settings summary shows these rows, and
// checkBrandColors reports exactly the failing ones, so a row is shown as
// failing exactly when saving is blocked for it.
export type ContrastCheck = {
  mode: "light" | "dark";
  kind: "text" | "status" | "button";
  field: BrandColorField;
  ratio: number;
  pass: boolean;
};

function checksOf(
  mode: "light" | "dark",
  palette: Palette,
  primary: string,
  onPrimary: readonly string[],
): ContrastCheck[] {
  const surfaces = surfacesOf(palette);
  const semantic = mode === "light" ? SEMANTIC_LIGHT : SEMANTIC_DARK;
  const rows: Array<Omit<ContrastCheck, "mode" | "pass">> = [
    { kind: "text", field: "ink", ratio: worst(palette.ink, surfaces) },
    { kind: "status", field: "background", ratio: Math.min(...semantic.map((color) => worst(color, surfaces))) },
    { kind: "button", field: "primary", ratio: contrastRatio(bestOn(primary, onPrimary), primary) },
  ];
  return rows.map((row) => ({ mode, ...row, pass: row.ratio >= TEXT_MIN }));
}

// Every check of both themes, light first. The light palette comes from
// colors; the dark one from colors plus overrides.
export function contrastReport(colors: BrandColors, dark?: Partial<BrandColors> | null): ContrastCheck[] {
  const onPrimary = [colors.ink, WHITE];
  return [
    ...checksOf("light", deriveLightPalette(colors), colors.primary, onPrimary),
    ...checksOf("dark", deriveDarkPalette(colors, dark), brandHex(dark?.primary) ?? colors.primary, onPrimary),
  ];
}

function issueMessage(check: ContrastCheck): string {
  const ratio = ratioText(check.ratio);
  switch (check.kind) {
    case "text":
      return `${check.mode === "dark" ? "In dark mode, t" : "T"}ext on this background reads at ${ratio}. It needs at least 4.5:1.`;
    case "status":
      return check.mode === "light"
        ? `This background is too dark for light mode: warning and error text would read at ${ratio}. Pick a lighter background.`
        : `This background is too light for dark mode: warning and error text would read at ${ratio}. Pick a darker background.`;
    case "button":
      return `${check.mode === "dark" ? "In dark mode, b" : "B"}utton text on this color reads at ${ratio} at best. It needs at least 4.5:1.`;
  }
}

function rawIssues(colors: BrandColors, dark?: Partial<BrandColors> | null): Array<Omit<BrandColorIssue, "suggestion">> {
  return contrastReport(colors, dark)
    .filter((check) => !check.pass)
    .map((check) => ({ mode: check.mode, field: check.field, message: issueMessage(check) }));
}

// The nearest shade of color (mixed toward black or white in 1% steps)
// that passes, the color itself when it already passes, or null.
export function nearestPassingShade(color: string, passes: (candidate: string) => boolean): string | null {
  if (passes(color)) {
    return color;
  }
  for (let step = 1; step <= 100; step++) {
    for (const toward of [BLACK, WHITE]) {
      const candidate = mixHex(color, toward, step / 100);
      if (passes(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// Every contrast problem with a palette, each with a suggested fix for the
// field it names. Empty means it can be saved. colors and dark must already
// be #rrggbb values (the theme validator checks the shape first).
export function checkBrandColors(colors: BrandColors, dark?: Partial<BrandColors> | null): BrandColorIssue[] {
  return rawIssues(colors, dark).map((issue) => {
    const darkOverride = issue.mode === "dark" && dark?.[issue.field] ? dark[issue.field] : null;
    const start = darkOverride ?? colors[issue.field];
    const clears = (candidate: string) => {
      const nextColors = darkOverride ? colors : { ...colors, [issue.field]: candidate };
      const nextDark = darkOverride ? { ...dark, [issue.field]: candidate } : dark;
      return !rawIssues(nextColors, nextDark).some(
        (other) => other.field === issue.field && other.mode === issue.mode,
      );
    };
    return { ...issue, suggestion: start ? nearestPassingShade(start, clears) : null };
  });
}

export type RadiusValues = { control: string; panel: string };

// One radius system per workspace: controls and panels move together.
// The Ordering Desk default is pill controls on 12px panels.
export const DEFAULT_RADIUS: RadiusValues = { control: "999px", panel: "12px" };
export const RADIUS_SCALE: Record<BrandRadius, RadiusValues> = {
  sharp: { control: "0px", panel: "0px" },
  subtle: { control: "4px", panel: "4px" },
  soft: { control: "8px", panel: "8px" },
  rounded: { control: "12px", panel: "12px" },
  pill: { control: "999px", panel: "16px" },
};

export function isBrandRadius(value: unknown): value is BrandRadius {
  return typeof value === "string" && (BRAND_RADII as readonly string[]).includes(value);
}

// The app's own copies of two list fonts (next/font, src/app/layout.tsx):
// no Google Fonts request for them.
const APP_FONTS: Record<string, string> = {
  sora: "var(--font-sora), ui-sans-serif, system-ui, sans-serif",
  "red-hat-display": "var(--font-red-hat-display), ui-sans-serif, system-ui, sans-serif",
};

export const DEFAULT_HEADING_FONT = "sora";
export const DEFAULT_BODY_FONT = "red-hat-display";

// A CSS font-family value for a stored font id, or null for anything not
// on the allowlist (so stored text never reaches CSS).
export function fontFamilyCss(id: unknown): string | null {
  if (typeof id !== "string") {
    return null;
  }
  if (id in APP_FONTS) {
    return APP_FONTS[id];
  }
  return id === SYSTEM_FONT_ID ? SYSTEM_FONT_STACK : fontStack(id);
}

export function isBrandFontId(value: unknown): value is string {
  return value === SYSTEM_FONT_ID || BRAND_FONTS.some((font) => font.id === value);
}

// One Google Fonts stylesheet for the chosen fonts that need it (not the
// app's own fonts, not "system", nothing off the list), or null.
export function googleFontsHref(ids: readonly unknown[]): string | null {
  const families: string[] = [];
  for (const id of ids) {
    const font = typeof id === "string" && !(id in APP_FONTS) ? BRAND_FONTS.find((f) => f.id === id) : undefined;
    if (!font) {
      continue;
    }
    const family = `family=${font.family.replace(/ /g, "+")}:wght@${font.weights.join(";")}`;
    if (!families.includes(family)) {
      families.push(family);
    }
  }
  return families.length > 0 ? `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap` : null;
}

export type BrandTokens = {
  // null: keep the Ordering Desk neutrals.
  palette: { light: Palette; dark: Palette } | null;
  primary: { light: PrimaryTokens; dark: PrimaryTokens };
};

function validColors(value: unknown): BrandColors | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const primary = brandHex(record.primary);
  const ink = brandHex(record.ink);
  const background = brandHex(record.background);
  return primary && ink && background ? { primary, ink, background } : null;
}

function validDark(value: unknown): Partial<BrandColors> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const out: Partial<BrandColors> = {};
  for (const field of ["primary", "ink", "background"] as const) {
    const hex = brandHex(record[field]);
    if (hex) {
      out[field] = hex;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// The colors a workspace renders with. A stored palette is used only when
// it is well formed and passes checkBrandColors (it was checked on save;
// this is the reader's own check); otherwise the Ordering Desk neutrals
// stay and only the primary color applies (branding primary, else the
// workspace accent, else the default), with button text kept at AA.
export function brandTokens(branding: WorkspaceBranding | null | undefined, accentColor: unknown): BrandTokens {
  const colors = validColors(branding?.colors);
  const dark = colors ? validDark(branding?.darkColors) : null;
  if (colors && checkBrandColors(colors, dark).length === 0) {
    const light = deriveLightPalette(colors);
    const darkPalette = deriveDarkPalette(colors, dark);
    const onPrimary = [colors.ink, WHITE];
    return {
      palette: { light, dark: darkPalette },
      primary: {
        light: primaryTokens(colors.primary, light, onPrimary),
        dark: primaryTokens(dark?.primary ?? colors.primary, darkPalette, onPrimary),
      },
    };
  }
  const fill = brandHex(branding?.colors?.primary) ?? brandHex(accentColor) ?? DEFAULT_PRIMARY;
  // Text on the fill: the Ordering Desk ink or paper, unless neither reaches
  // AA on this fill (an accent is never contrast checked when it is set);
  // then black or white, one of which always reaches 4.58:1.
  const onFill =
    contrastRatio(bestOn(fill, DEFAULT_ON_PRIMARY), fill) >= TEXT_MIN ? DEFAULT_ON_PRIMARY : [BLACK, WHITE];
  return {
    palette: null,
    primary: {
      light: primaryTokens(fill, DEFAULT_LIGHT_PALETTE, onFill),
      dark: primaryTokens(fill, DEFAULT_DARK_PALETTE, onFill),
    },
  };
}

const PALETTE_VARS: Array<[keyof Palette, string]> = [
  ["bg", "bg"],
  ["surface", "surface"],
  ["surface2", "surface-2"],
  ["ink", "ink"],
  ["ink2", "ink-2"],
  ["ink3", "ink-3"],
  ["line", "line"],
  ["lineStrong", "line-strong"],
];

export type BrandStyle = {
  // Inline style for the element carrying data-brand-scope.
  style: Record<string, string>;
  // Whether the element also needs data-brand-palette.
  palette: boolean;
  // The Google Fonts stylesheet to load for this workspace, if any.
  fontsHref: string | null;
};

// The inline variables for a workspace's scope. complete: also spell out
// every default (the settings preview renders forced light and dark copies
// side by side, so it cannot inherit anything theme-dependent).
export function brandStyle(
  branding: WorkspaceBranding | null | undefined,
  accentColor: unknown,
  opts?: { complete?: boolean },
): BrandStyle {
  const tokens = brandTokens(branding, accentColor);
  const style: Record<string, string> = {};
  for (const mode of ["light", "dark"] as const) {
    const primary = tokens.primary[mode];
    style[`--primary-${mode}`] = primary.fill;
    style[`--primary-ink-${mode}`] = primary.ink;
    style[`--primary-strong-${mode}`] = primary.strong;
    style[`--primary-hover-${mode}`] = primary.hover;
  }
  const palette = tokens.palette ?? (opts?.complete ? { light: DEFAULT_LIGHT_PALETTE, dark: DEFAULT_DARK_PALETTE } : null);
  if (palette) {
    for (const mode of ["light", "dark"] as const) {
      for (const [key, name] of PALETTE_VARS) {
        style[`--brand-${name}-${mode}`] = palette[mode][key];
      }
    }
  }
  const fonts = branding?.fonts ?? null;
  const heading = fontFamilyCss(fonts?.heading) ?? (opts?.complete ? fontFamilyCss(DEFAULT_HEADING_FONT) : null);
  const body = fontFamilyCss(fonts?.body) ?? (opts?.complete ? fontFamilyCss(DEFAULT_BODY_FONT) : null);
  if (heading) {
    style["--font-heading"] = heading;
  }
  if (body) {
    style["--font-body"] = body;
  }
  const radius = isBrandRadius(branding?.radius) ? RADIUS_SCALE[branding.radius] : opts?.complete ? DEFAULT_RADIUS : null;
  if (radius) {
    style["--control-radius"] = radius.control;
    style["--panel-radius"] = radius.panel;
  }
  return {
    style,
    palette: palette !== null,
    fontsHref: googleFontsHref([fonts?.heading, fonts?.body]),
  };
}
