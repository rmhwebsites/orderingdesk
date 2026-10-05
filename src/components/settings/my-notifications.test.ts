import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MyNotificationsSection } from "./my-notifications";

// Settings > Your notifications, rendered on the server (no DOM in vitest:
// the device's push state is read in the browser after mounting, so the
// server render shows it loading).
function render(member: boolean, prefs = { pushNewOrders: true, emailNewOrders: false, pushAllActivity: true }) {
  return renderToStaticMarkup(
    createElement(MyNotificationsSection, { workspaceId: "ws_impact", workspaceName: "IMPACT Rentals", initial: { member, prefs } }),
  );
}

describe("MyNotificationsSection", () => {
  it("shows a member three switches with their saved values", () => {
    const html = render(true);
    expect(html).toContain("Your notifications");
    expect(html).toContain("Phone push for new orders and purchase orders");
    expect(html).toContain("Email for new orders and purchase orders");
    expect(html).toContain("Phone push for all other activity");
    const switches = html.match(/<input[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(3);
    expect(switches.map((input) => input.includes('checked=""'))).toEqual([true, false, true]);
    // Each switch is described by its help text.
    for (const input of switches) {
      expect(input).toMatch(/aria-describedby="alerts-[a-z-]+-help"/);
    }
  });

  it("has a device panel that loads in the browser", () => {
    const html = render(true);
    expect(html).toContain("This device");
    expect(html).toContain("Checking this device");
  });

  it("tells a platform admin who is not a member that this workspace does not notify them", () => {
    const html = render(false);
    expect(html).toContain("You are not a member of IMPACT Rentals, so it does not send you notifications.");
    expect(html).not.toContain('role="switch"');
  });
});
