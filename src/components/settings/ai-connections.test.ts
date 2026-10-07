import { describe, it, expect } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDate, formatDateTime } from "@/lib/format";
import type { AiSettingsView } from "@/server/ai-connections";
import { AiConnectionsSection, ConnectionRow, connectionDetails, revokeFocusOrder } from "./ai-connections";

const NOW = Date.parse("2026-10-07T15:00:00.000Z");

const view = (overrides: Partial<AiSettingsView> = {}): AiSettingsView => ({
  mcpUrl: "https://orders.example.com/mcp",
  teamAccess: true,
  limits: { readsPerDay: 1000, staffChangesPerDay: 50, managerChangesPerDay: 100 },
  connections: [
    {
      id: "g1",
      person: "Riley Oakes",
      mine: true,
      everyWorkspace: false,
      app: "Claude",
      clientDomain: "claude.ai",
      redirectHost: "claude.ai",
      access: "change",
      host: "orders.example.com",
      createdAt: NOW - 86400000,
      lastUsedAt: NOW - 60000,
      expiresAt: NOW + 89 * 86400000,
    },
  ],
  canManage: false,
  canSwitch: false,
  ...overrides,
});

const render = (initial: AiSettingsView) => renderToStaticMarkup(createElement(AiConnectionsSection, { workspaceId: "ws_impact", initial }));

// The first element of `type` in a rendered tree (host elements only), as
// in kit.test.ts.
function findElement(node: ReactNode, type: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return null;
  }
  return node.type === type ? node : findElement(node.props.children as ReactNode, type);
}

describe("AiConnectionsSection", () => {
  it("shows the address to add, the apps' steps and the person's own connection with Revoke", () => {
    const html = render(view());
    expect(html).toContain('id="ai"');
    expect(html).toContain("https://orders.example.com/mcp");
    expect(html).toContain("Copy");
    expect(html).toContain("Add custom connector");
    expect(html).toContain("Developer mode");
    expect(html).toContain("Claude");
    expect(html).toContain("Look up and change");
    expect(html).toContain("Revoke");
    // Owner decision 1 (Oct 7): connections last 90 days, fixed.
    expect(html).toContain("A connection lasts 90 days, then you connect again.");
    expect(html).not.toContain("Every workspace");
    expect(html).not.toContain("Daily limits");
    expect(html).not.toContain("Revoke all");
  });

  it("marks a platform admin's connection for every workspace", () => {
    const [own] = view().connections;
    const html = render(view({ canManage: true, canSwitch: true, connections: [{ ...own, id: "g2", person: "Avery Stone", everyWorkspace: true, host: "hub.example.com" }] }));
    expect(html).toContain("Every workspace");
  });

  it("says when there is nothing connected", () => {
    expect(render(view({ connections: [] }))).toContain("No AI apps are connected");
  });

  it("gives managers the daily limits and platform admins the switch and Revoke all", () => {
    const manager = render(view({ canManage: true }));
    expect(manager).toContain("Daily limits");
    expect(manager).toContain('value="1000"');
    expect(manager).not.toContain("Revoke all");
    const admin = render(view({ canManage: true, canSwitch: true }));
    expect(admin).toContain("AI connections for this workspace");
    expect(admin).toContain("Revoke all");
  });

  it("explains that AI connections are off", () => {
    expect(render(view({ teamAccess: false }))).toContain("AI connections are off for this workspace");
  });

  // The server renders in UTC (Workers) and the browser in its own zone, so
  // a date in the first render would not hydrate. Dates wait for mount, as
  // in store-connection.tsx and team.tsx.
  it("leaves every date out of the first render, so the server and the browser agree", () => {
    const [own] = view().connections;
    const html = render(view());
    for (const ms of [own.createdAt, own.lastUsedAt ?? 0, own.expiresAt]) {
      for (const timeZone of ["UTC", "America/Chicago", "America/Los_Angeles"]) {
        expect(html).not.toContain(formatDate(ms, timeZone));
      }
    }
    expect(html).not.toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
    expect(html).toContain("claude.ai");
  });

  it("shows when a connection was made, last used and expires once mounted", () => {
    const [own] = view().connections;
    expect(connectionDetails(own, 0)).toBe("claude.ai");
    expect(connectionDetails(own, NOW)).toBe(
      `claude.ai, connected ${formatDateTime(own.createdAt)}, last used ${formatDateTime(NOW - 60000)}, expires ${formatDateTime(own.expiresAt)}`,
    );
    expect(connectionDetails({ ...own, clientDomain: null, lastUsedAt: null }, NOW)).toBe(
      `connected ${formatDateTime(own.createdAt)}, not used yet, expires ${formatDateTime(own.expiresAt)}`,
    );
    expect(connectionDetails({ ...own, clientDomain: null }, 0)).toBe("");
  });
});

