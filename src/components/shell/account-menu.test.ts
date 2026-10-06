import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace() {}, refresh() {} }) }));

const { AccountMenu, AccountMenuPanel } = await import("./account-menu");

const ACCOUNT = { name: "Casey Lin", email: "casey@example.com", roleLabel: "Manager", switchHref: "/", links: [] };

describe("AccountMenu", () => {
  it("is one closed button with the person's initials", () => {
    const html = renderToStaticMarkup(createElement(AccountMenu, { account: ACCOUNT }));
    expect(html).toContain('aria-label="Account menu for Casey Lin"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">CL<");
    expect(html).not.toContain("Sign out");
  });
});

describe("AccountMenuPanel", () => {
  it("lists who is signed in, their role, the theme, switch workspace and Sign out", () => {
    const html = renderToStaticMarkup(createElement(AccountMenuPanel, { account: ACCOUNT, settingsHref: "/w/impact/settings", sync: null }));
    expect(html).toContain("Casey Lin");
    expect(html).toContain("casey@example.com");
    expect(html).toContain("Manager");
    expect(html).toContain('name="theme"');
    expect(html).toContain(">Light<");
    expect(html).toContain("Switch workspace");
    expect(html).toContain('href="/w/impact/settings"');
    expect(html).toContain(">Sign out<");
  });

  it("leaves out Switch workspace when there is nowhere to go, and shows extra links", () => {
    const html = renderToStaticMarkup(
      createElement(AccountMenuPanel, {
        account: { ...ACCOUNT, switchHref: null, links: [{ href: "/admin", label: "Platform admin" }] },
        settingsHref: null,
        sync: null,
      }),
    );
    expect(html).not.toContain("Switch workspace");
    expect(html).toContain('href="/admin"');
  });

  it("offers Sync now with the sync state below the large breakpoint", () => {
    const html = renderToStaticMarkup(
      createElement(AccountMenuPanel, {
        account: ACCOUNT,
        settingsHref: null,
        sync: { label: "Synced 5 h ago", tip: "Press Sync to fetch new orders now.", running: false, disabled: false, onSync: () => {} },
      }),
    );
    expect(html).toContain("Sync now");
    expect(html).toContain("Synced 5 h ago. Press Sync to fetch new orders now.");
    expect(html).toMatch(/<li class="lg:hidden">/);
  });
});
