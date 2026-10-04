import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrandingView } from "@/server/branding/assets";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const { BrandingSection } = await import("./branding");

// The contrast summary must agree with the rule that blocks saving: a row
// is shown failing exactly when checkBrandColors reports an issue for it.
function summaryRows(colors: { primary: string; ink: string; background: string }): Array<[string, boolean]> {
  const view: BrandingView = { logo: null, symbol: null, colors, darkColors: null, fonts: null, radius: null };
  const html = renderToStaticMarkup(
    createElement(BrandingSection, { workspaceId: "ws_impact", workspaceName: "Impact Rentals", initial: view, accentColor: colors.primary }),
  );
  return [...html.matchAll(/<li[^>]*><span data-tone="(green|red)"[\s\S]*?<span class="min-w-0 flex-1">([^<]+)<\/span>/g)].map(
    (match) => [match[2], match[1] === "green"],
  );
}

describe("BrandingSection contrast summary", () => {
  it("shows the status text failing on a mid grey background, where saving is blocked", () => {
    const rows = summaryRows({ primary: "#91d500", ink: "#101820", background: "#8a8f96" });
    expect(rows).toContainEqual(["Warning and error text", false]);
    expect(rows).toContainEqual(["Text on every surface", true]);
    expect(rows).toHaveLength(6);
  });

  it("shows every row passing for colors that can be saved", () => {
    const rows = summaryRows({ primary: "#91d500", ink: "#101820", background: "#ffffff" });
    expect(rows).toHaveLength(6);
    expect(rows.every(([, pass]) => pass)).toBe(true);
  });
});
