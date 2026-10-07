import Link from "next/link";
import type { LocationSummaryRow } from "@/server/lookup/locations";

export function LocationsListView({ rows, basePath }: { rows: LocationSummaryRow[]; basePath: string }) {
  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Locations</h1>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-2">
          Company locations appear here once the store's B2B locations sync (Settings, Store connection, Refresh connection).
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`${basePath}/locations/${encodeURIComponent(row.id)}`}
                className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{row.name}</span>
                  {!row.active ? <span className="block text-xs text-ink-2">Not active in Shopify</span> : null}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-ink-2">
                  {row.openCount.toLocaleString("en-US")} open, {row.cardCount.toLocaleString("en-US")} in all
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
