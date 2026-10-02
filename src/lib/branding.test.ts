import { describe, it, expect } from "vitest";
import { brandAssetPath, brandHex, emailPngKey } from "./branding";

describe("brandAssetPath", () => {
  it("serves an asset at /api/branding/<workspaceId>/<last key segment>", () => {
    expect(brandAssetPath("ws_impact", "branding/ws_impact/logo-light.png")).toBe(
      "/api/branding/ws_impact/logo-light.png",
    );
    expect(brandAssetPath("ws 1", "a/b c.png")).toBe("/api/branding/ws%201/b%20c.png");
  });
});

describe("emailPngKey", () => {
  it("uses the PNG copy, or the key itself for a PNG upload, and never an SVG", () => {
    expect(emailPngKey({ key: "k/logo.svg", contentType: "image/svg+xml", pngKey: "k/logo.png" })).toBe("k/logo.png");
    expect(emailPngKey({ key: "k/logo.png", contentType: "image/png", pngKey: null })).toBe("k/logo.png");
    expect(emailPngKey({ key: "k/logo.svg", contentType: "image/svg+xml", pngKey: null })).toBeNull();
    expect(emailPngKey(null)).toBeNull();
  });
});

describe("brandHex", () => {
  it("accepts #rrggbb only, lowercased", () => {
    expect(brandHex("#0A7CFF")).toBe("#0a7cff");
    expect(brandHex("#fff")).toBeNull();
    expect(brandHex("red")).toBeNull();
    expect(brandHex("#0a7cff\n")).toBeNull();
    expect(brandHex(undefined)).toBeNull();
  });
});
