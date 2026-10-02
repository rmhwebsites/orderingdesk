// What a client host shows outside the desk. Pure, so the rules are tested
// without a request.

import { DEFAULT_ACCENT } from "@/lib/accent";
import { brandAssetPath, brandHex } from "@/lib/branding";
import type { HostResolution } from "./host";

export type SignInView =
  | { kind: "hub" }
  | { kind: "not-found" }
  | {
      kind: "workspace";
      name: string;
      heading: string;
      // #rrggbb for the sign-in button (the shell derives contrast-safe
      // tokens from it, src/lib/accent.ts).
      accent: string;
      // Paths of the full logo (light, and the dark-mode version if any).
      logo: { light: string; dark: string | null } | null;
    };

// The sign-in page by host: the hub keeps the Ordering Desk page; a client
// host shows the workspace's logo and name (branding JSON) and "Sign in to
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
  const logo = branding?.logo ?? null;
  return {
    kind: "workspace",
    name: workspace.name,
    heading: `Sign in to ${workspace.name} orders`,
    accent: brandHex(branding?.colors?.primary) ?? brandHex(workspace.accentColor) ?? DEFAULT_ACCENT,
    logo: logo
      ? {
          light: brandAssetPath(workspace.id, logo.light.key),
          dark: logo.dark ? brandAssetPath(workspace.id, logo.dark.key) : null,
        }
      : null,
  };
}
