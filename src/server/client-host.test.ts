import { describe, it, expect } from "vitest";
import type { HostWorkspace } from "./host";
import { signInView } from "./client-host";

function workspace(overrides: Partial<HostWorkspace> = {}): HostWorkspace {
  return {
    id: "ws_impact",
    name: "Impact Rentals",
    slug: "impact-rentals",
    accentColor: "#91d500",
    logoUrl: null,
    createdBy: "u",
    createdAt: 1,
    customDomain: "orders.impactrentals.store",
    customDomainStatus: "active",
    sendingAddress: null,
    sendingVerifiedAt: null,
    rosterTags: null,
    branding: null,
    ...overrides,
  };
}

describe("signInView", () => {
  it("keeps the Ordering Desk sign-in on the hub", () => {
    expect(signInView({ kind: "hub" })).toEqual({ kind: "hub" });
  });

  it("shows nothing on an unknown host", () => {
    expect(signInView({ kind: "unknown" })).toEqual({ kind: "not-found" });
  });

  it("brands a client host with the workspace name, copy and logo files", () => {
    const view = signInView({
      kind: "workspace",
      workspace: workspace({
        branding: {
          logo: {
            light: { key: "branding/ws_impact/logo-light.svg", contentType: "image/svg+xml", pngKey: "branding/ws_impact/logo-light.png" },
            dark: { key: "branding/ws_impact/logo-dark.svg", contentType: "image/svg+xml", pngKey: null },
          },
          colors: { primary: "#0a7cff", ink: "#101820", background: "#ffffff" },
        },
      }),
    });
    expect(view).toEqual({
      kind: "workspace",
      workspaceId: "ws_impact",
      name: "Impact Rentals",
      heading: "Sign in to Impact Rentals orders",
      accent: "#0a7cff",
      branding: expect.objectContaining({ colors: { primary: "#0a7cff", ink: "#101820", background: "#ffffff" } }),
      logo: {
        light: "/api/branding/ws_impact/logo-light.svg",
        dark: "/api/branding/ws_impact/logo-dark.svg",
      },
      symbol: null,
    });
  });

  it("falls back to the accent color and no logo when the workspace has no branding", () => {
    const view = signInView({ kind: "workspace", workspace: workspace() });
    expect(view).toMatchObject({ kind: "workspace", accent: "#91d500", logo: null, symbol: null, branding: null });
  });

  it("ignores a stored primary color that is not #rrggbb", () => {
    const view = signInView({
      kind: "workspace",
      workspace: workspace({
        branding: { colors: { primary: "red; background:url(x)", ink: "#101820", background: "#ffffff" } },
      }),
    });
    expect(view).toMatchObject({ accent: "#91d500" });
  });
});
