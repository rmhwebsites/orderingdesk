import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberView } from "@/server/members";
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

const LEAD: MemberView = { userId: "u_lead", role: "manager", source: "manual", email: "lead@example.com", name: null };

function render(requests: RosterRequests, members: MemberView[] = [LEAD]) {
  return renderToStaticMarkup(
    createElement(TeamSection, {
      workspaceId: "ws_impact",
      viewerUserId: "u_lead",
      canEditRosterTags: false,
      initial: {
        members,
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
      approved: [],
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
    const html = render({
      waiting: [],
      denied: [request({ id: "r9", email: "no@example.com", role: "staff", deniedAt: 5 })],
      approved: [],
    });
    expect(html).toMatch(/<details(?![^>]*\bopen\b)[^>]*>\s*<summary[^>]*>Denied \(1\)<\/summary>/);
    expect(html).toContain('aria-label="Approve no@example.com as staff"');
    expect(html).not.toContain('aria-label="Deny no@example.com"');
    expect(html).toContain("Nobody is waiting");
  });

  it("explains that a tag requests access and a manager approves it once", () => {
    const html = render({ waiting: [], denied: [], approved: [] });
    expect(html).toContain("Tagging a customer in Shopify only requests access");
    expect(html).toContain("a manager approves it here once");
    // No requests: no approval panel.
    expect(html).not.toContain("Waiting for approval");
  });

  // Approving adds nobody: like an invite, the person joins when they next
  // sign in, and the request shows as approved until then, whether or not
  // they have an account.
  it("lists approved requests nobody has signed in for yet, each with Revoke and no Approve", () => {
    const html = render({
      waiting: [],
      denied: [],
      approved: [request({ id: "r5", email: "ok@example.com", role: "staff", currentRole: "staff" })],
    });
    expect(html).toContain("Approved, waiting to sign in");
    expect(html).toContain("ok@example.com");
    expect(html).toContain("Staff tag");
    expect(html).toContain('aria-label="Revoke the approval for ok@example.com"');
    expect(html).not.toContain('aria-label="Approve ok@example.com as staff"');
    expect(html).not.toContain('aria-label="Deny ok@example.com"');
  });
});

describe("TeamSection members", () => {
  // A manual role always wins over a tag, so an approved tag request for a
  // manual member changes nothing visible; removing the member denies it.
  it("shows a manual member's approved tag request next to them", () => {
    const html = render({ waiting: [], denied: [], approved: [] }, [
      LEAD,
      { userId: "u_crew", role: "staff", source: "manual", email: "crew@example.com", name: null, tagRole: "manager" },
      { userId: "u_plain", role: "staff", source: "manual", email: "plain@example.com", name: null },
    ]);
    expect(html).toContain("Also approved as manager through a Shopify tag");
    expect(html).toContain("removing them denies that request");
    expect(html.match(/Also approved as/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Remove crew@example.com"');
  });
});
