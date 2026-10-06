"use client";

import { InfoIcon } from "@phosphor-icons/react/Info";
import { cardAge } from "@/lib/age";
import { formatDateTime, formatDay, formatMoney } from "@/lib/format";
import type { Role } from "@/lib/roles";
import { statusOptionsFor } from "@/lib/status-options";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import { Chip } from "@/components/kit";
import { StatusSelect } from "./status-select";

// The desk list (comprehensive desk design section 1): a table of one-line
// 44px rows from 880px, compact cards below it. Exactly one of the two is
// rendered (the desk picks with useMediaQuery), so a long list holds one
// status control per card, not two.

export type ListProps = {
  orders: OrderSummary[];
  statuses: StatusView[];
  // Decides which statuses a request offers (src/lib/status-options.ts).
  role: Role;
  flashing: Set<string>;
  rowErrors: Record<string, string>;
  // Orders whose status change is saving.
  savingIds: ReadonlySet<string>;
  // The current time for dates (0 before the first client render).
  now: number;
  onOpen: (orderId: string) => void;
  onChangeStatus: (orderId: string, statusKey: string) => void;
  // When ages turn amber and red (the workspace's work queue settings).
  ageRule: { amberDays: number; redDays: number };
  // Status keys whose cards are finished (no warning color on their age).
  closedKeys: ReadonlySet<string>;
};

