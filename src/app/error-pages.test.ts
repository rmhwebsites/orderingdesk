import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "impact" }) }));

const { default: AppError } = await import("./error");
const { default: GlobalError } = await import("./global-error");
const { default: WorkspaceError } = await import("./w/[slug]/error");
const { default: SettingsLoading } = await import("./w/[slug]/settings/loading");

const failure = Object.assign(new Error("database exploded"), { digest: "d1g3st" });

describe("error and loading screens", () => {
  it("say what happened, offer Try again and a way out, and never show the error text", () => {
    const html = renderToStaticMarkup(createElement(AppError, { error: failure, retry: () => {} }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain(">Try again</button>");
    expect(html).toContain('href="/"');
    expect(html).toContain("d1g3st");
    expect(html).not.toContain("database exploded");
  });

  it("keep a failed workspace screen inside the workspace, with a way back to its orders", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceError, { error: failure, retry: () => {} }));
    expect(html).toContain("This screen did not load");
    expect(html).toContain('href="/w/impact"');
  });

  it("render their own document when the root layout fails", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: failure, retry: () => {} }));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Something went wrong");
  });

  it("show a Settings placeholder while Settings loads on the hub, inside the workspace layout's shell", () => {
    expect(renderToStaticMarkup(createElement(SettingsLoading))).toContain('aria-label="Loading settings"');
    expect(existsSync(new URL("./w/[slug]/layout.tsx", import.meta.url))).toBe(true);
  });

  // On a client host the page itself draws the workspace shell (top bar,
  // brand palette and fonts): a loading.tsx beside it would replace the
  // whole shell with an unthemed placeholder. Next keeps the themed desk on
  // screen until Settings is ready instead.
  it("show no Settings placeholder on a client host, where the page draws the shell itself", () => {
    expect(existsSync(new URL("./settings/loading.tsx", import.meta.url))).toBe(false);
  });
});
