import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RosterRequests, RosterRequestView } from "@/server/roster";
import { TeamSection } from "./team";

// Settings > Team as a manager sees it, rendered on the server (no DOM in
// vitest; focus moves are checked in the browser).
const request = (overrides: Partial<RosterRequestView>): RosterRequestView => ({
  id: "r1",
  email: "asks@example.com",
  role: "manager",
  currentRole: null,
  since: Date.parse("2026-10-03T12:00:00Z"),
  deniedAt: null,
  ...overrides,
});

function render(requests: RosterRequests) {
  return renderToStaticMarkup(
    createElement(TeamSection, {
      workspaceId: "ws_impact",
      viewerUserId: "u_lead",
      canEditRosterTags: false,
      initial: {
        members: [{ userId: "u_lead", role: "manager", source: "manual", email: "lead@example.com", name: null }],
        invites: [],
        requests,
        rosterTags: { manager: "Ordering Desk Manager", staff: "Ordering Desk Staff" },
      },
    }),
  );
}

describe("TeamSection tag requests", () => {
  it("lists each request waiting for approval with its tag's role, Approve and Deny", () => {
    const html = render({
      waiting: [request({}), request({ id: "r2", email: "raise@example.com", role: "manager", currentRole: "staff" })],
      denied: [],
    });
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("asks@example.com");
    expect(html).toContain("Manager tag");
    expect(html).toContain('aria-label="Approve asks@example.com as manager"');
    expect(html).toContain('aria-label="Deny asks@example.com"');
    // A raise says what they have until it is approved.
    expect(html).toContain("staff until approved");
    expect(html).not.toContain("Denied (");
  });

  it("keeps denied requests in a collapsed list, each with Approve", () => {
    const html = render({ waiting: [], denied: [request({ id: "r9", email: "no@example.com", role: "staff", deniedAt: 5 })] });
    expect(html).toMatch(/<details(?![^>]*\bopen\b)[^>]*>\s*<summary[^>]*>Denied \(1\)<\/summary>/);
    expect(html).toContain('aria-label="Approve no@example.com as staff"');
    expect(html).not.toContain('aria-label="Deny no@example.com"');
    expect(html).toContain("Nobody is waiting");
  });

  it("explains that a tag requests access and a manager approves it once", () => {
    const html = render({ waiting: [], denied: [] });
    expect(html).toContain("Tagging a customer in Shopify only requests access");
    expect(html).toContain("a manager approves it here once");
    // No requests: no approval panel.
    expect(html).not.toContain("Waiting for approval");
  });
});
