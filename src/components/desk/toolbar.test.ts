import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusChip } from "@/lib/desk-state";
import { Toolbar, type ToolbarProps } from "./toolbar";

const CHIPS: StatusChip[] = [
  { key: "processing", label: "Processing", color: "blue", count: 6, known: true },
  { key: "backorder", label: "Unknown status", color: "slate", count: 1, known: false },
];

const base: ToolbarProps = {
  layout: "row",
  statusKey: null,
  onStatus: () => {},
  statusChips: CHIPS,
  query: "",
  resetKey: 0,
  onQuery: () => {},
  onSubmit: () => {},
  asking: false,
  aiHint: false,
  sort: "newest",
  onSort: () => {},
  kindFilter: { kind: "all", onKind: () => {}, draftCount: 5, deletedCount: 0 },
  count: 34,
  view: "open",
  onView: () => {},
  viewCounts: { open: 23, approval: 3, all: 35, closed: 12 },
  showApproval: true,
};

const render = (overrides: Partial<ToolbarProps> = {}) => renderToStaticMarkup(createElement(Toolbar, { ...base, ...overrides }));

describe("Toolbar", () => {
  it("puts status, kind, search and sort in one row at desk width", () => {
    const html = render();
    expect(html).toMatch(/^<div class="flex min-w-0 flex-1 flex-wrap items-center/);
    for (const marker of ['id="desk-status"', 'name="desk-kind"', 'id="desk-search"', 'id="desk-sort"']) {
      expect(html).toContain(marker);
    }
    // The server's count of matches over all history, announced politely.
    expect(html).toContain('aria-live="polite">34 cards<');
    // The one search box: a search form that submits on Enter.
    expect(html).toContain('role="search"');
  });

  it("lists every status with its count, and unknown keys by their key", () => {
    const html = render();
    expect(html).toContain(">All statuses</option>");
    expect(html).toContain(">Processing (6)</option>");
    expect(html).toContain(">Unknown: backorder (1)</option>");
  });

  it("is one row on phones, with search and the other filters behind buttons", () => {
    const closed = render({ layout: "phone" });
    expect(closed).toContain('id="desk-view"');
    expect(closed).not.toContain('id="desk-search"');
    expect(closed).not.toContain('id="desk-sort"');
    expect(closed.match(/aria-expanded="false"/g)).toHaveLength(2);
    const searching = render({ layout: "phone", query: "vest" });
    expect(searching).toContain('id="desk-search"');
    expect(searching).toContain('value="vest"');
    expect(render({ layout: "phone", sort: "oldest" })).toContain("More filters, 1 on");
  });

  it("marks the phone search button while a search is set, so closing the row never hides it", () => {
    const searchButton = (html: string) => html.match(/<button[^>]*aria-controls="desk-search-row"[^>]*>.*?<\/button>/)?.[0] ?? "";
    const on = searchButton(render({ layout: "phone", query: "vest" }));
    expect(on).toContain('<span class="sr-only">Search, on</span>');
    expect(on).toMatch(/<span aria-hidden="true" class="[^"]*rounded-full bg-primary-strong/);
    const off = searchButton(render({ layout: "phone" }));
    expect(off).toContain('<span class="sr-only">Search</span>');
    expect(off).not.toContain("bg-primary-strong");
    // Spaces alone filter nothing (the search trims), so they are not on.
    expect(searchButton(render({ layout: "phone", query: "  " }))).toContain('<span class="sr-only">Search</span>');
  });
});

describe("Toolbar views", () => {
  it("starts the row with the views and their counts, Needs approval only for those who approve", () => {
    const html = render();
    expect(html.indexOf('name="desk-view"')).toBeLessThan(html.indexOf('id="desk-status"'));
    // React writes checked before value on a radio.
    expect(html).toMatch(/<input[^>]*name="desk-view"[^>]*checked=""[^>]*value="open"/);
    expect(html).toContain("Needs approval");
    expect(html).toContain(">35<");
    expect(render({ showApproval: false })).not.toContain("Needs approval");
  });

  it("puts the view first on phones, as one select with counts, and the status behind More filters", () => {
    const html = render({ layout: "phone" });
    expect(html).toContain(">Open (23)</option>");
    expect(html).toContain(">Needs approval (3)</option>");
    expect(html).not.toContain('id="desk-status"');
  });

  it("offers Waiting longest instead of Highest total", () => {
    const html = render();
    expect(html).toContain(">Waiting longest</option>");
    expect(html).not.toContain("Highest total");
  });
});
