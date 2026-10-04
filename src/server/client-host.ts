// What a client host shows outside the desk. Pure, so the rules are tested
// without a request.

import { DEFAULT_ACCENT } from "@/lib/accent";
import { brandImages, type BrandImagePaths } from "@/lib/brand-assets";
import { brandHex, type WorkspaceBranding } from "@/lib/branding";
import type { HostResolution } from "./host";

export type SignInView =
  | { kind: "hub" }
  | { kind: "not-found" }
  | {
      kind: "workspace";
      workspaceId: string;
      name: string;
      heading: string;
      // #rrggbb primary color (the brand scope derives contrast-safe
      // tokens from it, src/lib/brand-theme.ts).
      accent: string;
      // The whole theme: palette, fonts and radius (validated again when
      // rendered).
      branding: WorkspaceBranding | null;
      // Paths of the full logo and the symbol (light, and the dark-mode
      // version if any).
      logo: BrandImagePaths | null;
      symbol: BrandImagePaths | null;
    };

// The sign-in page by host: the hub keeps the Ordering Desk page; a client
// host shows the workspace's theme, logo and name and "Sign in to
// <workspace name> orders"; an unknown host shows nothing.
export function signInView(resolution: HostResolution): SignInView {
  if (resolution.kind === "hub") {
    return { kind: "hub" };
  }
  if (resolution.kind === "unknown") {
    return { kind: "not-found" };
  }
  const { workspace } = resolution;
  const branding = workspace.branding ?? null;
  const images = brandImages(workspace.id, branding);
  return {
    kind: "workspace",
    workspaceId: workspace.id,
    name: workspace.name,
    heading: `Sign in to ${workspace.name} orders`,
    accent: brandHex(branding?.colors?.primary) ?? brandHex(workspace.accentColor) ?? DEFAULT_ACCENT,
    branding,
    logo: images.logo,
    symbol: images.symbol,
  };
}
