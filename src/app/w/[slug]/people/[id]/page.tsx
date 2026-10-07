import { notFound } from "next/navigation";
import { guardLookupPage, lookupMetadata } from "@/server/lookup/pages";
import { getPersonPage } from "@/server/lookup/people";
import { PersonView } from "@/components/lookup/person-view";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("Person");
}

export default async function WorkspacePersonPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const page = await guardLookupPage(slug, `/people/${encodeURIComponent(id)}`);
  const data = await getPersonPage(page.db, page.workspace.id, id, Date.now());
  if (!data) {
    notFound();
  }
  return <PersonView data={data} basePath={page.basePath} />;
}
