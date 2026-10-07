// The guard every People and Locations page runs (design section 3: team
// members only). slug: the /w/[slug] route's slug, or null on the client
// host's own /people and /locations routes. Signed out goes to sign-in; a
// missing workspace, a non-member, another workspace on a client host and
// an unknown host get the not-found page; on a client host the
// workspace's own slug redirects to the short path.

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { workspaceIcons } from "@/lib/brand-assets";
import { workspaceAccountView } from "@/server/account";
import { AuthError, requireMemberBySlug } from "@/server/guard";
import { slugRouteForHost } from "@/server/host";
import { requestHost } from "@/server/request-host";

export async function guardLookupPage(slug: string | null, clientPath: string) {
  const host = await requestHost();
  let workspaceSlug: string;
  if (slug === null) {
    if (host.kind !== "workspace") {
      notFound();
    }
    workspaceSlug = host.workspace.slug;
  } else {
    const route = slugRouteForHost(host, slug);
    if (route.kind === "redirect") {
      redirect(clientPath);
    }
    if (route.kind === "not-found") {
      notFound();
    }
    workspaceSlug = slug;
  }
  try {
    const guarded = await requireMemberBySlug(workspaceSlug, "staff");
    return {
      ...guarded,
      clientHost: slug === null,
      basePath: slug === null ? "" : `/w/${encodeURIComponent(guarded.workspace.slug)}`,
    };
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.status === 401) {
        redirect("/sign-in");
      }
      notFound();
    }
    throw e;
  }
}

// The tab title and icon: the workspace's on its client host.
export async function lookupMetadata(title: string): Promise<Metadata> {
  const host = await requestHost();
  return host.kind === "workspace"
    ? { title: { absolute: `${title}, ${host.workspace.name} orders` }, icons: workspaceIcons(host.workspace.id, host.workspace.branding) }
    : { title };
}

// Words from ?q=, capped.
export function lookupQuery(q: string | string[] | undefined): string {
  return typeof q === "string" ? q.trim().slice(0, 60) : "";
}

// The client host shell's props, the account menu included (Wave 1a builds
// it the same way for the client host desk and Settings).
export async function clientShellProps(page: Awaited<ReturnType<typeof guardLookupPage>>) {
  return {
    workspace: page.workspace,
    role: page.role,
    userId: page.userId,
    clientHost: true,
    account: await workspaceAccountView(page.db, page.env, {
      viewer: page.viewer,
      name: page.session.user.name,
      role: page.role,
      clientHost: true,
    }),
  };
}
