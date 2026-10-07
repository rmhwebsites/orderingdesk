import { listLocationSummaries } from "@/server/lookup/locations";
import { guardLookupPage, lookupMetadata } from "@/server/lookup/pages";
import { LocationsListView } from "@/components/lookup/locations-list-view";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("Locations");
}

export default async function WorkspaceLocationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await guardLookupPage(slug, "/locations");
  const rows = await listLocationSummaries(page.db, page.workspace.id);
  return <LocationsListView rows={rows} basePath={page.basePath} />;
}
