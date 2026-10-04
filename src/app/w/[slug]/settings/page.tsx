import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AuthError, requireMemberBySlug } from "@/server/guard";
import { slugRouteForHost } from "@/server/host";
import { requestHost } from "@/server/request-host";
import { loadSettingsPage } from "@/server/settings-page";
import { SettingsPage } from "@/components/settings/settings-page";

// Per-viewer: reads the session.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings" };

// Every /w/[slug] server component calls requireMemberBySlug itself;
// layouts are not an auth boundary. Every member may open Settings (each
// role sees its own sections); signed out goes to sign-in, anyone else
// gets the not-found page. On a client host the workspace's settings live
// at /settings.
export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const route = slugRouteForHost(await requestHost(), slug);
  if (route.kind === "redirect") {
    redirect("/settings");
  }
  if (route.kind === "not-found") {
    notFound();
  }
  let guarded: Awaited<ReturnType<typeof requireMemberBySlug>>;
  try {
    guarded = await requireMemberBySlug(slug, "staff");
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.status === 401) {
        redirect("/sign-in");
      }
      notFound();
    }
    throw e;
  }
  const { db, env, workspace, role, userId } = guarded;
  const data = await loadSettingsPage(db, env, {
    workspace,
    role,
    userId,
    basePath: `/w/${encodeURIComponent(workspace.slug)}`,
  });
  return <SettingsPage data={data} />;
}
