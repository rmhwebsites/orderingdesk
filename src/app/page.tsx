import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { accentStyle } from "@/lib/accent";
import { APP_NAME } from "@/lib/brand";
import { workspaceIcons } from "@/lib/brand-assets";
import { roleLabel } from "@/lib/roles";
import { AuthError, requireMemberBySlug, requireSession } from "@/server/guard";
import type { HostWorkspace } from "@/server/host";
import { hubView } from "@/server/hub";
import { requestHost } from "@/server/request-host";
import { listWorkspacesForViewer } from "@/server/workspaces";
import { Desk } from "@/components/desk/desk";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { ui } from "@/components/ui";
import { NewWorkspaceForm } from "./new-workspace-form";
import { SignOutButton } from "./sign-out-button";

// Per-viewer page: never prerender it at build time, where there is no session
// and getAuth() refuses to run without a deployed APP_URL.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const host = await requestHost();
  return host.kind === "workspace"
    ? {
        title: { absolute: `${host.workspace.name} orders` },
        icons: workspaceIcons(host.workspace.id, host.workspace.branding),
      }
    : {};
}

// "/" on a workspace's own client host is that workspace's desk, behind the
// same guards as /w/[slug]: signed out goes to this host's sign-in page; a
// signed-in person who is neither a member nor a platform admin gets the
// not-found page.
async function clientHostDesk(workspace: HostWorkspace) {
  let guarded: Awaited<ReturnType<typeof requireMemberBySlug>>;
  try {
    guarded = await requireMemberBySlug(workspace.slug, "staff");
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.status === 401) {
        redirect("/sign-in");
      }
      notFound();
    }
    throw e;
  }
  return (
    <WorkspaceShell workspace={guarded.workspace} role={guarded.role} userId={guarded.userId} clientHost>
      <Desk />
    </WorkspaceShell>
  );
}

// By host (src/server/host.ts): a client host shows its workspace's desk; an
// unknown host shows nothing (custom-worker.ts answers those before Next in
// production); the hub shows the workspace list.
//
// The hub. What it shows depends on the viewer (src/server/hub.ts): a
// platform admin sees every workspace and the New workspace form; a client
// with one workspace goes straight into it (the magic link lands here, so
// that is also what happens right after sign-in); a client with several
// sees only those; a client with none is told so. Clients never see the
// create form.
export default async function Home() {
  const host = await requestHost();
  if (host.kind === "workspace") {
    return clientHostDesk(host.workspace);
  }
  if (host.kind === "unknown") {
    notFound();
  }
  let guarded: Awaited<ReturnType<typeof requireSession>>;
  try {
    guarded = await requireSession();
  } catch (e) {
    if (e instanceof AuthError && e.status === 401) {
      redirect("/sign-in");
    }
    throw e;
  }
  const { db, viewer } = guarded;
  const view = hubView(viewer, await listWorkspacesForViewer(db, viewer));

  if (view.kind === "redirect") {
    redirect(view.to);
  }

  if (view.kind === "no-access") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 sm:px-6">
        <p className="text-sm font-medium text-ink-2">{APP_NAME}</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">No workspace yet</h1>
        <p className="text-sm text-ink-2">
          You do not have access to a workspace yet. Ask your manager to invite you.
        </p>
        <p className="break-words text-sm text-ink-2">Signed in as {viewer.email}</p>
        <div className="mt-2">
          <SignOutButton />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 break-words text-sm text-ink-2">Signed in as {viewer.email}</p>
          {viewer.platformAdmin ? (
            <p className="mt-1 text-xs font-semibold text-ink-2">{roleLabel("platform")}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>

      <section aria-labelledby="workspaces-heading" className="flex flex-col gap-3">
        <h2 id="workspaces-heading" className="font-display text-base font-semibold">
          {view.canCreate ? "All workspaces" : "Your workspaces"}
        </h2>
        {view.workspaces.length === 0 ? (
          <p className={`${ui.panel} px-4 py-5 text-sm text-ink-2`}>No workspaces yet. Create one below.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.workspaces.map((workspace) => (
              <li key={workspace.id} style={accentStyle(workspace.accentColor)} data-brand-scope="">
                <Link
                  href={`/w/${encodeURIComponent(workspace.slug)}`}
                  className={`${ui.panel} flex items-center gap-3 px-4 py-3 transition-colors hover:border-primary-strong`}
                >
                  <span
                    aria-hidden
                    className="grid size-9 shrink-0 place-items-center rounded-control bg-primary font-display text-sm font-semibold text-primary-ink"
                  >
                    {workspace.name.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{workspace.name}</span>
                  {workspace.role === "platform" ? null : (
                    <span className="text-xs font-medium text-ink-2">{roleLabel(workspace.role)}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.canCreate ? (
        <section aria-labelledby="new-workspace-heading" className="flex flex-col gap-3">
          <h2 id="new-workspace-heading" className="font-display text-base font-semibold">
            New workspace
          </h2>
          <NewWorkspaceForm />
        </section>
      ) : null}
    </main>
  );
}
