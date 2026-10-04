import { describe, it, expect } from "vitest";
import {
  draftColors,
  draftWorkspaceBranding,
  emailPreviewQuery,
  pngCopyWidth,
  svgViewBoxSize,
  themeSaveBody,
  type ThemeDraft,
} from "./branding-draft";

const SAVED: ThemeDraft = {
  colors: { primary: "#0a7cff", ink: "#101820", background: "#ffffff" },
  darkColors: {},
  fonts: { heading: "sora", body: "red-hat-display" },
  radius: "pill",
};

describe("draftColors", () => {
  it("is the three colors once each is #rrggbb, lowercased, else null", () => {
    expect(draftColors({ primary: "#0A7CFF", ink: "#101820", background: "#ffffff" })).toEqual({
      primary: "#0a7cff",
      ink: "#101820",
      background: "#ffffff",
    });
    expect(draftColors({ primary: "#0a7cf", ink: "#101820", background: "#ffffff" })).toBeNull();
    expect(draftColors({ primary: "red", ink: "#101820", background: "#ffffff" })).toBeNull();
  });
});

describe("themeSaveBody", () => {
  it("sends only the parts that changed", () => {
    expect(themeSaveBody(SAVED, SAVED)).toBeNull();
    expect(themeSaveBody({ ...SAVED, radius: "soft" }, SAVED)).toEqual({ radius: "soft" });
    expect(themeSaveBody({ ...SAVED, fonts: { heading: "lora", body: "inter" } }, SAVED)).toEqual({
      fonts: { heading: "lora", body: "inter" },
    });
    expect(
      themeSaveBody({ ...SAVED, colors: { primary: "#0A7CFF", ink: "#202020", background: "#ffffff" } }, SAVED),
    ).toEqual({ colors: { primary: "#0a7cff", ink: "#202020", background: "#ffffff" }, darkColors: null });
  });

  it("sends the dark overrides that are filled in, with the colors", () => {
    expect(themeSaveBody({ ...SAVED, darkColors: { background: "#0B0B0B", ink: "" } }, SAVED)).toEqual({
      colors: SAVED.colors,
      darkColors: { background: "#0b0b0b" },
    });
  });
});

describe("emailPreviewQuery", () => {
  it("carries the draft colors, fonts and radius that are valid", () => {
    expect(emailPreviewQuery(SAVED)).toBe(
      "primary=%230a7cff&ink=%23101820&background=%23ffffff&heading=sora&body=red-hat-display&radius=pill",
    );
    expect(emailPreviewQuery({ ...SAVED, colors: { primary: "#0a7c", ink: "#101820", background: "#ffffff" } })).toBe(
      "heading=sora&body=red-hat-display&radius=pill",
    );
  });
});

describe("draftWorkspaceBranding", () => {
  it("puts the draft theme on the stored images", () => {
    const logo = { light: { key: "branding/ws/logo-light-aa.svg", contentType: "image/svg+xml" as const, pngKey: null }, dark: null };
    expect(draftWorkspaceBranding({ ...SAVED, darkColors: { primary: "#1188ff" } }, { logo })).toEqual({
      logo,
      colors: SAVED.colors,
      darkColors: { primary: "#1188ff" },
      fonts: SAVED.fonts,
      radius: "pill",
    });
    expect(draftWorkspaceBranding({ ...SAVED, colors: { primary: "x", ink: "#101820", background: "#ffffff" } }, {}).colors).toBeNull();
  });
});

describe("pngCopyWidth", () => {
  it("renders logos 512px wide and symbols 256px (2x)", () => {
    expect(pngCopyWidth("logo-light")).toBe(512);
    expect(pngCopyWidth("logo-dark")).toBe(512);
    expect(pngCopyWidth("symbol-light")).toBe(256);
    expect(pngCopyWidth("symbol-dark")).toBe(256);
  });
});

describe("svgViewBoxSize", () => {
  it("reads the width and height of an SVG's viewBox", () => {
    expect(svgViewBoxSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect/></svg>')).toEqual({
      width: 400,
      height: 100,
    });
    expect(svgViewBoxSize("<svg viewBox='-10,-10, 64.5 32'></svg>")).toEqual({ width: 64.5, height: 32 });
    expect(svgViewBoxSize("<svg width='10'></svg>")).toBeNull();
    expect(svgViewBoxSize("<svg viewBox='0 0 0 10'></svg>")).toBeNull();
  });
});
