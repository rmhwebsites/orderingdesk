import { describe, it, expect } from "vitest";
import { brandImages, workspaceIcons } from "./brand-assets";

const asset = (key: string, contentType: "image/svg+xml" | "image/png" = "image/svg+xml") => ({ key, contentType, pngKey: null });

describe("brandImages", () => {
  it("turns stored keys into served paths, light and dark", () => {
    const images = brandImages("ws_1", {
      logo: { light: asset("branding/ws_1/logo-light-aa.svg"), dark: asset("branding/ws_1/logo-dark-bb.svg") },
      symbol: { light: asset("branding/ws_1/symbol-light-cc.png", "image/png"), dark: null },
    });
    expect(images).toEqual({
      logo: { light: "/api/branding/ws_1/logo-light-aa.svg", dark: "/api/branding/ws_1/logo-dark-bb.svg" },
      symbol: { light: "/api/branding/ws_1/symbol-light-cc.png", dark: null },
    });
  });

  it("is empty without branding", () => {
    expect(brandImages("ws_1", null)).toEqual({ logo: null, symbol: null });
  });
});

describe("workspaceIcons", () => {
  it("uses the symbol as the tab icon, with a dark version by color scheme", () => {
    expect(
      workspaceIcons("ws_1", {
        symbol: { light: asset("branding/ws_1/symbol-light-cc.svg"), dark: asset("branding/ws_1/symbol-dark-dd.svg") },
      }),
    ).toEqual({
      icon: [
        { url: "/api/branding/ws_1/symbol-light-cc.svg", type: "image/svg+xml", media: "(prefers-color-scheme: light)" },
        { url: "/api/branding/ws_1/symbol-dark-dd.svg", type: "image/svg+xml", media: "(prefers-color-scheme: dark)" },
      ],
    });
    expect(workspaceIcons("ws_1", { symbol: { light: asset("branding/ws_1/symbol-light-cc.png", "image/png"), dark: null } })).toEqual({
      icon: [{ url: "/api/branding/ws_1/symbol-light-cc.png", type: "image/png" }],
    });
  });

  it("is undefined without a symbol", () => {
    expect(workspaceIcons("ws_1", { logo: { light: asset("branding/ws_1/logo-light-aa.svg"), dark: null } })).toBeUndefined();
  });
});
