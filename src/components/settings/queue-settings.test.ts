import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueSettingsPanel } from "./queue-settings";

describe("QueueSettingsPanel", () => {
  it("shows the age thresholds and the price display, with Save off until something changes", () => {
    const html = renderToStaticMarkup(
      createElement(QueueSettingsPanel, { workspaceId: "ws_impact", initial: { ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" } }),
    );
    expect(html).toMatch(/<input[^>]*id="queue-amber"[^>]*value="2"/);
    expect(html).toMatch(/<input[^>]*id="queue-red"[^>]*value="4"/);
    // React writes checked before value, so look for the one checked radio.
    const prices = html.match(/<input[^>]*name="queue-prices"[^>]*>/g) ?? [];
    expect(prices).toHaveLength(3);
    expect(prices.filter((input) => input.includes('checked=""'))).toEqual([expect.stringContaining('value="auto"')]);
    expect(html).toContain("Automatic");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save work queue<\/button>/);
  });
});
