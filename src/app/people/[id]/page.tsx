import { notFound } from "next/navigation";
import { clientShellProps, guardLookupPage, lookupMetadata } from "@/server/lookup/pages";
import { getPersonPage } from "@/server/lookup/people";
import { PersonView } from "@/components/lookup/person-view";
import { WorkspaceShell } from "@/components/shell/workspace-shell";

// /people/[id] on a workspace's own client host; the hub has
// /w/<slug>/people/[id].
export const dynamic = "force-dynamic";

export function generateMetadata() {
  return lookupMetadata("Person");
}

export default async function ClientHostPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await guardLookupPage(null, "");
  const data = await getPersonPage(page.db, page.workspace.id, id, Date.now());
  if (!data) {
    notFound();
  }
  return (
    <WorkspaceShell {...(await clientShellProps(page))}>
      <PersonView data={data} basePath="" />
    </WorkspaceShell>
  );
}
