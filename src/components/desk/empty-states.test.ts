import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyDesk } from "./empty-states";

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
