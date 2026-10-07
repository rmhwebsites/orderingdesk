import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The top bar on the server, with the workspace context stood in.
const state = vi.hoisted(() => ({
  value: {
    workspace: { id: "ws_impact", slug: "impact", name: "Impact", basePath: "" },
    role: "manager",
    userId: "u_me",
    liveStatus: "live",
    sync: { status: "ready", connection: null },
    connection: null,
    manual: { running: false, cooldownUntil: 0, failure: null },
    runManualSync: () => {},
    subscribe: () => () => {},
    needsApproval: 3,
    refreshQueue: () => {},
  } as Record<string, unknown>,
}));
vi.mock("./workspace-provider", () => ({ useWorkspace: () => state.value }));
vi.mock("@/components/toasts", () => ({ useToast: () => () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }), usePathname: () => "/" }));

const { TopBar } = await import("./top-bar");

const ACCOUNT = { name: "Casey Lin", email: "casey@example.com", roleLabel: "Manager", switchHref: null, links: [] };
const LONG_NAME = "Impact Rentals Construction Equipment and Site Services of Southern Ontario Ltd.";
const render = (name = "Impact") =>
  renderToStaticMarkup(createElement(TopBar, { name, images: { logo: null, symbol: null }, account: ACCOUNT }));

function classOf(html: string, marker: RegExp): string {
  const match = html.match(marker);
  if (!match) {
    throw new Error(`no element matching ${marker}`);
  }
  return match[1];
}

describe("TopBar", () => {
  it("is one 56px row with the account menu last and the theme switch inside it", () => {
    const html = render();
    const bar = classOf(html, /<header[^>]*><div class="([^"]*)"/).split(" ");
    expect(bar).toContain("h-14");
    expect(bar).not.toContain("flex-wrap");
    expect(html.indexOf('aria-label="Activity"')).toBeLessThan(html.indexOf("Account menu for Casey Lin"));
    // The account button is the last button in the bar.
    expect(html.slice(html.lastIndexOf("<button"))).toMatch(/^<button[^>]*aria-label="Account menu for Casey Lin"/);
    expect(html).not.toContain('name="theme"');
  });

  it("lets a long workspace name shrink and truncate", () => {
    expect(LONG_NAME).toHaveLength(80);
    const brand = classOf(render(LONG_NAME), /<a[^>]*title="Orders"[^>]*class="([^"]*)"/).split(" ");
    expect(brand).toContain("min-w-0");
    expect(brand).toContain("lg:flex-initial");
  });

  it("keeps the sync chip from shrinking, and the Sync button for the large breakpoint", () => {
    const html = render();
    const chip = classOf(html, /<span data-tone="[^"]+" title="[^"]+" class="([^"]*)"/).split(" ");
    expect(chip).toContain("shrink-0");
    expect(html).toMatch(/<button[^>]*aria-label="Sync orders from Shopify now"[^>]*class="[^"]*max-lg:hidden/);
  });
});

describe("TopBar sync chip on phones", () => {
  it("shows a stale sync at every width, with its tip", () => {
    state.value = {
      ...state.value,
      sync: {
        status: "ready",
        connection: {
          shopDomain: "x.myshopify.com",
          adminShopDomain: "x.myshopify.com",
          status: "ok",
          lastSyncAt: Date.now() - 5 * 3600000,
          lastError: null,
          catchingUp: false,
        },
        checkedAt: Date.now(),
      },
    };
    const html = render();
    const chip = classOf(html, /<span data-tone="red" title="([^"]+)"/);
    expect(chip).toContain("check the store connection");
    expect(classOf(html, /<span data-tone="red" title="[^"]+" class="([^"]*)"/).split(" ")[0]).toBe("inline-flex");
  });

  it("stays quiet while a copy too old to vouch for is re-read (a phone resumed after hours)", () => {
    const sync = state.value.sync as { connection: Record<string, unknown> };
    state.value = {
      ...state.value,
      sync: { status: "ready", connection: sync.connection, checkedAt: Date.now() - 5 * 3600000 },
    };
    const html = render();
    expect(html).not.toContain('data-tone="red"');
    expect(html).toContain("Checking sync");
    expect(classOf(html, /<span data-tone="slate" title="[^"]+" class="([^"]*)"/).split(" ")[0]).toBe("hidden");
  });
});

describe("TopBar Needs approval", () => {
  it("shows those who approve the queue with its count, and staff nothing", () => {
    state.value = { ...state.value, role: "manager", needsApproval: 3 };
    const html = render();
    expect(html).toContain('href="/?view=approval"');
    expect(html).toContain('aria-label="Needs approval, 3 waiting"');
    state.value = { ...state.value, role: "staff" };
    expect(render()).not.toContain("view=approval");
  });

  it("is a 40px icon below lg with its count on the corner, like the bell's, so a phone row with a sync problem keeps the workspace symbol clear", () => {
    state.value = { ...state.value, role: "manager", needsApproval: 3 };
    const html = render();
    const tag = html.match(/<a[^>]*aria-label="Needs approval, 3 waiting"[^>]*>/)?.[0] ?? "";
    const link = classOf(tag, /class="([^"]*)"/).split(" ");
    expect(link).toEqual(expect.arrayContaining(["relative", "h-10", "max-lg:w-10", "max-lg:px-0"]));
    expect(link).not.toContain("max-lg:px-2.5");
    const count = classOf(html, /aria-label="Needs approval, 3 waiting"[^>]*>[^]*?<span aria-hidden="true" class="([^"]*)">3<\/span>/).split(" ");
    expect(count).toEqual(expect.arrayContaining(["max-lg:absolute", "max-lg:right-0", "max-lg:top-0", "max-lg:ring-2", "max-lg:ring-surface"]));
    expect(count.filter((name) => name === "absolute" || name === "ring-2")).toEqual([]);
  });
});

describe("TopBar navigation", () => {
  it("shows Desk, People and Locations", () => {
    const html = renderToStaticMarkup(createElement(TopBar, { name: "Impact", images: { logo: null, symbol: null }, account: ACCOUNT }));
    expect(html).toContain('aria-label="Workspace"');
    expect(html).toContain('href="/people"');
    expect(html).toContain('href="/locations"');
  });

  it("keeps the links to icons below xl, so tablets keep one row and the workspace name", () => {
    const nav = render().match(/<nav aria-label="Workspace"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain("xl:not-sr-only");
    expect(nav).not.toMatch(/\b(sm|md|lg):not-sr-only/);
  });

  it("keeps the workspace symbol only on phones, so the links fit the one row", () => {
    expect(render()).toContain('<span class="min-w-0 max-sm:sr-only">');
  });

  it("gives the workspace name room from sm: the sync chip keeps its words for md up, and the name's lines never wrap", () => {
    const html = render(LONG_NAME);
    // The chip's tag, then its first span (the words) after the icon.
    const chip = html.match(/<span data-tone="[^"]+" title="[^"]+" class="([^"]*)">[^]*?<\/svg><span class="([^"]*)">/);
    expect(chip?.[2]).toBe("sr-only md:not-sr-only");
    expect(chip?.[1].split(" ")).toContain("md:px-3");
    expect(chip?.[1]).not.toContain("sm:px-3");
    expect(html).toMatch(/<span class="[^"]*\btruncate\b[^"]*">Ordering Desk<\/span>/);
  });
});
