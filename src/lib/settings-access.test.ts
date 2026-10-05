import { describe, it, expect } from "vitest";
import { SETTINGS_SECTION_LABELS, settingsAccess } from "./settings-access";

describe("settingsAccess", () => {
  // Phase 6: everyone has their own notification choices, first.
  it("shows staff their own notifications, the store status and the vendor list, editing nothing else", () => {
    expect(settingsAccess("staff")).toEqual({
      sections: ["alerts", "store", "vendors"],
      canEditStore: false,
      canEditTeam: false,
      canEditRosterTags: false,
      canEditStatuses: false,
      canEditVendors: false,
      canEditNotifications: false,
      canEditSender: false,
    });
  });

  it("gives managers the team, statuses, vendors and notifications, not the platform settings", () => {
    expect(settingsAccess("manager")).toEqual({
      sections: ["alerts", "store", "team", "statuses", "vendors", "notifications"],
      canEditStore: false,
      canEditTeam: true,
      canEditRosterTags: false,
      canEditStatuses: true,
      canEditVendors: true,
      canEditNotifications: true,
      canEditSender: false,
    });
  });

  it("gives platform admins everything", () => {
    expect(settingsAccess("platform")).toEqual({
      sections: ["alerts", "store", "team", "statuses", "vendors", "notifications", "domain", "branding"],
      canEditStore: true,
      canEditTeam: true,
      canEditRosterTags: true,
      canEditStatuses: true,
      canEditVendors: true,
      canEditNotifications: true,
      canEditSender: true,
    });
  });

  it("labels a person's own notifications apart from the workspace email settings", () => {
    expect(SETTINGS_SECTION_LABELS.alerts).toBe("Your notifications");
    expect(SETTINGS_SECTION_LABELS.notifications).toBe("Workspace email");
  });
});
