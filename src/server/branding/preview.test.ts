import { describe, it, expect } from "vitest";
import { EMAIL_PREVIEW_HEADERS, draftBranding, renderEmailPreview } from "./preview";

const stored = {
  colors: { primary: "#91d500", ink: "#101820", background: "#ffffff" },
  fonts: { heading: "sora", body: "inter" },
  radius: "pill" as const,
  logo: { light: { key: "branding/ws/logo-light-ab.png", contentType: "image/png" as const, pngKey: null }, dark: null },
};

describe("draftBranding", () => {
  it("overlays valid draft values on the stored branding", () => {
    const draft = draftBranding(
      stored,
      new URLSearchParams({ primary: "#0A7CFF", ink: "#111111", background: "#f6f1e7", heading: "lora", body: "system", radius: "sharp" }),
    );
    expect(draft.colors).toEqual({ primary: "#0a7cff", ink: "#111111", background: "#f6f1e7" });
    expect(draft.fonts).toEqual({ heading: "lora", body: "system" });
    expect(draft.radius).toBe("sharp");
    expect(draft.logo).toEqual(stored.logo);
  });

  it("keeps stored values for anything missing or invalid", () => {
    const draft = draftBranding(stored, new URLSearchParams({ primary: "red", heading: "Comic Sans", radius: "blob" }));
    expect(draft.colors).toEqual(stored.colors);
    expect(draft.fonts).toEqual(stored.fonts);
    expect(draft.radius).toBe("pill");
  });
});

describe("renderEmailPreview", () => {
  it("renders the shared layout with the draft theme and the workspace name escaped", () => {
    const html = renderEmailPreview(
      { id: "ws", name: "Tom & Jerry <Rentals>", accentColor: "#91d500", branding: stored },
      new URLSearchParams({ primary: "#0a7cff", heading: "lora" }),
      "https://orderingdesk.com",
    );
    expect(html).toContain('bgcolor="#0a7cff"');
    expect(html).toContain("'Lora'");
    expect(html).toContain("Tom &amp; Jerry &lt;Rentals&gt;");
    expect(html).not.toContain("<Rentals>");
    expect(html).toContain("https://orderingdesk.com/api/branding/ws/logo-light-ab.png");
  });

  it("is served as an inert, sandboxed document", () => {
    expect(EMAIL_PREVIEW_HEADERS["content-security-policy"]).toBe(
      "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox",
    );
    expect(EMAIL_PREVIEW_HEADERS["content-type"]).toBe("text/html; charset=utf-8");
    expect(EMAIL_PREVIEW_HEADERS["x-content-type-options"]).toBe("nosniff");
  });
});
