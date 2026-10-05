// What the hub home page (src/app/page.tsx) shows, by viewer. Pure, so the
// rule is tested without a request. Ryan's requirement: clients only ever
// see their own workspaces, can never create one, and land straight in
// their workspace when they have exactly one (including right after sign-in,
// since the magic link returns to "/").

import type { BrandImagePaths } from "@/lib/brand-assets";
import type { Role } from "@/lib/roles";

// symbol: the workspace's uploaded symbol as served paths (light and an
// optional dark version), or null to show the monogram tile instead.
export type HubWorkspace = {
  id: string;
  name: string;
  slug: string;
  accentColor: string;
  symbol: BrandImagePaths | null;
  role: Role;
};

export type HubView =
  | { kind: "redirect"; to: string }
  | { kind: "list"; workspaces: HubWorkspace[]; canCreate: boolean }
  | { kind: "no-access" };

// workspaces: what listWorkspacesForViewer returned for this viewer (every
// workspace for a platform admin, memberships for anyone else).
export function hubView(viewer: { platformAdmin: boolean }, workspaces: HubWorkspace[]): HubView {
  if (viewer.platformAdmin) {
    return { kind: "list", workspaces, canCreate: true };
  }
  if (workspaces.length === 0) {
    return { kind: "no-access" };
  }
  if (workspaces.length === 1) {
    return { kind: "redirect", to: `/w/${encodeURIComponent(workspaces[0].slug)}` };
  }
  return { kind: "list", workspaces, canCreate: false };
}
