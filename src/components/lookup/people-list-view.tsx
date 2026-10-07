import Link from "next/link";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import type { PersonListRow } from "@/server/lookup/people";
import { ui } from "@/components/ui";

export function PeopleListView({
  data,
  query,
  basePath,
}: {
  data: { people: PersonListRow[]; total: number };
  query: string;
  basePath: string;
}) {
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">People</h1>
      <form role="search" method="get" action={`${basePath}/people`} className="relative max-w-md">
        <label htmlFor="people-search" className="sr-only">
          Search people by name or email
        </label>
        <MagnifyingGlassIcon size={16} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input id="people-search" name="q" type="search" defaultValue={query} placeholder="Name or email" enterKeyHint="search" className={`${ui.input} pl-10`} />
      </form>
      {data.people.length === 0 ? (
        <p className="text-sm text-ink-2">
          {query ? "Nobody matches. Try part of a name or an email." : "People appear here once they place a request or an order."}
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface">
          {data.people.map((person) => (
            <li key={person.id}>
              <Link
                href={`${basePath}/people/${encodeURIComponent(person.id)}`}
                className="flex min-h-14 flex-col gap-0.5 px-4 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{person.name}</span>
                  {person.email ? <span className="block truncate text-xs text-ink-2">{person.email}</span> : null}
                </span>
                <span className="truncate text-sm text-ink-2 sm:w-48">{person.locationName ?? "No location yet"}</span>
                <span className="text-xs tabular-nums text-ink-2 sm:w-40 sm:text-right">
                  {person.openCount.toLocaleString("en-US")} open, {person.cardCount.toLocaleString("en-US")} in all
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.total > data.people.length ? (
        <p className="text-xs text-ink-2">Showing the {data.people.length} most recent of {data.total.toLocaleString("en-US")}. Search to find anyone else.</p>
      ) : null}
    </main>
  );
}
