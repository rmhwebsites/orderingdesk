import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusView } from "@/server/desk/shapes";
import { StatusSelect } from "./status-select";

// The save rules live in src/lib/status-commit.ts (tested there); this
// checks the control renders them: the current status, and the busy state
// while a change is saving, without disabling (which would drop keyboard
// focus).
const statuses = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null },
  { key: "shipped", label: "Shipped", color: "violet", sort: 1, triggersPo: false, shopifyLink: "fulfilled" },
] as unknown as StatusView[];

function render(busy: boolean) {
  return renderToStaticMarkup(
    createElement(StatusSelect, { statuses, value: "new", onChange: () => {}, label: "Status for order #1001", busy }),
  );
}

describe("StatusSelect", () => {
  it("marks itself busy while a change is saving, and stays enabled", () => {
    const html = render(true);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("disabled=");
    // Full opacity with a spinner in place of the caret.
    expect(html).toContain("od-spin");
    expect(html).not.toContain("opacity-70");
  });

  it("is not busy otherwise, and shows no unsaved hint before any choice", () => {
    const html = render(false);
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain("Press Enter to save");
    expect(html).toContain('data-tone="lime"');
    expect(html).toContain("pointer-coarse:h-10");
  });
});
