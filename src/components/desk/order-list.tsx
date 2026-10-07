"use client";

import { InfoIcon } from "@phosphor-icons/react/Info";
import { cardAge } from "@/lib/age";
import { poNotCreated } from "@/lib/desk-state";
import { formatDateTime, formatDay, formatMoney } from "@/lib/format";
import { isPriced } from "@/lib/queue-settings";
import type { Role } from "@/lib/roles";
import { statusOptionsFor } from "@/lib/status-options";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import { Chip, SelectBox } from "@/components/kit";
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
  // Bulk selection (null: no selection boxes).
  selection: {
    selected: ReadonlySet<string>;
    onToggle: (orderId: string, range: boolean) => void;
    onToggleAll: () => void;
  } | null;
  // The phone cards' totals; when false, a card with a price shows it as an
  // amber chip. The desktop rows have a Branch column in place of the total
  // (from 1280 px, see OrderTable) and always mark a card with a price.
  showPrices: boolean;
};

function itemsLine(order: OrderSummary): string {
  if (order.itemsPreview.length === 0) {
    return "No line items";
  }
  const more = order.itemTitles.length - order.itemsPreview.length;
  return `${order.itemsPreview.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

// "For Casey Lin · Buford HQ" when the request names them. The desktop row
// has its own Branch column, so it leaves the branch out (CustomerLine adds
// it back where that column is hidden).
export function requestLine(
  order: Pick<OrderSummary, "requestFor" | "branch">,
  opts: { withBranch: boolean },
): string | null {
  const parts = [order.requestFor ? `For ${order.requestFor}` : "", opts.withBranch ? order.branch : ""].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

// The Branch column (comprehensive design section 2): the synced company
// location, else the request's own field (OrderSummary.branch).
export function branchText(order: Pick<OrderSummary, "branch">): string {
  return order.branch.trim();
}

export function BranchCell({ order }: { order: Pick<OrderSummary, "branch"> }) {
  const text = branchText(order);
  return text ? (
    <span className="block truncate text-sm text-ink" title={text}>
      {text}
    </span>
  ) : (
    <span className="text-sm text-ink-2">No branch</span>
  );
}

// A request's Draft chip, Deleted when Shopify deleted its draft; an order
// that was a request names its draft.
function KindMark({ order, cancelledKey }: { order: OrderSummary; cancelledKey: string | undefined }) {
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
  // An order Shopify cancelled while its card sits outside the cancelled
  // status (none exists, or a manager moved it) says so.
  const cancelled = order.cancelled && order.statusKey !== cancelledKey;
  if (!order.draftName && !cancelled) {
    return null;
  }
  return (
    <>
      {order.draftName ? <span className="shrink-0 truncate text-xs text-ink-2">{`from ${order.draftName}`}</span> : null}
      {cancelled ? (
        <Chip tone="slate" size="sm">
          Cancelled in Shopify
        </Chip>
      ) : null}
    </>
  );
}

// The cards always name the branch here; a table row names it only below
// xl, where its Branch column is hidden.
function CustomerLine({ order, branch }: { order: OrderSummary; branch: "always" | "below-xl" }) {
  const line = requestLine(order, { withBranch: branch === "always" });
  const branchName = branch === "below-xl" ? branchText(order) : "";
  return (
    <span className="block truncate text-sm" title={order.email || undefined}>
      <span className="font-medium text-ink">{order.customerName || "No customer name"}</span>
      {line ? <span className="text-ink-2">{` · ${line}`}</span> : null}
      {branchName ? <span className="text-ink-2 xl:hidden">{` · ${branchName}`}</span> : null}
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

// Owner decision after the Wave 1a plan: Approve and next skips the
// purchase order review, so an order whose status usually needs one says so
// until it has one.
function PoMissing({ className = "" }: { className?: string }) {
  return (
    <Chip tone="amber" size="sm" title="This status usually needs a purchase order. Create it from the order." className={className}>
      PO not created
    </Chip>
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

// A card with a price (on the desktop always, on a phone card while prices
// are hidden): worth noticing on a $0 store.
function PricedMark({ order }: { order: OrderSummary }) {
  return isPriced(order.total) ? (
    <Chip tone="amber" size="sm" title="This card has a price">
      <span className="sr-only">Price </span>
      {formatMoney(order.total, order.currency)}
    </Chip>
  ) : null;
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
// 1440 by 900. A fixed table gives the rem columns their width first, then
// Customer its share, and Items what is left, so the Branch column shows
// only from xl (1280px): below that it would leave Items no room (half a
// 1920 screen, an iPad on its side), and the branch rides in the customer
// line instead, as on the cards. The widths sit on the header cells, not a
// colgroup, so hiding a column's cells drops its width with it.
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
  selection,
}: ListProps) {
  const cancelledKey = statuses.find((status) => status.shopifyLink === "cancelled")?.key;
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-panel">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="h-9 text-xs font-semibold text-ink-2">
            <th scope="col" className="w-14 pl-2.5">
              {selection ? (
                <SelectBox
                  label="Select every card shown"
                  checked={orders.length > 0 && orders.every((order) => selection.selected.has(order.id))}
                  indeterminate={orders.some((order) => selection.selected.has(order.id))}
                  onToggle={() => selection.onToggleAll()}
                />
              ) : (
                <span className="sr-only">Select</span>
              )}
            </th>
            <th scope="col" className="w-[10rem] px-2 font-semibold">Order</th>
            <th scope="col" className="w-[6.5rem] px-3 font-semibold">Date</th>
            <th scope="col" className="w-[24%] px-3 font-semibold">Customer</th>
            <th scope="col" className="px-3 font-semibold">Items</th>
            <th scope="col" className="w-[5.5rem] px-3 font-semibold">Age</th>
            <th scope="col" className="hidden w-[9rem] px-3 font-semibold xl:table-cell">Branch</th>
            <th scope="col" className="w-[11rem] px-4 font-semibold">Status</th>
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
                <td className={`pl-2.5 ${flash}`}>
                  {selection ? (
                    <SelectBox
                      label={`Select ${order.name}`}
                      checked={selection.selected.has(order.id)}
                      onToggle={(range) => selection.onToggle(order.id, range)}
                    />
                  ) : null}
                </td>
                <td className={`px-2 ${flash}`}>
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
                    <KindMark order={order} cancelledKey={cancelledKey} />
                    <PricedMark order={order} />
                  </span>
                </td>
                <td className={`px-3 ${flash}`}>
                  <DayText order={order} now={now} />
                </td>
                <td className={`px-3 ${flash}`}>
                  <CustomerLine order={order} branch="below-xl" />
                </td>
                <td className={`px-3 ${flash}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ItemsLine order={order} />
                    {poNotCreated(order, statuses) ? <PoMissing className="ml-auto" /> : null}
                  </span>
                </td>
                <td className={`px-3 ${flash}`}>
                  <AgeBadge order={order} statuses={statuses} ageRule={ageRule} closedKeys={closedKeys} now={now} withLabel={false} />
                </td>
                <td className={`hidden px-3 xl:table-cell ${flash}`}>
                  <BranchCell order={order} />
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
  selection,
  showPrices,
}: ListProps) {
  const cancelledKey = statuses.find((status) => status.shopifyLink === "cancelled")?.key;
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
            {selection ? (
              <span className="relative z-10 -my-2 -ml-2.5">
                <SelectBox
                  label={`Select ${order.name}`}
                  checked={selection.selected.has(order.id)}
                  onToggle={(range) => selection.onToggle(order.id, range)}
                />
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onOpen(order.id)}
              className="shrink-0 font-mono text-[15px] font-semibold tabular-nums text-ink after:absolute after:inset-0 after:rounded-panel after:content-['']"
            >
              <span className="sr-only">{order.kind === "draft" ? "Open request " : "Open order "}</span>
              {order.name}
            </button>
            <KindMark order={order} cancelledKey={cancelledKey} />
            <span className="ml-auto shrink-0">
              <AgeBadge order={order} statuses={statuses} ageRule={ageRule} closedKeys={closedKeys} now={now} withLabel />
            </span>
          </div>
          <div className="mt-1">
            <CustomerLine order={order} branch="always" />
          </div>
          <div className="mt-0.5">
            <ItemsLine order={order} />
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <div className="relative z-10 flex min-w-0 flex-col items-start">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <RowStatus order={order} statuses={statuses} role={role} busy={savingIds.has(order.id)} onChangeStatus={onChangeStatus} />
                {poNotCreated(order, statuses) ? <PoMissing /> : null}
              </div>
              <RowError message={rowErrors[order.id]} />
            </div>
            {showPrices ? <Total order={order} /> : <PricedMark order={order} />}
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
