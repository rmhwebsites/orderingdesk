import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Chip, DetailRow, InlineMessage, Monogram, RadioCard, Section, Segmented, Spinner } from "./kit";

// The <input> tag rendered for one value (React orders the attributes its
// own way, so tests check the tag's attributes, not their order).
function inputFor(html: string, value: string): string {
  return html.match(/<input[^>]*>/g)?.find((tag) => tag.includes(`value="${value}"`)) ?? "";
}

// The shared kit (comprehensive desk design section 1). Rendered on the
// server, the way the rest of the component tests run.
describe("Chip", () => {
  it("comes in three sizes, 24, 28 and 32px tall, never with text under 12px", () => {
    const sm = renderToStaticMarkup(createElement(Chip, { tone: "slate", size: "sm", children: "Draft" }));
    const md = renderToStaticMarkup(createElement(Chip, { tone: "slate", children: "Open" }));
    const lg = renderToStaticMarkup(createElement(Chip, { tone: "amber", size: "lg", children: "Synced" }));
    expect(sm).toContain("min-h-6");
    expect(md).toContain("h-7");
    expect(lg).toContain("h-8");
    expect(lg).toContain('data-tone="amber"');
    for (const chip of [sm, md, lg]) {
      expect(chip).toContain("bg-tone-fill");
      expect(chip).not.toMatch(/text-\[(9|10|11)px\]/);
    }
  });
});

describe("InlineMessage", () => {
  it("announces problems at once and the rest politely, with an optional action", () => {
    const bad = renderToStaticMarkup(createElement(InlineMessage, { tone: "bad", children: "Not saved." }));
    expect(bad).toContain('role="alert"');
    expect(bad).toContain('data-tone="red"');
    const info = renderToStaticMarkup(
      createElement(InlineMessage, {
        tone: "info",
        children: "Draft orders are not synced.",
        action: createElement("button", { type: "button" }, "Dismiss"),
      }),
    );
    expect(info).toContain('role="status"');
    expect(info).toContain(">Dismiss<");
  });
});

describe("Section and DetailRow", () => {
  it("render a titled section and a term with its value", () => {
    expect(renderToStaticMarkup(createElement(Section, { title: "Items", children: "x" }))).toContain(">Items</h3>");
    const row = renderToStaticMarkup(createElement("dl", null, createElement(DetailRow, { term: "Company", children: "Impact" })));
    expect(row).toContain("<dt");
    expect(row).toContain(">Company</dt>");
    expect(row).toContain(">Impact</dd>");
  });
});

describe("RadioCard", () => {
  it("is a native radio with its label and help", () => {
    const html = renderToStaticMarkup(
      createElement(RadioCard, {
        name: "history-range",
        value: "all",
        checked: true,
        onChange: () => {},
        label: "All orders",
        help: "Every order the store has.",
      }),
    );
    const input = inputFor(html, "all");
    expect(input).toContain('type="radio"');
    expect(input).toContain('name="history-range"');
    expect(input).toContain('checked=""');
    expect(html).toContain("border-primary-strong");
    expect(html).toContain("Every order the store has.");
  });
});

describe("Segmented", () => {
  it("is one radio group with counts and a primary-strong bar under the active option", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        name: "desk-view",
        legend: "Show",
        value: "open",
        options: [
          { value: "open", label: "Open", count: 1234 },
          { value: "all", label: "All" },
        ],
        onChange: () => {},
      }),
    );
    expect(html).toContain("<legend");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(inputFor(html, "open")).toContain('checked=""');
    expect(inputFor(html, "all")).not.toContain("checked");
    expect(html).toContain("1,234");
    expect(html.match(/bg-primary-strong/g)).toHaveLength(1);
    expect(html).toContain("pointer-coarse:h-10");
  });

  it("can show icons only, keeping each label for screen readers and as a tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        name: "theme",
        legend: "Theme",
        value: null,
        options: [{ value: "dark", label: "Dark", icon: createElement("svg"), iconOnly: true }],
        onChange: () => {},
      }),
    );
    expect(html).toContain('title="Dark"');
    expect(html).toContain('<span class="sr-only">Dark</span>');
    expect(html).not.toContain('checked=""');
  });
});

describe("Monogram and Spinner", () => {
  it("draws a decorative letter tile and a spinning busy mark", () => {
    const tile = renderToStaticMarkup(createElement(Monogram, { text: "CL", size: "sm" }));
    expect(tile).toContain(">CL<");
    expect(tile).toContain('aria-hidden="true"');
    expect(tile).toContain("size-8");
    const spinner = renderToStaticMarkup(createElement(Spinner));
    expect(spinner).toContain("od-spin");
    expect(spinner).toContain('aria-hidden="true"');
  });
});
