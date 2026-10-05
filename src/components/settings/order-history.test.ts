import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BackfillView } from "@/server/sync/backfill";
import { OrderHistoryPanel } from "./order-history";

// Settings > Store connection > Order history, rendered on the server (no
// DOM in vitest; dates appear after mounting, so none are rendered here).
function view(overrides: Partial<BackfillView> = {}): BackfillView {
  return {
    status: "idle",
    since: null,
    imported: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    paused: null,
    canReadAllOrders: true,
    ...overrides,
  };
}

function render(initial: BackfillView, connected = true) {
  return renderToStaticMarkup(
    createElement(OrderHistoryPanel, { workspaceId: "ws_impact", initial, connected, refreshSignal: 0 }),
  );
}

describe("OrderHistoryPanel", () => {
  it("offers all orders or a start date, and a start button", () => {
    const html = render(view());
    expect(html).toContain("Order history");
    expect(html).toContain("All orders");
    expect(html).toContain("Orders since a date");
    expect(html).toContain("Start import");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain("read_all_orders permission");
  });

  it("explains read_all_orders when the store's app lacks it, and starts on the date option", () => {
    const html = render(view({ canReadAllOrders: false }));
    expect(html).toContain("read_all_orders");
    expect(html).toContain("connect again above");
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios.filter((input) => input.includes('checked=""')).map((input) => input.match(/value="(\w+)"/)?.[1])).toEqual([
      "since",
    ]);
    expect(html).toContain('type="date"');
  });

  it("shows a running import's progress with a way to stop it, and no form", () => {
    const html = render(view({ status: "running", imported: 1240, startedAt: 1 }));
    expect(html).toContain("Importing");
    expect(html).toContain("1,240");
    expect(html).toContain("Stop import");
    expect(html).not.toContain("Start import");
  });

  it("says why a running import is waiting", () => {
    expect(render(view({ status: "running", paused: "sync" }))).toContain("waits until the regular sync has caught up");
    expect(render(view({ status: "running", paused: "disconnected" }), false)).toContain("Paused while the store is disconnected");
    expect(render(view({ status: "running", error: "Shopify responded with HTTP 503" }))).toContain(
      "Shopify responded with HTTP 503",
    );
  });

  it("sums up the last import above the form", () => {
    const html = render(view({ status: "done", imported: 12, finishedAt: 5 }));
    expect(html).toContain("Imported 12 orders (all orders).");
    expect(html).toContain("Start import");
  });

  it("asks for a connected store before importing", () => {
    const html = render(view(), false);
    expect(html).toContain("Connect the store to import its order history.");
    expect(html).not.toContain("Start import");
  });
});
