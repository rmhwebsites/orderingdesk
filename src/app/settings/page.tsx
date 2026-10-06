import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { workspaceIcons } from "@/lib/brand-assets";
import { workspaceAccountView } from "@/server/account";
import { AuthError, requireMemberBySlug } from "@/server/guard";
import { requestHost } from "@/server/request-host";
import { loadSettingsPage } from "@/server/settings-page";
import { SettingsPage } from "@/components/settings/settings-page";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

// Reads the request host and the session, so it is rendered per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const host = await requestHost();
  return host.kind === "workspace"
    ? {
        title: { absolute: `Settings, ${host.workspace.name} orders` },
        icons: workspaceIcons(host.workspace.id, host.workspace.branding),
      }
    : {};
}

// /settings on a workspace's own client host: that workspace's Settings,
// behind the same guards as /w/[slug]/settings (signed out goes to this
// host's sign-in page; a signed-in person who is neither a member nor a
// platform admin gets the not-found page). The hub keeps its settings
// under /w/<slug>/settings, so /settings does not exist there.
export default async function ClientHostSettingsPage() {
  const host = await requestHost();
  if (host.kind !== "workspace") {
    notFound();
  }
  let guarded: Awaited<ReturnType<typeof requireMemberBySlug>>;
  try {
    guarded = await requireMemberBySlug(host.workspace.slug, "staff");
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.status === 401) {
        redirect("/sign-in");
      }
      notFound();
    }
    throw e;
  }
  const { db, env, workspace, role, userId, viewer, session } = guarded;
  const [data, account] = await Promise.all([
    loadSettingsPage(db, env, {
      workspace,
      role,
      userId,
      basePath: "",
      platformAdminOnClientHost: viewer.platformAdminOnClientHost === true,
    }),
    workspaceAccountView(db, env, { viewer, name: session.user.name, role, clientHost: true }),
  ]);
  return (
    <WorkspaceShell workspace={workspace} role={role} userId={userId} clientHost account={account}>
      <SettingsPage data={data} />
    </WorkspaceShell>
  );
}
