import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusView } from "@/server/desk/shapes";
import { StatusesSection } from "./statuses";

const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
  { key: "delivered", label: "Delivered", color: "slate", sort: 1, triggersPo: false, shopifyLink: "delivered", closed: true },
];

describe("StatusesSection", () => {
  it("has a Closed switch per status, on for the closed ones", () => {
    const html = renderToStaticMarkup(createElement(StatusesSection, { workspaceId: "ws_impact", initial: STATUSES }));
    const switches = html.match(/<input[^>]*id="status-[a-z_]+-closed"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(2);
    expect(switches.filter((input) => input.includes('checked=""'))).toHaveLength(1);
    expect(html).toContain("Closed (leaves the Open view)");
  });
});
