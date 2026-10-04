import { describe, it, expect } from "vitest";
import { settingsAccess } from "./settings-access";

describe("settingsAccess", () => {
  it("shows staff the store status and the vendor list, editing nothing", () => {
    expect(settingsAccess("staff")).toEqual({
      sections: ["store", "vendors"],
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
      sections: ["store", "team", "statuses", "vendors", "notifications"],
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
      sections: ["store", "team", "statuses", "vendors", "notifications", "domain", "branding"],
      canEditStore: true,
      canEditTeam: true,
      canEditRosterTags: true,
      canEditStatuses: true,
      canEditVendors: true,
      canEditNotifications: true,
      canEditSender: true,
    });
  });
});
