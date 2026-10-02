// The shape of workspaces.branding (platform amendment section 6). Shared by
// the server (which validates every value before storing it, because these
// values reach CSS and email markup) and the client (which renders them).
// null anywhere means "use the Ordering Desk default" for that part.
//
// The settings stage owns validation and the upload pipeline; this file is
// only the stored contract, so change it deliberately.

export const BRAND_RADII = ["sharp", "subtle", "soft", "rounded", "pill"] as const;
export type BrandRadius = (typeof BRAND_RADII)[number];

// One uploaded image in R2 (the PO_BUCKET binding), under
// branding/<workspaceId>/<slot>-<random hex>.<ext> (src/server/branding/
// assets.ts). key is the file served to the app (an SVG is checked and
// refused when unsafe, never stored as is); pngKey is the PNG copy that
// emails use for SVG and WebP uploads, since Gmail and Outlook render
// neither.
export type BrandAsset = {
  key: string;
  contentType: "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp";
  pngKey: string | null;
};

// A light version, plus an optional dark-mode version.
export type BrandImage = {
  light: BrandAsset;
  dark: BrandAsset | null;
};

// #rrggbb values only.
export type BrandColors = {
  primary: string;
  ink: string;
  background: string;
};

export type WorkspaceBranding = {
  // Full horizontal logo.
  logo?: BrandImage | null;
  // Square mark; doubles as the browser tab icon.
  symbol?: BrandImage | null;
  // Light mode palette.
  colors?: BrandColors | null;
  // Optional dark mode overrides; anything missing is derived from colors.
  darkColors?: Partial<BrandColors> | null;
  // Font ids from the curated allowlist, or "system".
  fonts?: { heading: string; body: string } | null;
  radius?: BrandRadius | null;
};

// Where an uploaded branding file is served: /api/branding/<workspaceId>/<file>,
// where <file> is the last segment of the asset's R2 key. The settings stage
// builds that route and the uploads, so it must store keys whose last
// segment is unique within the workspace. Emails prefix the hub origin
// (https://orderingdesk.com) because mail clients need an absolute URL.
export function brandAssetPath(workspaceId: string, key: string): string {
  const file = key.split("/").pop() ?? key;
  return `/api/branding/${encodeURIComponent(workspaceId)}/${encodeURIComponent(file)}`;
}

// The key an email may show for an asset: its PNG copy, or the key itself
// when the upload is a PNG or JPEG. Never an SVG or WebP, which Gmail and
// Outlook do not render; null means "show the workspace name instead".
export function emailPngKey(asset: BrandAsset | null | undefined): string | null {
  if (!asset) {
    return null;
  }
  if (asset.pngKey) {
    return asset.pngKey;
  }
  return asset.contentType === "image/png" || asset.contentType === "image/jpeg" ? asset.key : null;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// A stored color as #rrggbb (lowercased), or null when it is anything else.
// Readers check again although the settings stage validates on save,
// because these values reach CSS and email markup.
export function brandHex(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : null;
}
