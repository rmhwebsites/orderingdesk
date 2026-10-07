import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = { pathname: "/w/impact/people/p1", basePath: "/w/impact" };
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("./workspace-provider", () => ({
  useWorkspace: () => ({ workspace: { id: "ws_impact", slug: "impact", name: "Impact", basePath: state.basePath } }),
}));

const { navSection, WorkspaceNav } = await import("./workspace-nav");

describe("navSection", () => {
  it("knows the section of every path on the hub and on a client host", () => {
    expect(navSection("/w/impact", "/w/impact")).toBe("desk");
    expect(navSection("/w/impact/people", "/w/impact")).toBe("people");
    expect(navSection("/w/impact/people/p1", "/w/impact")).toBe("people");
    expect(navSection("/w/impact/locations/loc_north", "/w/impact")).toBe("locations");
    expect(navSection("/w/impact/settings", "/w/impact")).toBeNull();
    expect(navSection("/w/impactx", "/w/impact")).toBeNull();
    expect(navSection("/", "")).toBe("desk");
    expect(navSection("/people", "")).toBe("people");
    expect(navSection("/settings", "")).toBeNull();
  });
});

describe("WorkspaceNav", () => {
  it("links Desk, People and Locations, marks the current one, and keeps labels for screen readers below xl", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceNav));
    expect(html).toContain('aria-label="Workspace"');
    expect(html).toContain('href="/w/impact"');
    expect(html).toContain('href="/w/impact/people"');
    expect(html).toContain('href="/w/impact/locations"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    // next/link writes href after the other attributes: read the marked tag.
    expect(html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0]).toContain('href="/w/impact/people"');
    // Labels from xl only: shown from sm, they pushed the top bar's one row
    // past the screen from 640 to 1024px and squeezed the workspace name out.
    expect(html).toContain("sr-only xl:not-sr-only");
    expect(html).not.toContain("sm:not-sr-only");
    expect(html).not.toContain("sm:px-3");
  });

  it("uses short paths on a client host", () => {
    state.pathname = "/";
    state.basePath = "";
    const html = renderToStaticMarkup(createElement(WorkspaceNav));
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/people"');
    expect(html).toContain('href="/locations"');
  });
});
