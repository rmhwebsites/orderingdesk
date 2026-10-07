import { notFound } from "next/navigation";
import { getLocationPage } from "@/server/lookup/locations";
import { clientShellProps, guardLookupPage, lookupMetadata } from "@/server/lookup/pages";
import { LocationView } from "@/components/lookup/location-view";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

// /locations/[id] on a workspace's own client host; the hub has
// /w/<slug>/locations/[id].
export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("Location");
}

export default async function ClientHostLocationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await guardLookupPage(null, "");
  const data = await getLocationPage(page.db, page.workspace.id, id, Date.now());
  if (!data) {
    notFound();
  }
  return (
    <WorkspaceShell {...(await clientShellProps(page))}>
      <LocationView data={data} basePath="" />
    </WorkspaceShell>
  );
}
