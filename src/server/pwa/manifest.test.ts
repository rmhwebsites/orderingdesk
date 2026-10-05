import { describe, it, expect } from "vitest";
import type { WorkspaceBranding } from "@/lib/branding";
import type { HostWorkspace } from "@/server/host";
import { ICON_VARIANTS, appIdentity, iconVariant, manifestFor, pngSize, symbolUsable } from "./manifest";

function workspace(overrides: Partial<HostWorkspace> = {}): HostWorkspace {
  return {
    id: "ws_impact",
    name: "IMPACT Rentals",
    slug: "impact",
    accentColor: "#91d500",
    logoUrl: null,
    createdBy: "u1",
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

const symbolBranding: WorkspaceBranding = {
  symbol: {
    light: { key: "branding/ws_impact/symbol-light-ab12.svg", contentType: "image/svg+xml", pngKey: "branding/ws_impact/symbol-light-ab12.png" },
    dark: null,
  },
};

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("appIdentity", () => {
  it("is Ordering Desk on the hub, with the OD monogram", () => {
    const identity = appIdentity({ kind: "hub" });
    expect(identity).toMatchObject({
      name: "Ordering Desk",
      shortName: "Ordering Desk",
      letter: { text: "OD", background: "#101820", foreground: "#91d500" },
      symbolKey: null,
    });
  });

  it("is the workspace on its client host: its name, letter and primary color", () => {
    const identity = appIdentity({ kind: "workspace", workspace: workspace({ accentColor: "#1d4ed8" }) });
    expect(identity).toMatchObject({
      name: "IMPACT Rentals orders",
      shortName: "IMPACT Rentals",
      letter: { text: "I", background: "#1d4ed8" },
      symbolKey: null,
    });
    // The letter reads on the primary color (AA).
    expect(["#fcfdfb", "#101820", "#ffffff", "#000000"]).toContain(identity?.letter.foreground);
  });

  it("names the symbol's PNG copy when the workspace has a symbol", () => {
    const identity = appIdentity({ kind: "workspace", workspace: workspace({ branding: symbolBranding }) });
    expect(identity?.symbolKey).toBe("branding/ws_impact/symbol-light-ab12.png");
  });

  it("is nothing on an unknown host", () => {
    expect(appIdentity({ kind: "unknown" })).toBeNull();
  });
});

describe("pngSize and symbolUsable", () => {
  it("reads a PNG's width and height", () => {
    expect(pngSize(pngHeader(256, 256))).toEqual({ width: 256, height: 256 });
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("uses a symbol only when it is square enough and large enough to install", () => {
    expect(symbolUsable({ width: 256, height: 256 })).toBe(true);
    expect(symbolUsable({ width: 512, height: 500 })).toBe(true);
    expect(symbolUsable({ width: 96, height: 96 })).toBe(false);
    expect(symbolUsable({ width: 256, height: 128 })).toBe(false);
    expect(symbolUsable(null)).toBe(false);
  });
});

describe("manifestFor", () => {
  it("describes an installable standalone app on the hub with generated icons", () => {
    const manifest = manifestFor(appIdentity({ kind: "hub" })!, null);
    expect(manifest).toMatchObject({
      id: "/",
      name: "Ordering Desk",
      short_name: "Ordering Desk",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f3f4f1",
      theme_color: "#fcfdfb",
    });
    const icons = manifest.icons as Array<{ src: string; sizes: string; purpose: string; type: string }>;
    expect(icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of icons) {
      expect(icon.src).toMatch(/^\/app-icon\/(192|512|maskable-512)\.png\?v=[0-9a-f]+$/);
      expect(icon.type).toBe("image/png");
    }
  });

  it("changes the icon version when the workspace color changes", () => {
    const blue = manifestFor(appIdentity({ kind: "workspace", workspace: workspace({ accentColor: "#1d4ed8" }) })!, null);
    const green = manifestFor(appIdentity({ kind: "workspace", workspace: workspace({ accentColor: "#15803d" }) })!, null);
    expect((blue.icons as Array<{ src: string }>)[0].src).not.toBe((green.icons as Array<{ src: string }>)[0].src);
  });

  it("uses the workspace symbol at its own size when there is a usable one", () => {
    const identity = appIdentity({ kind: "workspace", workspace: workspace({ branding: symbolBranding }) })!;
    const manifest = manifestFor(identity, { width: 256, height: 256 });
    expect(manifest.icons).toEqual([
      { src: "/api/branding/ws_impact/symbol-light-ab12.png", sizes: "256x256", type: "image/png", purpose: "any" },
    ]);
  });

  it("uses the brand page and surface colors when the workspace has a palette", () => {
    const identity = appIdentity({
      kind: "workspace",
      workspace: workspace({ branding: { colors: { primary: "#1d4ed8", ink: "#0f172a", background: "#f8fafc" } } }),
    })!;
    const manifest = manifestFor(identity, null);
    expect(manifest.background_color).toBe("#f8fafc");
    expect(manifest.theme_color).not.toBe("#fcfdfb");
  });
});

describe("iconVariant", () => {
  it("knows the four icon files and nothing else", () => {
    expect(Object.keys(ICON_VARIANTS).sort()).toEqual(["192.png", "512.png", "apple-180.png", "maskable-512.png"]);
    expect(iconVariant("192.png")).toEqual({ size: 192, shape: "rounded", symbol: true });
    expect(iconVariant("maskable-512.png")).toEqual({ size: 512, shape: "square", symbol: false });
    expect(iconVariant("apple-180.png")).toEqual({ size: 180, shape: "square", symbol: true });
    expect(iconVariant("../etc.png")).toBeNull();
    expect(iconVariant("constructor")).toBeNull();
  });
});
