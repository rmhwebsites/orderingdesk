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
  onQuery: () => {},
  sort: "newest",
  onSort: () => {},
  kindFilter: { kind: "all", onKind: () => {}, draftCount: 5, deletedCount: 0 },
  shown: 34,
};

const render = (overrides: Partial<ToolbarProps> = {}) => renderToStaticMarkup(createElement(Toolbar, { ...base, ...overrides }));

describe("Toolbar", () => {
  it("puts status, kind, search and sort in one row at desk width", () => {
    const html = render();
    expect(html).toMatch(/^<div class="flex min-w-0 flex-1 flex-wrap items-center/);
    for (const marker of ['id="desk-status"', 'name="desk-kind"', 'id="desk-search"', 'id="desk-sort"']) {
      expect(html).toContain(marker);
    }
    expect(html).toContain("34 cards shown");
  });

  it("lists every status with its count, and unknown keys by their key", () => {
    const html = render();
    expect(html).toContain(">All statuses</option>");
    expect(html).toContain(">Processing (6)</option>");
    expect(html).toContain(">Unknown: backorder (1)</option>");
  });

  it("is one row on phones, with search and the other filters behind buttons", () => {
    const closed = render({ layout: "phone" });
    expect(closed).toContain('id="desk-status"');
    expect(closed).not.toContain('id="desk-search"');
    expect(closed).not.toContain('id="desk-sort"');
    expect(closed.match(/aria-expanded="false"/g)).toHaveLength(2);
    const searching = render({ layout: "phone", query: "vest" });
    expect(searching).toContain('id="desk-search"');
    expect(searching).toContain('value="vest"');
    expect(render({ layout: "phone", sort: "oldest" })).toContain("More filters, 1 on");
  });
});
