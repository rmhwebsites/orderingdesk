// Which Settings sections a role sees and which it may change (platform
// amendment section 2). Shared by the settings page loader (which only
// reads what a role may see) and its client sections (which hide controls);
// the API routes enforce every check on their own.
//
// - Staff: the store's status and the vendor list, read only.
// - Managers: also the team, statuses, vendors and notification settings.
// - Platform admins: everything, including the store connection, roster
//   tags, email sender, custom domain and branding.

import { roleAtLeast, type Role } from "./roles";

export type SettingsSection = "store" | "team" | "statuses" | "vendors" | "notifications" | "domain" | "branding";

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  store: "Store connection",
  team: "Team",
  statuses: "Statuses",
  vendors: "Vendors",
  notifications: "Notifications and email",
  domain: "Custom domain",
  branding: "Branding",
};

export type SettingsAccess = {
  // In display order.
  sections: SettingsSection[];
  canEditStore: boolean;
  canEditTeam: boolean;
  canEditRosterTags: boolean;
  canEditStatuses: boolean;
  canEditVendors: boolean;
  canEditNotifications: boolean;
  canEditSender: boolean;
};

export function settingsAccess(role: Role): SettingsAccess {
  const manager = roleAtLeast(role, "manager");
  const platform = roleAtLeast(role, "platform");
  const sections: SettingsSection[] = ["store"];
  if (manager) {
    sections.push("team", "statuses");
  }
  sections.push("vendors");
  if (manager) {
    sections.push("notifications");
  }
  if (platform) {
    sections.push("domain", "branding");
  }
  return {
    sections,
    canEditStore: platform,
    canEditTeam: manager,
    canEditRosterTags: platform,
    canEditStatuses: manager,
    canEditVendors: manager,
    canEditNotifications: manager,
    canEditSender: platform,
  };
}
