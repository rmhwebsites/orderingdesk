import { clientShellProps, guardLookupPage, lookupMetadata, lookupQuery } from "@/server/lookup/pages";
import { listPeople } from "@/server/lookup/people";
import { PeopleListView } from "@/components/lookup/people-list-view";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

// /people on a workspace's own client host; the hub has /w/<slug>/people.
export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("People");
}

export default async function ClientHostPeoplePage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const query = lookupQuery((await searchParams).q);
  const page = await guardLookupPage(null, "");
  const data = await listPeople(page.db, page.workspace.id, { q: query });
  return (
    <WorkspaceShell {...(await clientShellProps(page))}>
      <PeopleListView data={data} query={query} basePath="" />
    </WorkspaceShell>
  );
}
