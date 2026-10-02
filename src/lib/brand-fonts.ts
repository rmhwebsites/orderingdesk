// The curated fonts a workspace may choose for headings and body text
// (platform amendment section 6), by id, plus "system". These ids are what
// workspaces.branding.fonts stores. The settings stage validates against
// this list and loads the Google Font at runtime; extend this list rather
// than keeping a second one. Emails use fontStack, because most mail
// clients ignore web fonts and need web-safe fallbacks behind the family.

export const SYSTEM_FONT_ID = "system";

// weights: the ones requested from Google Fonts at runtime. Every one must
// exist for the family, or Google refuses the whole stylesheet (Lato,
// Libre Baskerville and Merriweather have no 500 or 600).
export type BrandFont = { id: string; family: string; category: "sans" | "serif"; weights: readonly number[] };

const STANDARD = [400, 500, 600, 700] as const;
const REGULAR_BOLD = [400, 700] as const;

export const BRAND_FONTS: readonly BrandFont[] = [
  { id: "inter", family: "Inter", category: "sans", weights: STANDARD },
  { id: "roboto", family: "Roboto", category: "sans", weights: STANDARD },
  { id: "open-sans", family: "Open Sans", category: "sans", weights: STANDARD },
  { id: "lato", family: "Lato", category: "sans", weights: REGULAR_BOLD },
  { id: "montserrat", family: "Montserrat", category: "sans", weights: STANDARD },
  { id: "poppins", family: "Poppins", category: "sans", weights: STANDARD },
  { id: "work-sans", family: "Work Sans", category: "sans", weights: STANDARD },
  { id: "dm-sans", family: "DM Sans", category: "sans", weights: STANDARD },
  { id: "manrope", family: "Manrope", category: "sans", weights: STANDARD },
  { id: "oswald", family: "Oswald", category: "sans", weights: STANDARD },
  { id: "sora", family: "Sora", category: "sans", weights: STANDARD },
  { id: "red-hat-display", family: "Red Hat Display", category: "sans", weights: STANDARD },
  { id: "playfair-display", family: "Playfair Display", category: "serif", weights: STANDARD },
  { id: "merriweather", family: "Merriweather", category: "serif", weights: REGULAR_BOLD },
  { id: "lora", family: "Lora", category: "serif", weights: STANDARD },
  { id: "libre-baskerville", family: "Libre Baskerville", category: "serif", weights: REGULAR_BOLD },
  { id: "roboto-slab", family: "Roboto Slab", category: "serif", weights: STANDARD },
];

const FALLBACKS: Record<BrandFont["category"], string> = {
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
};

export const SYSTEM_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// A CSS font-family value for a stored font id: the family, then web-safe
// fallbacks of the same kind. "system" is the system stack. Anything not on
// the list is null (the caller's default), so no stored text ever reaches
// CSS.
export function fontStack(id: unknown): string | null {
  if (id === SYSTEM_FONT_ID) {
    return SYSTEM_FONT_STACK;
  }
  const font = BRAND_FONTS.find((candidate) => candidate.id === id);
  return font ? `'${font.family}', ${FALLBACKS[font.category]}` : null;
}
