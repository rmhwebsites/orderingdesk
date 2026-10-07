import Link from "next/link";
import { formatDate } from "@/lib/format";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import type { ItemTotal } from "@/server/lookup/items";
// Wave 1a's shared Chip.
import { Chip } from "@/components/kit";

// A link to the desk with these params (the desk lives at the base path,
// "/" on a client host).
export function deskHref(basePath: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${basePath || "/"}${query ? `?${query}` : ""}`;
}

export function LookupSection({ id, title, count, action, children }: {
  id: string;
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="font-display text-lg font-semibold text-ink">
          {title}
          {count !== undefined ? <span className="ml-2 font-mono text-sm tabular-nums text-ink-2">{count.toLocaleString("en-US")}</span> : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// Cards, newest first. A row opens the card's drawer on the desk.
export function CardList({
  cards,
  statuses,
  basePath,
  timeZone,
  empty,
}: {
  cards: OrderSummary[];
  statuses: StatusView[];
  basePath: string;
  timeZone: string;
  empty: string;
}) {
  if (cards.length === 0) {
    return <p className="text-sm text-ink-2">{empty}</p>;
  }
  const byKey = new Map(statuses.map((status) => [status.key, status]));
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface">
      {cards.map((card) => {
        const status = byKey.get(card.statusKey);
        return (
          <li key={card.id}>
            <Link
              href={deskHref(basePath, { order: card.id })}
              className="flex min-h-12 flex-col gap-1 px-4 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4"
            >
              <span className="flex items-center gap-2 sm:w-36">
                <span className="font-mono text-sm font-semibold tabular-nums text-ink">{card.name}</span>
                {card.kind === "draft" ? (
                  <Chip tone="slate" size="sm">
                    {card.draftDeleted ? "Deleted in Shopify" : "Request"}
                  </Chip>
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{card.itemsPreview.join(", ") || "No line items"}</span>
              <span className="text-xs tabular-nums text-ink-2 sm:w-28 sm:text-right">{formatDate(card.createdAt, timeZone)}</span>
              <span className="sm:w-32 sm:text-right">
                <Chip tone={status?.color ?? "slate"} size="sm">
                  {status?.label ?? "Unknown status"}
                </Chip>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function ItemTable({ items, empty }: { items: ItemTotal[]; empty: string }) {
  if (items.length === 0) {
    return <p className="text-sm text-ink-2">{empty}</p>;
  }
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead>
          <tr className="text-xs font-semibold text-ink-2">
            <th scope="col" className="px-4 py-2.5">Item</th>
            <th scope="col" className="w-24 px-3 py-2.5 sm:w-40">Size</th>
            <th scope="col" className="w-16 px-4 py-2.5 text-right">Qty</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.title}\n${item.variant}`} className="border-t border-line">
              <td className="truncate px-4 py-2.5 text-ink">{item.title}</td>
              <td className="truncate px-3 py-2.5 text-ink-2">{item.variant || "One size"}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-ink">{item.quantity.toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatTiles({ stats }: { stats: { label: string; value: number }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-panel border border-line bg-surface p-4">
          <dt className="text-sm text-ink-2">{stat.label}</dt>
          <dd className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink">{stat.value.toLocaleString("en-US")}</dd>
        </div>
      ))}
    </dl>
  );
}
