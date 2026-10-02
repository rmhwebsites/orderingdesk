import { describe, it, expect } from "vitest";
import type { WorkspaceBranding } from "@/lib/branding";
import { emailParagraph, renderEmail, type EmailWorkspace } from "./layout";

const HUB = "https://orderingdesk.test";

function workspace(overrides: Partial<EmailWorkspace> = {}, branding: WorkspaceBranding | null = null): EmailWorkspace {
  return { id: "ws_impact", name: "Impact Rentals", accentColor: "#91d500", branding, ...overrides };
}

const PNG_LOGO: WorkspaceBranding = {
  logo: {
    light: { key: "branding/ws_impact/logo-light.svg", contentType: "image/svg+xml", pngKey: "branding/ws_impact/logo-light.png" },
    dark: null,
  },
};

const SVG_ONLY_LOGO: WorkspaceBranding = {
  logo: { light: { key: "branding/ws_impact/logo-light.svg", contentType: "image/svg+xml", pngKey: null }, dark: null },
};

function render(ws: EmailWorkspace | null, extra: Partial<Parameters<typeof renderEmail>[0]> = {}) {
  return renderEmail({
    workspace: ws,
    hubOrigin: HUB,
    preheader: "Your sign-in link expires in 5 minutes.",
    heading: "Sign in",
    bodyHtml: emailParagraph("Press the button below to sign in."),
    cta: { label: "Sign in", url: "https://orders.impactrentals.store/api/auth/magic-link/verify?token=t&callbackURL=%2F" },
    footerNote: "If you did not request this email, you can safely ignore it.",
    ...extra,
  });
}

// The value of the first style attribute on the element that contains the
// marker text, for color checks.
function buttonStyle(html: string): string {
  const match = html.match(/<a href="[^"]*"[^>]*style="([^"]*)"[^>]*>Sign in<\/a>/);
  if (!match) {
    throw new Error("button not found");
  }
  return match[1];
}

describe("renderEmail layout", () => {
  it("is a table layout, inline styles only, at most 600px wide, on a light background", () => {
    const { html } = render(workspace());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('role="presentation"');
    expect(html).toContain("max-width:600px");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).toContain('content="light only"');
    expect(html).toContain("Your sign-in link expires in 5 minutes.");
  });

  it("shows the logo's PNG copy through the hub's public branding URL", () => {
    const { html } = render(workspace({}, PNG_LOGO));
    expect(html).toContain('src="https://orderingdesk.test/api/branding/ws_impact/logo-light.png"');
    expect(html).toContain('alt="Impact Rentals"');
    expect(html).not.toContain(".svg");
  });

  it("never uses an SVG: with no PNG copy it shows the workspace name instead", () => {
    for (const branding of [SVG_ONLY_LOGO, null]) {
      const { html } = render(workspace({}, branding));
      expect(html).not.toContain("<img");
      expect(html).not.toContain(".svg");
      expect(html).toContain(">Impact Rentals</");
    }
  });

  it("uses the primary color for the top rule and the button, with button text picked by contrast", () => {
    const light = render(workspace({}, { colors: { primary: "#ffd400", ink: "#101820", background: "#f7f7f2" } }));
    expect(light.html).toContain("background-color:#ffd400");
    expect(buttonStyle(light.html)).toContain("color:#101820");

    const dark = render(workspace({}, { colors: { primary: "#0b2a6b", ink: "#101820", background: "#f7f7f2" } }));
    expect(dark.html).toContain("background-color:#0b2a6b");
    expect(buttonStyle(dark.html)).toContain("color:#ffffff");
  });

  it("falls back to the workspace accent when the branding has no colors, and ignores a color that is not #rrggbb", () => {
    expect(render(workspace({ accentColor: "#0a7cff" })).html).toContain("background-color:#0a7cff");
    const hostile = render(
      workspace({}, { colors: { primary: "red;background:url(https://x)", ink: "#101820", background: "#ffffff" } }),
    );
    expect(hostile.html).not.toContain("url(https://x)");
    expect(hostile.html).toContain("background-color:#91d500");
  });

  it("uses the brand fonts with web-safe fallbacks, and the system stack for an unknown font", () => {
    const { html } = render(workspace({}, { fonts: { heading: "playfair-display", body: "inter" } }));
    expect(html).toContain("font-family:'Playfair Display', Georgia, 'Times New Roman', Times, serif");
    expect(html).toContain("font-family:'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif");
    const unknown = render(workspace({}, { fonts: { heading: "x'; color:red", body: "system" } }));
    expect(unknown.html).not.toContain("color:red");
  });

  it("escapes a hostile workspace name everywhere it appears", () => {
    const evil = '<script>alert("x")</script> & "Co"';
    const { html, text } = render(workspace({ name: evil }, PNG_LOGO));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;Co&quot;");
    expect(html).toContain('alt="&lt;script&gt;');
    // The plain-text part is not HTML: it carries the name as typed.
    expect(text).toContain(evil);
  });

  it("escapes the heading, preheader, button label, button URL and footer note", () => {
    const { html } = render(workspace(), {
      heading: "<b>Heading</b>",
      preheader: "<i>pre</i>",
      cta: { label: "<u>Go</u>", url: "https://example.com/?a=1&b=<2>" },
      footerNote: "<em>note</em>",
    });
    for (const raw of ["<b>Heading</b>", "<i>pre</i>", "<u>Go</u>", "<em>note</em>", "b=<2>"]) {
      expect(html).not.toContain(raw);
    }
    expect(html).toContain('href="https://example.com/?a=1&amp;b=&lt;2&gt;"');
  });

  it("refuses a button URL that is not http or https", () => {
    expect(() => render(workspace(), { cta: { label: "Go", url: "javascript:alert(1)" } })).toThrow();
  });

  it("ends with the workspace name and Sent with Ordering Desk", () => {
    const { html, text } = render(workspace());
    expect(html).toContain("Sent with Ordering Desk");
    expect(text.trim().endsWith("Impact Rentals\nSent with Ordering Desk")).toBe(true);
  });

  it("gives hub mail the Ordering Desk look", () => {
    const { html, text } = render(null);
    expect(html).toContain("background-color:#91d500");
    expect(html).toContain(">Ordering Desk</");
    expect(html).toContain("font-family:'Sora'");
    expect(html).not.toContain("<img");
    expect(text.trim().endsWith("Ordering Desk")).toBe(true);
  });

  it("carries a plain-text alternative with the heading, body, button link and note", () => {
    const { text } = render(workspace(), {
      heading: "Sign in to Impact Rentals orders",
      bodyHtml:
        emailParagraph("Line one &amp; more.") +
        emailParagraph('See <a href="https://example.com/?a=1&amp;b=2">the page</a>.'),
    });
    expect(text).toContain("Sign in to Impact Rentals orders");
    expect(text).toContain("Line one & more.");
    expect(text).toContain("See the page (https://example.com/?a=1&b=2).");
    expect(text).toContain("Sign in: https://orders.impactrentals.store/api/auth/magic-link/verify?token=t&callbackURL=%2F");
    expect(text).toContain("If you did not request this email, you can safely ignore it.");
    expect(text).not.toContain("<");
  });
});
