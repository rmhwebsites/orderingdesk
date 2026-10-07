import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadMore } from "./load-more";
import { DeskSearchField, matchLabel } from "./search-field";

const field = { value: "hard hat", resetKey: 0, onChange: () => {}, onSubmit: () => {}, asking: false, aiHint: false };

describe("DeskSearchField", () => {
  it("is a search form that submits on Enter", () => {
    const html = renderToStaticMarkup(createElement(DeskSearchField, field));
    expect(html).toContain('role="search"');
    expect(html).toContain('value="hard hat"');
    // React writes the attribute as enterKeyHint; HTML reads names in any case.
    expect(html.toLowerCase()).toContain('enterkeyhint="search"');
    expect(html).toContain("Search order, request, name or item");
  });

  it("invites a question when AI search is on, and says while it is asking", () => {
    const html = renderToStaticMarkup(createElement(DeskSearchField, { ...field, aiHint: true, asking: true }));
    expect(html).toContain("Search or ask a question");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Asking AI search");
  });
});

describe("matchLabel", () => {
  it("counts cards over all history", () => {
    expect(matchLabel(1)).toBe("1 card");
    expect(matchLabel(1234)).toBe("1,234 cards");
  });
});

describe("LoadMore", () => {
  it("offers the rest of history, and nothing when it is all loaded", () => {
    expect(renderToStaticMarkup(createElement(LoadMore, { remaining: 850, busy: false, onLoad: () => {} }))).toContain(
      "Show older cards (850 more)",
    );
    const busy = renderToStaticMarkup(createElement(LoadMore, { remaining: 850, busy: true, onLoad: () => {} }));
    expect(busy).toContain("Loading older cards");
    expect(busy).toContain('aria-busy="true"');
    // No disabled attribute (the class list names disabled: styles).
    expect(busy).not.toContain('disabled=""');
    expect(renderToStaticMarkup(createElement(LoadMore, { remaining: 0, busy: false, onLoad: () => {} }))).toBe("");
  });
});