function itemsLine(order: OrderSummary): string {
  if (order.itemsPreview.length === 0) {
    return "No line items";
  }
  const more = order.itemTitles.length - order.itemsPreview.length;
  return `${order.itemsPreview.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

// "For Casey Lin · Buford HQ" when the request names them.
function requestLine(order: OrderSummary): string | null {
  const parts = [order.requestFor ? `For ${order.requestFor}` : "", order.branch].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// A request's Draft chip, Deleted when Shopify deleted its draft; an order
// that was a request names its draft.
function KindMark({ order }: { order: OrderSummary }) {
  if (order.kind === "draft") {
    return order.draftDeleted ? (
      <Chip tone="amber" size="sm">
        Deleted<span className="sr-only"> in Shopify</span>
      </Chip>
    ) : (
      <Chip tone="slate" size="sm">
        Draft
      </Chip>
    );
  }
  return order.draftName ? (
    <span className="shrink-0 truncate text-xs text-ink-2">{`from ${order.draftName}`}</span>
  ) : null;
}

function CustomerLine({ order }: { order: OrderSummary }) {
  const line = requestLine(order);
  return (
    <span className="block truncate text-sm" title={order.email || undefined}>
      <span className="font-medium text-ink">{order.customerName || "No customer name"}</span>
      {line ? <span className="text-ink-2">{` · ${line}`}</span> : null}
    </span>
  );
}

function ItemsLine({ order }: { order: OrderSummary }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`truncate text-sm ${order.itemsPreview.length > 0 ? "text-ink-2" : "text-ink-3"}`}>{itemsLine(order)}</span>
      {order.itemsTruncated ? (
        <span className="inline-flex shrink-0 text-warn" title="More items in Shopify">
          <InfoIcon size={14} aria-hidden />
          <span className="sr-only">More items in Shopify</span>
        </span>
      ) : null}
    </span>
  );
}

function RowStatus({
  order,
  statuses,
  role,
  busy,
  onChangeStatus,
}: {
  order: OrderSummary;
  statuses: StatusView[];
  role: Role;
  busy: boolean;
  onChangeStatus: (orderId: string, statusKey: string) => void;
}) {
  const options = statusOptionsFor({ kind: order.kind, role, currentKey: order.statusKey, statuses });
  return (
    <StatusSelect
      statuses={options.options}
      value={order.statusKey}
      onChange={(key) => onChangeStatus(order.id, key)}
      label={`Status for ${order.kind === "draft" ? "request" : "order"} ${order.name}`}
      busy={busy}
      disabled={options.disabled}
      hint={options.hint}
    />
  );
}

function RowError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="mt-1 text-xs font-medium text-bad">
      {message}
    </p>
  ) : null;
}

function Total({ order }: { order: OrderSummary }) {
  return <span className="font-mono text-sm tabular-nums text-ink">{formatMoney(order.total, order.currency)}</span>;
}

function DayText({ order, now }: { order: OrderSummary; now: number }) {
  return (
    <span className="block truncate text-sm tabular-nums text-ink" title={formatDateTime(order.createdAt)}>
      {now > 0 ? formatDay(order.createdAt, now) : ""}
    </span>
  );
}

// "2d" (the table) or "New, 2d" (a card's header), amber or red when the
// card has waited too long. Spoken as "In New for 2 days".
function AgeBadge({
  order,
  statuses,
  ageRule,
  closedKeys,
  now,
  withLabel,
}: {
  order: OrderSummary;
  statuses: StatusView[];
  ageRule: ListProps["ageRule"];
  closedKeys: ReadonlySet<string>;
  now: number;
  withLabel: boolean;
}) {
  if (now === 0) {
    return null;
  }
  const age = cardAge(order, now, { ...ageRule, closed: closedKeys.has(order.statusKey) });
  const label = statuses.find((status) => status.key === order.statusKey)?.label ?? "Unknown status";
  const text = withLabel ? `${label}, ${age.short}` : age.short;
  const spoken = `In ${label} for ${age.long}${age.tone === "red" ? ", overdue" : age.tone === "amber" ? ", waiting long" : ""}`;
  const title = `In ${label} since ${formatDateTime(age.since)}`;
  if (age.tone === "none") {
    return (
      <span title={title} className="shrink-0 text-xs font-medium tabular-nums text-ink-2">
        <span aria-hidden>{text}</span>
        <span className="sr-only">{spoken}</span>
      </span>
    );
  }
  return (
    <Chip tone={age.tone} size="sm" title={title}>
      <span aria-hidden>{text}</span>
      <span className="sr-only">{spoken}</span>
    </Chip>
  );
}

// From 880px: one 44px line per card, so 15 to 18 fit above the fold at
// 1440 by 900.
export function OrderTable({
  orders,
  statuses,
  role,
  flashing,
  rowErrors,
  savingIds,
  now,
  onOpen,
  onChangeStatus,
  ageRule,
  closedKeys,
}: ListProps) {
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-panel">
      <table className="w-full table-fixed border-collapse text-left">
        <colgroup>
          <col className="w-[10rem]" />
          <col className="w-[6.5rem]" />
          <col className="w-[24%]" />
          <col />
          <col className="w-[5.5rem]" />
          <col className="w-[7rem]" />
          <col className="w-[11rem]" />
        </colgroup>
        <thead>
          <tr className="h-9 text-xs font-semibold text-ink-2">
            <th scope="col" className="px-4 font-semibold">Order</th>
            <th scope="col" className="px-3 font-semibold">Date</th>
            <th scope="col" className="px-3 font-semibold">Customer</th>
            <th scope="col" className="px-3 font-semibold">Items</th>
            <th scope="col" className="px-3 font-semibold">Age</th>
            <th scope="col" className="px-3 text-right font-semibold">Total</th>
            <th scope="col" className="px-4 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const flash = flashing.has(order.id) ? "od-flash" : "";
            return (
              <tr
                key={order.id}
                onClick={() => onOpen(order.id)}
                className="h-11 cursor-pointer border-t border-line transition-colors hover:bg-surface-2/70"
              >
                <td className={`px-4 ${flash}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(order.id);
                      }}
                      className="-mx-1 shrink-0 rounded-control px-1 font-mono text-sm font-semibold tabular-nums text-ink underline-offset-4 hover:underline"
                    >
                      <span className="sr-only">{order.kind === "draft" ? "Open request " : "Open order "}</span>
                      {order.name}
                    </button>
                    <KindMark order={order} />
                  </span>
                </td>
                <td className={`px-3 ${flash}`}>
                  <DayText order={order} now={now} />
                </td>
                <td className={`px-3 ${flash}`}>
                  <CustomerLine order={order} />
                </td>
                <td className={`px-3 ${flash}`}>
                  <ItemsLine order={order} />
                </td>
                <td className={`px-3 ${flash}`}>
                  <AgeBadge order={order} statuses={statuses} ageRule={ageRule} closedKeys={closedKeys} now={now} withLabel={false} />
                </td>
                <td className={`px-3 text-right ${flash}`}>
                  <Total order={order} />
                </td>
                <td className={`px-4 ${flash}`} onClick={(event) => event.stopPropagation()}>
                  <RowStatus order={order} statuses={statuses} role={role} busy={savingIds.has(order.id)} onChangeStatus={onChangeStatus} />
                  <RowError message={rowErrors[order.id]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Below 880px: compact cards, the order and its kind with its age in its
// status in the header, who and what on one line each, then the status control. The
// order number is a stretched button over the card; the status control
// sits above it so both stay usable. content-visibility lets the browser
// skip laying out cards that are off screen.
export function OrderCards({
  orders,
  statuses,
  role,
  flashing,
  rowErrors,
  savingIds,
  now,
  onOpen,
  onChangeStatus,
  ageRule,
  closedKeys,
}: ListProps) {
  return (
    <ul className="flex flex-col gap-2">
      {orders.map((order) => (
        <li
          key={order.id}
          className={`relative rounded-panel border border-line bg-surface px-3.5 py-3 shadow-panel [contain-intrinsic-size:auto_8.5rem] [content-visibility:auto] ${
            flashing.has(order.id) ? "od-flash" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpen(order.id)}
              className="shrink-0 font-mono text-[15px] font-semibold tabular-nums text-ink after:absolute after:inset-0 after:rounded-panel after:content-['']"
            >
              <span className="sr-only">{order.kind === "draft" ? "Open request " : "Open order "}</span>
              {order.name}
            </button>
            <KindMark order={order} />
            <span className="ml-auto shrink-0">
              <AgeBadge order={order} statuses={statuses} ageRule={ageRule} closedKeys={closedKeys} now={now} withLabel />
            </span>
          </div>
          <div className="mt-1">
            <CustomerLine order={order} />
          </div>
          <div className="mt-0.5">
            <ItemsLine order={order} />
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <div className="relative z-10 flex min-w-0 flex-col items-start">
              <RowStatus order={order} statuses={statuses} role={role} busy={savingIds.has(order.id)} onChangeStatus={onChangeStatus} />
              <RowError message={rowErrors[order.id]} />
            </div>
            <Total order={order} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// One list, never both.
export function OrderList({ layout, ...props }: ListProps & { layout: "table" | "cards" }) {
  return layout === "table" ? <OrderTable {...props} /> : <OrderCards {...props} />;
}