// The rows follow the Settings patterns for row actions (team.tsx,
// vendors.tsx, statuses.tsx): a button named for its row, focus kept while
// the action runs, and focus moved to the nearest row when the row goes.
// No DOM in vitest: the focus move itself is checked in the browser.
describe("connection rows", () => {
  const [own] = view().connections;
  const other = { ...own, id: "g3", person: "Jordan Vale", mine: false, app: "ChatGPT", clientDomain: "chatgpt.com", redirectHost: "chatgpt.com" };

  it("names the app and the person on every Revoke button", () => {
    const html = render(view({ canManage: true, connections: [own, other] }));
    expect(html).toContain('aria-label="Revoke Claude for you"');
    expect(html).toContain('aria-label="Revoke ChatGPT for Jordan Vale"');
    expect(html).toContain('data-connection="g1"');
    expect(html).toContain('data-connection="g3"');
  });

  // Disabling the button that was just clicked drops keyboard focus to the
  // page while the revoke runs, and again when it fails; a running revoke
  // marks every Revoke button aria-disabled instead and ignores clicks.
  it("keeps every Revoke button focusable while a revoke runs, and ignores clicks meanwhile", () => {
    const revoked: string[] = [];
    const row = (connection: typeof own, busyId: string | null) =>
      ConnectionRow({ connection, showPeople: true, canRevoke: true, busyId, now: 0, onRevoke: () => revoked.push(connection.id) });
    const button = (connection: typeof own, busyId: string | null) => findElement(row(connection, busyId), "button");

    const running = button(own, "g1");
    expect(running?.props["aria-disabled"]).toBe(true);
    expect(running?.props["aria-busy"]).toBe(true);
    expect(running?.props.disabled).toBeFalsy();
    const markup = renderToStaticMarkup(row(own, "g1"));
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Revoking");
    expect(markup).not.toMatch(/<button[^>]*\sdisabled=""/);

    const waiting = button(other, "g1");
    expect(waiting?.props["aria-disabled"]).toBe(true);
    expect(waiting?.props["aria-busy"]).toBeFalsy();
    expect(waiting?.props.disabled).toBeFalsy();

    (running?.props.onClick as () => void)();
    (waiting?.props.onClick as () => void)();
    expect(revoked).toEqual([]);

    const idle = button(other, null);
    expect(idle?.props["aria-disabled"]).toBeFalsy();
    (idle?.props.onClick as () => void)();
    expect(revoked).toEqual(["g3"]);
  });

  it("has no Revoke button on a row the viewer may not revoke", () => {
    expect(findElement(ConnectionRow({ connection: other, showPeople: true, canRevoke: false, busyId: null, now: 0, onRevoke: () => {} }), "button")).toBeNull();
  });

  // After a revoke, focus goes to the row that took the revoked row's
  // place, else the nearest one (the caller falls back to the section
  // heading when none is left). A revoke that failed leaves the row, and
  // focus stays on its button.
  it("moves focus to the nearest remaining row after a revoke, and stays when the row is still there", () => {
    expect(revokeFocusOrder(["a", "b", "c"], ["a", "c"], "b")).toEqual(["c", "a"]);
    expect(revokeFocusOrder(["a", "b", "c"], ["a", "b"], "c")).toEqual(["b", "a"]);
    expect(revokeFocusOrder(["a", "b", "c"], ["b", "c"], "a")).toEqual(["b", "c"]);
    expect(revokeFocusOrder(["a"], [], "a")).toEqual([]);
    expect(revokeFocusOrder(["a", "b"], ["a", "b"], "b")).toEqual(["b"]);
  });
});

