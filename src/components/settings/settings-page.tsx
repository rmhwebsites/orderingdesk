import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { APP_NAME } from "@/lib/brand";
import { roleLabel } from "@/lib/roles";
import { SETTINGS_SECTION_LABELS } from "@/lib/settings-access";
import type { SettingsPageData } from "@/server/settings-page";
import { ui } from "@/components/ui";
import { BrandingSection } from "./branding";
import { CustomDomainSection } from "./custom-domain";
import { InlineMessage } from "./kit";
import { MyNotificationsSection } from "./my-notifications";
import { NotificationsSection } from "./notifications";
import { SearchSection } from "./search-settings";
import { StatusesSection } from "./statuses";
import { StoreConnectionSection } from "./store-connection";
import { TeamSection } from "./team";
import { VendorsSection } from "./vendors";

// The Settings page body, inside the workspace shell. Each role sees its
// own sections (src/lib/settings-access.ts); the loader left out the data
// of every other section (src/server/settings-page.ts).
export function SettingsPage({ data }: { data: SettingsPageData }) {
  const { workspace, access } = data;
  const ordersHref = workspace.basePath === "" ? "/" : workspace.basePath;
  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-5 sm:px-6 sm:pt-7">
      <div className="flex flex-col items-start gap-2">
        <Link href={ordersHref} className={`${ui.buttonQuiet} -ml-3`}>
          <ArrowLeftIcon size={16} aria-hidden />
          Orders
        </Link>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="text-sm text-ink-2">
          {workspace.name}. You are signed in as {roleLabel(data.role).toLowerCase()}
          {data.role === "staff" ? ", so you can change your own notifications and see the rest." : "."}
        </p>
        {data.hubSettingsUrl ? (
          <div className="mt-2 w-full max-w-3xl">
            <InlineMessage tone="info">
              Platform admin settings (store connection, branding, custom domain and email sender) are only
              available on {APP_NAME}.{" "}
              <a href={data.hubSettingsUrl} className="font-semibold underline underline-offset-2">
                Open these settings on {APP_NAME}
              </a>
            </InlineMessage>
          </div>
        ) : null}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="Settings sections" className="-mx-4 min-w-0 sm:-mx-6 lg:mx-0">
          <ul className="flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 sm:scroll-px-6 sm:px-6 lg:sticky lg:top-24 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0">
            {access.sections.map((section) => (
              <li key={section} className="shrink-0 snap-start">
                <a
                  href={`#${section}`}
                  className="inline-flex h-9 items-center whitespace-nowrap rounded-control border border-line px-3.5 text-sm text-ink-2 transition-colors hover:bg-surface hover:text-ink lg:flex lg:border-transparent lg:px-3"
                >
                  {SETTINGS_SECTION_LABELS[section]}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 max-w-5xl flex-col gap-12">
          <MyNotificationsSection workspaceId={workspace.id} workspaceName={workspace.name} initial={data.alerts} />
          <StoreConnectionSection workspaceId={workspace.id} initial={data.connection} canEdit={access.canEditStore} />
          {data.team ? (
            <TeamSection
              workspaceId={workspace.id}
              viewerUserId={data.viewerUserId}
              initial={data.team}
              canEditRosterTags={access.canEditRosterTags}
            />
          ) : null}
          {data.statuses ? <StatusesSection workspaceId={workspace.id} initial={data.statuses} queue={data.queue} /> : null}
          {data.search ? <SearchSection workspaceId={workspace.id} initial={data.search} /> : null}
          <VendorsSection workspaceId={workspace.id} initial={data.vendors} canEdit={access.canEditVendors} />
          {data.notifications ? (
            <NotificationsSection
              workspaceId={workspace.id}
              settings={data.notifications}
              sender={data.sender}
              domain={data.domain?.domain ?? null}
            />
          ) : null}
          {data.domain ? <CustomDomainSection workspaceId={workspace.id} initial={data.domain} /> : null}
          {data.branding ? (
            <BrandingSection
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              initial={data.branding.view}
              accentColor={data.branding.accentColor}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}
