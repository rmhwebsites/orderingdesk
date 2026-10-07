import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiSettingsView } from "@/server/ai-connections";
import { AiConnectionsSection } from "./ai-connections";

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
});
