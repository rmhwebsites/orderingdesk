import { brandImages } from "@/lib/brand-assets";
import type { WorkspaceBranding } from "@/lib/branding";
import type { Role } from "@/lib/roles";
import { DevicePushSetup, InstallHint } from "./app-install";
import { BrandScope } from "./brand-scope";
import { SyncBanner } from "./sync-banner";
import { TopBar } from "./top-bar";
import { WorkspaceProvider } from "./workspace-provider";
import { ToastProvider } from "@/components/toasts";

// The workspace shell: brand scope, providers, top bar, sync banner. Used
// by the /w/[slug] layout on the hub and by "/" on the workspace's own
// client host. Not an auth boundary: the caller has already run the guard.
export function WorkspaceShell({
  workspace,
  role,
  userId,
  clientHost,
  children,
}: {
  workspace: {
    id: string;
    slug: string;
    name: string;
    accentColor: string;
    branding: WorkspaceBranding | null;
  };
  role: Role;
  userId: string;
  // True on the workspace's own client host, which serves it at "/".
  clientHost: boolean;
  children: React.ReactNode;
}) {
  return (
    // The brand scope: the workspace's primary color, palette, fonts and
    // radius as CSS variables (src/lib/brand-theme.ts), which globals.css
    // maps onto every token inside it.
    <BrandScope branding={workspace.branding} accentColor={workspace.accentColor} className="min-h-dvh bg-bg font-sans text-ink">
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
              #workspace-overlays, inside the brand scope). */}
          <div id="workspace-main" className="flex min-h-dvh flex-col">
            <TopBar name={workspace.name} images={brandImages(workspace.id, workspace.branding)} />
            <SyncBanner />
            <InstallHint />
            <div className="flex-1">{children}</div>
          </div>
          <div id="workspace-overlays" />
          {/* The service worker for push notifications (public/sw.js). */}
          <DevicePushSetup />
        </WorkspaceProvider>
      </ToastProvider>
    </BrandScope>
  );
}
