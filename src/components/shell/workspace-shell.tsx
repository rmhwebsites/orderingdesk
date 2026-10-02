import { accentStyle } from "@/lib/accent";
import type { Role } from "@/lib/roles";
import { SyncBanner } from "./sync-banner";
import { TopBar } from "./top-bar";
import { WorkspaceProvider } from "./workspace-provider";
import { ToastProvider } from "@/components/toasts";

// The workspace shell: accent scope, providers, top bar, sync banner. Used
// by the /w/[slug] layout on the hub and by "/" on the workspace's own
// client host. Not an auth boundary: the caller has already run the guard.
export function WorkspaceShell({
  workspace,
  role,
  userId,
  clientHost,
  children,
}: {
  workspace: { id: string; slug: string; name: string; accentColor: string; logoUrl: string | null };
  role: Role;
  userId: string;
  // True on the workspace's own client host, which serves it at "/".
  clientHost: boolean;
  children: React.ReactNode;
}) {
  return (
    // The accent scope: the four accent variables come from the workspace's
    // validated #rrggbb accent (src/lib/accent.ts); globals.css derives the
    // per-theme strong accent and focus ring from them under this attribute.
    <div data-accent-scope style={accentStyle(workspace.accentColor)} className="min-h-dvh">
      <ToastProvider>
        <WorkspaceProvider
          workspace={{
            id: workspace.id,
            slug: workspace.slug,
            name: workspace.name,
            basePath: clientHost ? "" : `/w/${encodeURIComponent(workspace.slug)}`,
          }}
          role={role}
          userId={userId}
        >
          {/* Made inert while the order drawer is open (it renders into
              #workspace-overlays, inside the accent scope). */}
          <div id="workspace-main" className="flex min-h-dvh flex-col">
            <TopBar name={workspace.name} logoUrl={workspace.logoUrl} />
            <SyncBanner />
            <div className="flex-1">{children}</div>
          </div>
          <div id="workspace-overlays" />
        </WorkspaceProvider>
      </ToastProvider>
    </div>
  );
}
