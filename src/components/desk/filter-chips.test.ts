import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_QUERY, filterChips } from "@/lib/desk-query";
import { aiFallbackNotice, FilterChips } from "./filter-chips";

const vocab = { locations: [{ id: "loc_north", name: "North Yard" }], requesterName: null };

describe("FilterChips", () => {
  it("renders one remove button per filter, labelled for screen readers, and Clear all", () => {
    const chips = filterChips({ ...EMPTY_QUERY, locations: ["loc_north"], date: "last_month" }, vocab);
    const html = renderToStaticMarkup(createElement(FilterChips, { chips, understood: true, onRemove: () => {}, onClear: () => {} }));
    expect(html).toContain('aria-label="Remove filter North Yard"');
    expect(html).toContain('aria-label="Remove filter Last month"');
    expect(html).toContain("Understood as");
    expect(html).toContain("Clear all");
  });

  it("renders nothing without filters", () => {
    expect(renderToStaticMarkup(createElement(FilterChips, { chips: [], understood: false, onRemove: () => {}, onClear: () => {} }))).toBe("");
  });
});

describe("aiFallbackNotice", () => {
  it("explains only what a person can act on", () => {
    expect(aiFallbackNotice("limit")).toBe("AI search is used up for today, so these are keyword matches.");
    expect(aiFallbackNotice("timeout")).toBe("AI search did not answer in time, so these are keyword matches.");
    expect(aiFallbackNotice("busy")).toBe("AI search did not answer in time, so these are keyword matches.");
    expect(aiFallbackNotice("invalid")).toBe("AI search could not read that question, so these are keyword matches.");
    expect(aiFallbackNotice("shortcut")).toBeNull();
    expect(aiFallbackNotice("off")).toBeNull();
  });
});
