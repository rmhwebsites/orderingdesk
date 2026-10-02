import { notFound, redirect } from "next/navigation";
import { AuthError, requireMemberBySlug } from "@/server/guard";
import { slugRouteForHost } from "@/server/host";
import { requestHost } from "@/server/request-host";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

// Per-viewer: reads the session.
export const dynamic = "force-dynamic";

// The workspace shell on the hub.
//
// Every /w/[slug] server component must call requireMemberBySlug itself;
// layouts are not an auth boundary. The cache() wrapper dedupes the work.
// Signed out goes to sign-in; a missing workspace, a non-member and an
// under-ranked member all get the same 404. On a client host the workspace
// lives at "/": its own slug redirects there and every other slug is not
// found (slugRouteForHost).
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const route = slugRouteForHost(await requestHost(), slug);
  if (route.kind === "redirect") {
    redirect(route.to);
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
  const { workspace, role, userId } = guarded;

  return (
    <WorkspaceShell workspace={workspace} role={role} userId={userId} clientHost={false}>
      {children}
    </WorkspaceShell>
  );
}
