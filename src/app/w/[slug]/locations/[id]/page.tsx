import { notFound } from "next/navigation";
import { getLocationPage } from "@/server/lookup/locations";
import { guardLookupPage, lookupMetadata } from "@/server/lookup/pages";
import { LocationView } from "@/components/lookup/location-view";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("Location");
}

export default async function WorkspaceLocationPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const page = await guardLookupPage(slug, `/locations/${encodeURIComponent(id)}`);
  const data = await getLocationPage(page.db, page.workspace.id, id, Date.now());
  if (!data) {
    notFound();
  }
  return <LocationView data={data} basePath={page.basePath} />;
}
