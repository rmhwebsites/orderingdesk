import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyDesk, NoMatches } from "./empty-states";

// The empty desk is the landing screen of a workspace with no store
// connected. Its "Connect the store" link must lead to a Settings page that
// exists on the host it is shown on: /w/<slug>/settings on the hub, and
// /settings on the workspace's client host (basePath "").
const appDir = join(dirname(fileURLToPath(import.meta.url)), "../../app");

describe("EmptyDesk", () => {
  it("links a platform admin to the store connection in Settings on either host", () => {
    expect(renderToStaticMarkup(createElement(EmptyDesk, { basePath: "/w/impact-rentals", canConnect: true }))).toContain(
      'href="/w/impact-rentals/settings#store"',
    );
    expect(renderToStaticMarkup(createElement(EmptyDesk, { basePath: "", canConnect: true }))).toContain(
      'href="/settings#store"',
    );
    expect(existsSync(join(appDir, "w/[slug]/settings/page.tsx"))).toBe(true);
    expect(existsSync(join(appDir, "settings/page.tsx"))).toBe(true);
  });

  it("shows no link to anyone who cannot connect the store", () => {
    const html = renderToStaticMarkup(createElement(EmptyDesk, { basePath: "/w/impact-rentals", canConnect: false }));
    expect(html).not.toContain("href=");
    expect(html).toContain("No orders yet");
  });
});

// What an empty list says depends on which filter emptied it (draft orders
// spec section 11.2: All / Drafts / Orders compose with the status strip,
// and Drafts plus New is the review queue, empty once requests are handled).
describe("NoMatches", () => {
  const render = (props: { query?: string; kind?: "all" | "drafts" | "orders" | "deleted"; statusLabel?: string | null }) =>
    renderToStaticMarkup(
      createElement(NoMatches, {
        query: props.query ?? "",
        kind: props.kind ?? "all",
        statusLabel: props.statusLabel ?? null,
        onClear: () => {},
      }),
    );

  it("calls an empty review queue what it is", () => {
    const queue = render({ kind: "drafts", statusLabel: "New" });
    expect(queue).toContain("No requests have this status");
    expect(queue).toContain("No requests are in New.");
    expect(queue).not.toContain("orders");

    const none = render({ kind: "drafts" });
    expect(none).toContain("No requests waiting");
    expect(none).toContain("New requests from the store show up here.");
  });

  it("never says no orders have a status when the Drafts filter hides them", () => {
    const html = render({ kind: "drafts", statusLabel: "Shipped" });
    expect(html).not.toContain("No loaded orders have this status.");
    expect(html).not.toContain("No orders match");
    expect(html).toContain("No requests are in Shipped.");
  });

  it("speaks of orders, deleted requests and searches in their own words", () => {
    expect(render({ kind: "orders", statusLabel: "Shipped" })).toContain("No orders have this status");
    expect(render({ kind: "orders", statusLabel: "Shipped" })).toContain("No orders are in Shipped.");
    expect(render({ kind: "orders" })).toContain("No orders yet");
    expect(render({ kind: "deleted" })).toContain("No deleted requests");
    const search = render({ kind: "drafts", query: "  jason ", statusLabel: "New" });
    expect(search).toContain("No requests match");
    expect(search).toContain("Nothing matches &quot;jason&quot; in New.");
    expect(render({ query: "jason" })).toContain("Nothing matches &quot;jason&quot;.");
  });

  it("keeps the All copy, and says Clear filters goes back to All when a type filter is on", () => {
    const all = render({ statusLabel: "Shipped" });
    expect(all).toContain("No orders match");
    expect(all).toContain("No loaded orders have this status.");
    expect(all).toContain(">Clear filters<");
    expect(all).not.toContain("back to All");

    const drafts = render({ kind: "drafts", statusLabel: "New" });
    expect(drafts).toContain(">Clear filters<");
    expect(drafts).toContain("Clear filters goes back to All, with no search or status.");
  });
});
