import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The top bar on the server, with the workspace context stood in.
vi.mock("./workspace-provider", () => ({
  useWorkspace: () => ({
    workspace: { id: "ws_impact", slug: "impact", name: "Impact", basePath: "" },
    liveStatus: "live",
    sync: { status: "ready", connection: null },
    manual: { running: false, cooldownUntil: 0, failure: null },
    runManualSync: () => {},
  }),
}));

const { TopBar } = await import("./top-bar");

const LONG_NAME = "Impact Rentals Construction Equipment and Site Services of Southern Ontario Ltd.";

function classOf(html: string, marker: RegExp): string {
  const match = html.match(marker);
  if (!match) {
    throw new Error(`no element matching ${marker}`);
  }
  return match[1];
}

describe("TopBar from lg up", () => {
  it("lets a long workspace name shrink and truncate instead of running under the sync chip", () => {
    expect(LONG_NAME).toHaveLength(80);
    const html = renderToStaticMarkup(createElement(TopBar, { name: LONG_NAME, images: { logo: null, symbol: null } }));
    // The brand link may shrink (flex: 0 1 auto) and min-w-0 lets it go
    // below its content, so the name's truncate takes effect.
    const brand = classOf(html, /<a[^>]*title="Orders"[^>]*class="([^"]*)"/).split(" ");
    expect(brand).toContain("lg:flex-initial");
    expect(brand).toContain("min-w-0");
    expect(brand).not.toContain("lg:flex-none");
    // The chip row keeps its size; the name gives way.
    const chipRow = classOf(html, /<div class="([^"]*lg:order-2[^"]*)"/).split(" ");
    expect(chipRow).toContain("lg:shrink-0");
    // The chip itself never shrinks, so min-w-0 and a truncating label did
    // nothing there.
    const chip = classOf(html, /<span data-tone="[^"]+" title="[^"]+" class="([^"]*)"/).split(" ");
    expect(chip).toContain("shrink-0");
    expect(chip).not.toContain("min-w-0");
    expect(html).not.toMatch(/<span class="truncate">Store not connected<\/span>/);
  });
});
