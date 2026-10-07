import { listLocationSummaries } from "@/server/lookup/locations";
import { clientShellProps, guardLookupPage, lookupMetadata } from "@/server/lookup/pages";
import { LocationsListView } from "@/components/lookup/locations-list-view";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

// /locations on a workspace's own client host; the hub has
// /w/<slug>/locations.
export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("Locations");
}

export default async function ClientHostLocationsPage() {
  const page = await guardLookupPage(null, "");
  const rows = await listLocationSummaries(page.db, page.workspace.id);
  return (
    <WorkspaceShell {...(await clientShellProps(page))}>
      <LocationsListView rows={rows} basePath="" />
    </WorkspaceShell>
  );
}
