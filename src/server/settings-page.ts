// What the Settings page (/w/[slug]/settings on the hub, /settings on a
// client host) renders, read in one place by role (src/lib/settings-access
// .ts): a section the role cannot see is null here, so its data never
// reaches the page. The page's server component has already run the guard.

import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { statuses, workspaces } from "@/db/schema";
import type { WorkspaceBranding } from "@/lib/branding";
import type { QueueSettingsView } from "@/lib/queue-settings";
import type { Role } from "@/lib/roles";
import { settingsAccess, type SettingsAccess } from "@/lib/settings-access";
import { brandingView, type BrandingView } from "./branding/assets";
import { getConnectionSettings, type ConnectionSettingsView } from "./desk/connection-view";
import { getQueueSettings } from "./desk/queue-settings";
import { getWorkspaceSettings } from "./desk/settings";
import { statusView, type SettingsView, type StatusView } from "./desk/shapes";
import { listVendors, type VendorView } from "./desk/vendors";
import type { DomainView } from "./domains";
import { loadMailWorkspace } from "./email/workspace";
import { appOrigin } from "./host";
import { listMembers, type MemberView, type PendingInviteView } from "./members";
import { getNotificationPrefs, type NotificationPrefsView } from "./notification-prefs";
import { resolveRosterTags, type RosterRequests } from "./roster";
import { senderView, type SenderView } from "./sender";
import type { RosterTags } from "@/db/schema";

export type SettingsPageData = {
  workspace: { id: string; name: string; slug: string; basePath: string };
  role: Role;
  viewerUserId: string;
  access: SettingsAccess;
  // The viewer's own notification choices here (everyone sees this
  // section); member is false for a platform admin who is not a member.
  alerts: { member: boolean; prefs: NotificationPrefsView };
  connection: ConnectionSettingsView | null;
  vendors: VendorView[];
  team: { members: MemberView[]; invites: PendingInviteView[]; requests: RosterRequests; rosterTags: RosterTags } | null;
  statuses: StatusView[] | null;
  // The work queue settings (age thresholds, price display), shown with
  // the statuses.
  queue: QueueSettingsView | null;
  notifications: SettingsView | null;
  // Settings > Search: the time zone and the AI search switch.
  search: SettingsView | null;
  sender: SenderView | null;
  domain: DomainView | null;
  branding: { view: BrandingView; accentColor: string } | null;
  // A platform admin on a client host works there as a manager (platform
  // powers stay on the hub, see src/server/guard.ts): the hub's Settings
  // for this workspace, where the rest is. Null for everyone else.
  hubSettingsUrl: string | null;
};

type SettingsWorkspace = Pick<
  typeof workspaces.$inferSelect,
  "id" | "name" | "slug" | "accentColor" | "customDomain" | "customDomainStatus" | "rosterTags"
> & { branding: WorkspaceBranding | null };

export async function loadSettingsPage(
  db: Db,
  env: CloudflareEnv,
  input: {
    workspace: SettingsWorkspace;
    role: Role;
    userId: string;
    basePath: string;
    platformAdminOnClientHost?: boolean;
  },
): Promise<SettingsPageData> {
  const { workspace, role } = input;
  const access = settingsAccess(role);
  const shows = (section: SettingsAccess["sections"][number]) => access.sections.includes(section);

  const [alerts, connection, vendors, team, statusRows, settings, mail, queue] = await Promise.all([
    getNotificationPrefs(db, workspace.id, input.userId),
    getConnectionSettings(db, workspace.id),
    listVendors(db, workspace.id),
    shows("team") ? listMembers(db, workspace.id, { includeInvites: true }) : Promise.resolve(null),
    shows("statuses")
      ? db.select().from(statuses).where(eq(statuses.workspaceId, workspace.id)).orderBy(asc(statuses.sort), asc(statuses.key))
      : Promise.resolve(null),
    shows("notifications") || shows("search") ? getWorkspaceSettings(db, workspace.id) : Promise.resolve(null),
    access.canEditSender ? loadMailWorkspace(db, workspace.id) : Promise.resolve(null),
    shows("statuses") ? getQueueSettings(db, workspace.id) : Promise.resolve(null),
  ]);

  return {
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, basePath: input.basePath },
    role,
    viewerUserId: input.userId,
    access,
    alerts,
    connection,
    vendors,
    team: team
      ? {
          members: team.members,
          invites: team.invites ?? [],
          requests: team.requests ?? { waiting: [], denied: [], approved: [] },
          rosterTags: resolveRosterTags(workspace.rosterTags),
        }
      : null,
    statuses: statusRows ? statusRows.map(statusView) : null,
    queue,
    notifications: shows("notifications") && settings ? settings.settings : null,
    search: shows("search") && settings ? settings.settings : null,
    sender: mail ? senderView(env, mail) : null,
    domain: shows("domain") ? { domain: workspace.customDomain, status: workspace.customDomainStatus } : null,
    branding: shows("branding")
      ? { view: brandingView(workspace.id, workspace.branding), accentColor: workspace.accentColor }
      : null,
    hubSettingsUrl: input.platformAdminOnClientHost
      ? `${appOrigin(env)}/w/${encodeURIComponent(workspace.slug)}/settings`
      : null,
  };
}
