import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrandingView } from "@/server/branding/assets";
import { BrandImages } from "./brand-images";

// Four image slots share the same buttons, so every control has to say
// which slot it belongs to, for screen readers as much as on screen.
const empty: BrandingView = { logo: null, symbol: null, colors: null, darkColors: null, fonts: null, radius: null };

const asset = (file: string) => ({
  url: `/api/branding/ws_impact/${file}`,
  file,
  contentType: "image/png",
  needsPng: false,
  hasPng: true,
});

const full = {
  ...empty,
  logo: { light: asset("logo-light-a.png"), dark: asset("logo-dark-b.png") },
  symbol: { light: asset("symbol-light-c.png"), dark: asset("symbol-dark-d.png") },
} as unknown as BrandingView;

function render(view: BrandingView): string {
  return renderToStaticMarkup(createElement(BrandImages, { workspaceId: "ws_impact", view, onChange: () => {} }));
}

// The visible text of every <label> (tags and React's text separators
// removed).
function labelTexts(html: string): string[] {
  return [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((match) =>
    match[1]
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("BrandImages", () => {
  it("names each upload control after its slot", () => {
    expect(labelTexts(render(empty))).toEqual([
      "Upload logo",
      "Upload logo for dark mode",
      "Upload symbol",
      "Upload symbol for dark mode",
    ]);
    expect(labelTexts(render(full))).toEqual([
      "Replace logo",
      "Replace logo for dark mode",
      "Replace symbol",
      "Replace symbol for dark mode",
    ]);
  });

  it("names each Remove button after its slot", () => {
    const html = render(full);
    for (const what of ["logo", "logo for dark mode", "symbol", "symbol for dark mode"]) {
      expect(html).toContain(`aria-label="Remove ${what}"`);
    }
  });

  it("gives each slot a heading and ties the hint and the reason a slot is unavailable to its input", () => {
    const html = render(empty);
    expect(html.match(/<h4[^>]*>Logo for dark mode<\/h4>/)).not.toBeNull();
    const reason = html.match(/<p id="([^"]+)"[^>]*>Upload the logo first\.<\/p>/);
    expect(reason).not.toBeNull();
    const inputs = [...html.matchAll(/<input[^>]*type="file"[^>]*>/g)].map((match) => match[0]);
    expect(inputs.some((input) => input.includes(reason![1]))).toBe(true);
    for (const input of inputs) {
      expect(input).toMatch(/aria-describedby="[^"]*-hint/);
    }
  });
});
