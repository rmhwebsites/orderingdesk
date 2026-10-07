import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import type { LocationPage } from "@/server/lookup/locations";
import { locationAddressLines, readLocationAddress } from "@/lib/address";
import { AddressBlock } from "@/components/address-block";
import { ui } from "@/components/ui";
import { CardList, deskHref, ItemTable, LookupSection } from "./card-list";

export function LocationView({ data, basePath }: { data: LocationPage; basePath: string }) {
  const { location } = data;
  // Wave 1b's formatter; no heading here, the page title is the name.
  const address = readLocationAddress(location.address);
  const block = address ? { heading: null, lines: locationAddressLines(address), phone: address.phone || null } : null;
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col items-start gap-2">
        <Link href={`${basePath}/locations`} className={`${ui.buttonQuiet} -ml-3`}>
          <ArrowLeftIcon size={16} aria-hidden />
          Locations
        </Link>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{location.name}</h1>
        <AddressBlock block={block} empty="No address on file in Shopify." />
        {!location.active ? <p className="text-sm text-ink-2">No longer an active company location in Shopify.</p> : null}
      </div>
      <LookupSection
        id="location-open"
        title="Open"
        count={data.openCount}
        action={
          <Link href={deskHref(basePath, { location: location.id, view: "all" })} className="inline-flex min-h-10 items-center text-sm font-semibold text-ink underline underline-offset-2">
            See all on the desk
          </Link>
        }
      >
        <CardList cards={data.openCards} statuses={data.statuses} basePath={basePath} timeZone={data.timeZone} empty="Nothing open for this location." />
      </LookupSection>
      <LookupSection id="location-orders" title="Every order for this location" count={data.ordersCount}>
        <CardList cards={data.orders} statuses={data.statuses} basePath={basePath} timeZone={data.timeZone} empty="No orders for this location yet." />
      </LookupSection>
      <div className="grid gap-8 lg:grid-cols-2">
        <LookupSection id="location-items" title="Top items, last 12 months">
          <ItemTable items={data.topItems} empty="Nothing ordered in the last 12 months." />
        </LookupSection>
        <LookupSection id="location-people" title="Who ordered">
          {data.people.length === 0 ? (
            <p className="text-sm text-ink-2">Nobody yet.</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface">
              {data.people.map((person) => (
                <li key={person.id}>
                  <Link
                    href={`${basePath}/people/${encodeURIComponent(person.id)}`}
                    className="flex min-h-12 items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-2"
                  >
                    <span className="min-w-0 truncate font-medium text-ink">{person.name}</span>
                    <span className="shrink-0 font-mono tabular-nums text-ink-2">{person.cards.toLocaleString("en-US")}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </LookupSection>
      </div>
    </main>
  );
}
