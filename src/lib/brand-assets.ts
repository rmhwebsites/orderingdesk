// Where a workspace's uploaded logo and symbol are served, for the pages
// that show them (top bar, client host sign-in, settings) and the browser
// tab icon. Paths are relative: they work on the hub and on the client host.

import { brandAssetPath, type BrandImage, type WorkspaceBranding } from "./branding";

export type BrandImagePaths = { light: string; dark: string | null };

export type BrandImages = { logo: BrandImagePaths | null; symbol: BrandImagePaths | null };

function paths(workspaceId: string, image: BrandImage | null | undefined): BrandImagePaths | null {
  if (!image?.light?.key) {
    return null;
  }
  return {
    light: brandAssetPath(workspaceId, image.light.key),
    dark: image.dark?.key ? brandAssetPath(workspaceId, image.dark.key) : null,
  };
}

export function brandImages(workspaceId: string, branding: WorkspaceBranding | null | undefined): BrandImages {
  return { logo: paths(workspaceId, branding?.logo), symbol: paths(workspaceId, branding?.symbol) };
}

type IconDescriptor = { url: string; type: string; media?: string };

// The iPhone home screen icon (src/app/app-icon/[file]/route.ts decides
// what it shows by host). The root layout sets it; a page that sets its
// own icons replaces the root's, so it repeats it.
export const APP_ICON_APPLE = "/app-icon/apple-180.png";

// Next metadata icons: the symbol as the tab icon, its dark version for a
// dark color scheme, plus the iPhone icon. undefined (the root layout's
// icons) without a symbol.
export function workspaceIcons(
  workspaceId: string,
  branding: WorkspaceBranding | null | undefined,
): { icon: IconDescriptor[]; apple: string } | undefined {
  const symbol = branding?.symbol;
  if (!symbol?.light?.key) {
    return undefined;
  }
  const light = { url: brandAssetPath(workspaceId, symbol.light.key), type: symbol.light.contentType };
  if (!symbol.dark?.key) {
    return { icon: [light], apple: APP_ICON_APPLE };
  }
  return {
    icon: [
      { ...light, media: "(prefers-color-scheme: light)" },
      { url: brandAssetPath(workspaceId, symbol.dark.key), type: symbol.dark.contentType, media: "(prefers-color-scheme: dark)" },
    ],
    apple: APP_ICON_APPLE,
  };
}
