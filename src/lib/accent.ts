// Per-workspace accent colors and the WCAG contrast math shared with
// src/lib/brand-theme.ts. A workspace stores one #rrggbb accent (the
// settings API validates the shape, and saving branding colors sets it to
// the primary); these tokens keep every accent use AA in both themes:
// - accent: the fill (buttons, active underline, brand tile);
// - accentInk: text on that fill (ink or paper, whichever contrasts more);
// - accentStrongLight / accentStrongDark: the accent pulled toward ink
//   (light theme) or paper (dark theme) until it reads as text, focus ring
//   or thin rule on every surface of that theme (4.5:1 or better).
//
// The surface lists mirror the bg, surface and surface-2 tokens in
// src/app/globals.css; change them together.

export const DEFAULT_ACCENT = "#91d500";

export const LIGHT_SURFACES = ["#f3f4f1", "#fcfdfb", "#eceee9"] as const;
export const DARK_SURFACES = ["#0c1116", "#121920", "#1a232c"] as const;

const INK = "#101820";
const PAPER = "#fcfdfb";
const DARK_INK = "#eef1ec";
const TEXT_MIN = 4.5;

const HEX = /^#[0-9a-f]{6}$/;

export type AccentTokens = {
  accent: string;
  accentInk: string;
  accentStrongLight: string;
  accentStrongDark: string;
};

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// WCAG 2 contrast ratio of two #rrggbb colors, 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(from: string, to: string, amount: number): string {
  const a = toRgb(from);
  const b = toRgb(to);
  return toHex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * amount) as Rgb);
}

function worstContrast(color: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

// The accent moved toward `toward` in 5% steps until it reaches TEXT_MIN on
// every surface; at 100% it is `toward` itself, which always passes.
function strengthen(accent: string, toward: string, surfaces: readonly string[]): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(accent, toward, step / 20);
    if (worstContrast(candidate, surfaces) >= TEXT_MIN) {
      return candidate;
    }
  }
  return toward;
}

export function accentTokens(input: string): AccentTokens {
  const lower = typeof input === "string" ? input.toLowerCase() : "";
  const accent = HEX.test(lower) ? lower : DEFAULT_ACCENT;
  return {
    accent,
    accentInk: contrastRatio(INK, accent) >= contrastRatio(PAPER, accent) ? INK : PAPER,
    accentStrongLight: strengthen(accent, INK, LIGHT_SURFACES),
    accentStrongDark: strengthen(accent, DARK_INK, DARK_SURFACES),
  };
}

// Inline style for an element carrying data-brand-scope that only needs a
// workspace's accent as its primary color (the hub's workspace tiles).
// globals.css maps the -light and -dark values onto --primary,
// --primary-ink and --primary-strong per theme. Workspace screens use the
// full branding instead (brandStyle in src/lib/brand-theme.ts).
export function accentStyle(input: string): Record<string, string> {
  const tokens = accentTokens(input);
  return {
    "--primary-light": tokens.accent,
    "--primary-dark": tokens.accent,
    "--primary-ink-light": tokens.accentInk,
    "--primary-ink-dark": tokens.accentInk,
    "--primary-strong-light": tokens.accentStrongLight,
    "--primary-strong-dark": tokens.accentStrongDark,
  };
}
