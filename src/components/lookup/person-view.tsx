import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { MapPinIcon } from "@phosphor-icons/react/dist/ssr/MapPin";
import type { PersonPage } from "@/server/lookup/people";
import { ui } from "@/components/ui";
import { CardList, deskHref, ItemTable, LookupSection, StatTiles } from "./card-list";

export function PersonView({ data, basePath }: { data: PersonPage; basePath: string }) {
  const { person, counts } = data;
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col items-start gap-2">
        <Link href={`${basePath}/people`} className={`${ui.buttonQuiet} -ml-3`}>
          <ArrowLeftIcon size={16} aria-hidden />
          People
        </Link>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{person.name}</h1>
        {person.email ? <p className="break-all text-sm text-ink-2">{person.email}</p> : null}
        {person.homeLocation ? (
          <Link
            href={`${basePath}/locations/${encodeURIComponent(person.homeLocation.id)}`}
            className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-ink underline-offset-4 hover:underline"
          >
            <MapPinIcon size={16} aria-hidden />
            {person.homeLocation.name}
          </Link>
        ) : null}
      </div>
      <StatTiles
        stats={[
          { label: "Open", value: counts.open },
          { label: "Approved", value: counts.approved },
          { label: "Rejected", value: counts.rejected },
          { label: "Cancelled", value: counts.cancelled },
        ]}
      />
      <LookupSection id="person-items" title="Items and sizes, last 12 months">
        <ItemTable items={data.items} empty="Nothing ordered in the last 12 months." />
      </LookupSection>
      <LookupSection
        id="person-cards"
        title="Every request and order"
        count={counts.cards}
        action={
          <Link
            href={deskHref(basePath, { requester: person.id, view: "all" })}
            className="inline-flex min-h-10 items-center text-sm font-semibold text-ink underline underline-offset-2"
          >
            See all on the desk
          </Link>
        }
      >
        <CardList cards={data.cards} statuses={data.statuses} basePath={basePath} timeZone={data.timeZone} empty="No requests or orders yet." />
        {counts.cards > data.cards.length ? (
          <p className="text-xs text-ink-2">Showing the newest {data.cards.length.toLocaleString("en-US")}. The desk has all of them.</p>
        ) : null}
      </LookupSection>
    </main>
  );
}
