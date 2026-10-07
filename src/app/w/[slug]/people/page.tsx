import { guardLookupPage, lookupMetadata, lookupQuery } from "@/server/lookup/pages";
import { listPeople } from "@/server/lookup/people";
import { PeopleListView } from "@/components/lookup/people-list-view";

// Per viewer: reads the session. The guard runs here, not only in the layout.
export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("People");
}

export default async function WorkspacePeoplePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { slug } = await params;
  const query = lookupQuery((await searchParams).q);
  const page = await guardLookupPage(slug, query ? `/people?q=${encodeURIComponent(query)}` : "/people");
  const data = await listPeople(page.db, page.workspace.id, { q: query });
  return <PeopleListView data={data} query={query} basePath={page.basePath} />;
}
