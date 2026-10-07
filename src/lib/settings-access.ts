// Which Settings sections a role sees and which it may change (platform
// amendment section 2). Shared by the settings page loader (which only
// reads what a role may see) and its client sections (which hide controls);
// the API routes enforce every check on their own.
//
// - Everyone: their own notification choices and this device's push
//   (Your notifications), first.
// - Staff: the store's status and the vendor list, read only, and their
//   own AI connections (managers see and revoke everyone's).
// - Managers: also the team, statuses, search (time zone and the AI search
//   switch), vendors and the workspace email settings (who gets new order
//   and purchase order email).
// - Platform admins: everything, including the store connection, roster
//   tags, email sender, custom domain and branding.

import { roleAtLeast, type Role } from "./roles";

export type SettingsSection =
  | "alerts"
  | "store"
  | "ai"
  | "team"
  | "statuses"
  | "search"
  | "vendors"
  | "notifications"
  | "domain"
  | "branding";

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  alerts: "Your notifications",
  store: "Store connection",
  ai: "AI connections",
  team: "Team",
  statuses: "Statuses",
  search: "Search",
  vendors: "Vendors",
  notifications: "Workspace email",
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
  canEditSearch: boolean;
  canEditVendors: boolean;
  canEditNotifications: boolean;
  canEditSender: boolean;
};

export function settingsAccess(role: Role): SettingsAccess {
  const manager = roleAtLeast(role, "manager");
  const platform = roleAtLeast(role, "platform");
  const sections: SettingsSection[] = ["alerts", "store", "ai"];
  if (manager) {
    sections.push("team", "statuses", "search");
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
    canEditSearch: manager,
    canEditVendors: manager,
    canEditNotifications: manager,
    canEditSender: platform,
  };
}
