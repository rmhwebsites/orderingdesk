// The curated fonts a workspace may choose for headings and body text
// (platform amendment section 6), by id, plus "system". These ids are what
// workspaces.branding.fonts stores. The settings stage validates against
// this list and loads the Google Font at runtime; extend this list rather
// than keeping a second one. Emails use fontStack, because most mail
// clients ignore web fonts and need web-safe fallbacks behind the family.

export const SYSTEM_FONT_ID = "system";

export type BrandFont = { id: string; family: string; category: "sans" | "serif" };

export const BRAND_FONTS: readonly BrandFont[] = [
  { id: "inter", family: "Inter", category: "sans" },
  { id: "roboto", family: "Roboto", category: "sans" },
  { id: "open-sans", family: "Open Sans", category: "sans" },
  { id: "lato", family: "Lato", category: "sans" },
  { id: "montserrat", family: "Montserrat", category: "sans" },
  { id: "poppins", family: "Poppins", category: "sans" },
  { id: "work-sans", family: "Work Sans", category: "sans" },
  { id: "dm-sans", family: "DM Sans", category: "sans" },
  { id: "manrope", family: "Manrope", category: "sans" },
  { id: "oswald", family: "Oswald", category: "sans" },
  { id: "sora", family: "Sora", category: "sans" },
  { id: "red-hat-display", family: "Red Hat Display", category: "sans" },
  { id: "playfair-display", family: "Playfair Display", category: "serif" },
  { id: "merriweather", family: "Merriweather", category: "serif" },
  { id: "lora", family: "Lora", category: "serif" },
  { id: "libre-baskerville", family: "Libre Baskerville", category: "serif" },
  { id: "roboto-slab", family: "Roboto Slab", category: "serif" },
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
