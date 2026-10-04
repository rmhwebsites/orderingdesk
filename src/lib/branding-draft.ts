// The branding being edited in Settings, before it is saved: what the live
// preview renders, what the email preview asks for, and what Save sends
// (only the parts that changed). Pure, so it is tested without a page; the
// server validates every value again (src/server/branding/assets.ts).

import { isBrandFontId, isBrandRadius } from "./brand-theme";
import { brandHex, type BrandColors, type BrandRadius, type WorkspaceBranding } from "./branding";

// Colors as typed (any text until valid), fonts by id, one radius.
export type ThemeDraft = {
  colors: { primary: string; ink: string; background: string };
  // Optional dark mode overrides; empty text means "derived".
  darkColors: Partial<Record<keyof BrandColors, string>>;
  fonts: { heading: string; body: string };
  radius: BrandRadius;
};

const FIELDS = ["primary", "ink", "background"] as const;

// The three colors once each is #rrggbb (lowercased), else null.
export function draftColors(colors: ThemeDraft["colors"]): BrandColors | null {
  const primary = brandHex(colors.primary);
  const ink = brandHex(colors.ink);
  const background = brandHex(colors.background);
  return primary && ink && background ? { primary, ink, background } : null;
}

// The filled-in, valid dark overrides, or null when there are none.
export function draftDark(dark: ThemeDraft["darkColors"]): Partial<BrandColors> | null {
  const out: Partial<BrandColors> = {};
  for (const field of FIELDS) {
    const hex = brandHex(dark[field]);
    if (hex) {
      out[field] = hex;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// The PUT .../branding/theme body for what changed since `saved`, or null
// when nothing did. Colors and their dark overrides travel together (the
// contrast check needs both).
export function themeSaveBody(draft: ThemeDraft, saved: ThemeDraft): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  const colors = draftColors(draft.colors);
  const dark = draftDark(draft.darkColors);
  if (!same(colors, draftColors(saved.colors)) || !same(dark, draftDark(saved.darkColors))) {
    body.colors = colors;
    body.darkColors = dark;
  }
  if (!same(draft.fonts, saved.fonts)) {
    body.fonts = draft.fonts;
  }
  if (draft.radius !== saved.radius) {
    body.radius = draft.radius;
  }
  return Object.keys(body).length > 0 ? body : null;
}

// The draft after "Use the Ordering Desk colors" saved {colors: null}:
// the colors and dark overrides come from `reset` (the branding as saved
// now), while font and corner edits that were not saved yet stay in the
// draft, still waiting for Save.
export function draftAfterColorsReset(draft: ThemeDraft, reset: ThemeDraft): ThemeDraft {
  return { ...reset, fonts: draft.fonts, radius: draft.radius };
}

// The stored images with the draft theme on top: what the live preview
// renders (brandStyle checks the colors again and keeps the Ordering Desk
// neutrals while they fail).
export function draftWorkspaceBranding(draft: ThemeDraft, stored: WorkspaceBranding | null | undefined): WorkspaceBranding {
  return {
    ...(stored ?? {}),
    colors: draftColors(draft.colors),
    darkColors: draftDark(draft.darkColors),
    fonts: draft.fonts,
    radius: draft.radius,
  };
}

// The query for GET .../branding/preview: only values that pass the same
// allowlists as a save.
export function emailPreviewQuery(draft: ThemeDraft): string {
  const query = new URLSearchParams();
  const colors = draftColors(draft.colors);
  if (colors) {
    query.set("primary", colors.primary);
    query.set("ink", colors.ink);
    query.set("background", colors.background);
  }
  if (isBrandFontId(draft.fonts.heading)) {
    query.set("heading", draft.fonts.heading);
  }
  if (isBrandFontId(draft.fonts.body)) {
    query.set("body", draft.fonts.body);
  }
  if (isBrandRadius(draft.radius)) {
    query.set("radius", draft.radius);
  }
  return query.toString();
}

// The email copy of an SVG or WebP upload is rendered at 2x: 512px wide for
// logos, 256px for symbols.
export function pngCopyWidth(slot: string): number {
  return slot.startsWith("logo-") ? 512 : 256;
}

const VIEW_BOX = /viewBox\s*=\s*["']\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i;

// An SVG's viewBox size, for an SVG the browser reports no intrinsic size
// for (no width or height attributes).
export function svgViewBoxSize(svg: string): { width: number; height: number } | null {
  const match = svg.match(VIEW_BOX);
  if (!match) {
    return null;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}
