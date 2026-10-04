import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { GearSixIcon } from "@phosphor-icons/react/dist/ssr/GearSix";
import { APP_NAME } from "@/lib/brand";
import { roleLabel } from "@/lib/roles";
import type { AdminPageData } from "@/server/admin-page";
import { NewWorkspaceForm } from "@/app/new-workspace-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { ui } from "@/components/ui";
import { PlatformAdmins } from "./platform-admins";

const DOMAIN_TONE = { pending: "amber", active: "green", error: "red" } as const;
const DOMAIN_LABEL = { pending: "pending", active: "active", error: "not reachable" } as const;

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4">
      <div>
        <h2 id={`${id}-heading`} className="font-display text-lg font-semibold text-ink">
          {title}
        </h2>
        <p className="mt-1 max-w-[65ch] text-sm text-ink-2">{description}</p>
      </div>
      {children}
    </section>
  );
}

// The platform admin screen on the hub, in the Ordering Desk look (no
// workspace branding here).
export function AdminScreen({ data }: { data: AdminPageData }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-12 px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Link href="/" className={`${ui.buttonQuiet} -ml-3`}>
            <ArrowLeftIcon size={16} aria-hidden />
            Workspaces
          </Link>
          <ThemeToggle />
        </div>
        <div>
          <p className="text-sm font-medium text-ink-2">{APP_NAME}</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Platform admin</h1>
        </div>
      </header>

      <Section id="admin-workspaces" title="Workspaces" description="Every workspace on the platform. Open one to work in it, or go straight to its settings.">
        {data.workspaces.length === 0 ? (
          <p className={`${ui.panel} px-4 py-5 text-sm text-ink-2`}>No workspaces yet. Create the first one below.</p>
        ) : (
          <ul className={`${ui.panel} flex flex-col divide-y divide-line`}>
            {data.workspaces.map((workspace) => (
              <li key={workspace.id} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{workspace.name}</p>
                  <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
                    <span className="font-mono text-xs">/w/{workspace.slug}</span>
                    <span>
                      {workspace.members} {workspace.members === 1 ? "member" : "members"}
                    </span>
                    {workspace.customDomain ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span className="break-all font-mono text-xs">{workspace.customDomain}</span>
                        {workspace.customDomainStatus ? (
                          <span data-tone={DOMAIN_TONE[workspace.customDomainStatus]} className="text-xs font-semibold text-tone-text">
                            {DOMAIN_LABEL[workspace.customDomainStatus]}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link href={`/w/${encodeURIComponent(workspace.slug)}/settings`} className={ui.buttonQuiet}>
                    <GearSixIcon size={16} aria-hidden />
                    Settings
                  </Link>
                  <Link href={`/w/${encodeURIComponent(workspace.slug)}`} className={ui.buttonSecondary}>
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className={`${ui.panel} p-4 sm:p-5`}>
          <NewWorkspaceForm />
        </div>
      </Section>

      <Section
        id="admin-admins"
        title="Platform admins"
        description="People who see and manage every workspace: stores, branding, domains and email senders."
      >
        <PlatformAdmins initial={data.admins} viewerUserId={data.viewerUserId} />
      </Section>

      <Section id="admin-users" title="Users" description="Everyone with an account, and the workspaces they belong to.">
        {data.users.length === 0 ? (
          <p className={`${ui.panel} px-4 py-5 text-sm text-ink-2`}>Nobody has signed in yet.</p>
        ) : (
          <ul className={`${ui.panel} flex flex-col divide-y divide-line`}>
            {data.users.map((user) => (
              <li key={user.userId} className="flex flex-col gap-1.5 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4">
                <div className="min-w-0 sm:w-72 sm:shrink-0">
                  <p className="break-all text-sm font-medium text-ink">{user.name ?? user.email}</p>
                  {user.name ? <p className="break-all text-sm text-ink-2">{user.email}</p> : null}
                  {user.platformAdmin ? (
                    <p data-tone="blue" className="mt-1 text-xs font-semibold text-tone-text">
                      {roleLabel("platform")}
                    </p>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  {user.memberships.length === 0 ? (
                    <p className="text-ink-2">{user.platformAdmin ? "Every workspace, as a platform admin" : "No workspace"}</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {user.memberships.map((membership) => (
                        <li key={membership.workspaceId} className="text-ink">
                          <Link href={`/w/${encodeURIComponent(membership.slug)}`} className="font-medium underline-offset-4 hover:underline">
                            {membership.workspaceName}
                          </Link>
                          <span className="text-ink-2">
                            {", "}
                            {roleLabel(membership.role)}
                            {membership.source === "shopify" ? ", from a Shopify tag" : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
