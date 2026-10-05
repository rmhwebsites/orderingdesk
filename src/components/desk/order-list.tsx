"use client";

import { InfoIcon } from "@phosphor-icons/react/Info";
import { formatDate, formatMoney, formatTime } from "@/lib/format";
import type { Role } from "@/lib/roles";
import { statusOptionsFor } from "@/lib/status-options";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import { ToneChip } from "./drawer-kit";
import { StatusSelect } from "./status-select";

type ListProps = {
  orders: OrderSummary[];
  statuses: StatusView[];
  // Decides which statuses a request offers (src/lib/status-options.ts).
  role: Role;
  flashing: Set<string>;
  rowErrors: Record<string, string>;
  // Orders whose status change is saving.
  savingIds: ReadonlySet<string>;
  onOpen: (orderId: string) => void;
  onChangeStatus: (orderId: string, statusKey: string) => void;
};

function ItemsSummary({ order }: { order: OrderSummary }) {
  const more = order.itemTitles.length - order.itemsPreview.length;
  return (
    <div className="min-w-0">
      {order.itemsPreview.length > 0 ? (
        <p className="line-clamp-2 text-sm text-ink-2">
          {order.itemsPreview.join(", ")}
          {more > 0 ? `, and ${more} more` : ""}
        </p>
      ) : (
        <p className="text-sm text-ink-3">No line items</p>
      )}
      {order.itemsTruncated ? (
        <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-warn">
          <InfoIcon size={12} aria-hidden />
          More items in Shopify
        </p>
      ) : null}
    </div>
  );
}

// A request's Draft chip and, when Shopify deleted its draft, a Deleted
// chip; an order that was a request names its draft.
function KindMarks({ order }: { order: OrderSummary }) {
  if (order.kind === "draft") {
    return (
      <span className="mt-1 flex flex-wrap gap-1">
        <ToneChip tone="slate" size="sm">
          Draft
        </ToneChip>
        {order.draftDeleted ? (
          <ToneChip tone="amber" size="sm">
            Deleted in Shopify
          </ToneChip>
        ) : null}
      </span>
    );
  }
  return order.draftName ? (
    <span className="mt-0.5 block text-xs text-ink-2">
      from draft <span className="font-mono tabular-nums">{order.draftName}</span>
    </span>
  ) : null;
}

// "For Casey Lin · Buford HQ" when the request names them.
function requestLine(order: OrderSummary): string | null {
  const parts = [order.requestFor ? `For ${order.requestFor}` : "", order.branch].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
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

// Table at 880px and up.
export function OrderTable({ orders, statuses, role, flashing, rowErrors, savingIds, onOpen, onChangeStatus }: ListProps) {
  return (
    <div className="hidden overflow-hidden rounded-panel border border-line bg-surface shadow-panel desk:block">
      <table className="w-full table-fixed border-collapse text-left">
        <colgroup>
          <col className="w-[8.5rem]" />
          <col className="w-[7.5rem]" />
          <col className="w-[22%]" />
          <col />
          <col className="w-[8rem]" />
          <col className="w-[11.5rem]" />
        </colgroup>
        <thead>
          <tr className="text-xs font-semibold text-ink-2">
            <th scope="col" className="px-4 py-3 font-semibold">Order</th>
            <th scope="col" className="px-3 py-3 font-semibold">Date</th>
            <th scope="col" className="px-3 py-3 font-semibold">Customer</th>
            <th scope="col" className="px-3 py-3 font-semibold">Items</th>
            <th scope="col" className="px-3 py-3 text-right font-semibold">Total</th>
            <th scope="col" className="px-4 py-3 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const flash = flashing.has(order.id) ? "od-flash" : "";
            return (
              <tr
                key={order.id}
                onClick={() => onOpen(order.id)}
                className="cursor-pointer border-t border-line align-top transition-colors hover:bg-surface-2/70"
              >
                <td className={`px-4 py-3.5 ${flash}`}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(order.id);
                    }}
                    className="-mx-1 rounded-control px-1 font-mono text-sm font-semibold tabular-nums text-ink underline-offset-4 hover:underline"
                  >
                    <span className="sr-only">{order.kind === "draft" ? "Open request " : "Open order "}</span>
                    {order.name}
                  </button>
                  <KindMarks order={order} />
                </td>
                <td className={`px-3 py-3.5 ${flash}`}>
                  <p className="text-sm tabular-nums text-ink">{formatDate(order.createdAt)}</p>
                  <p className="text-xs tabular-nums text-ink-2">{formatTime(order.createdAt)}</p>
                </td>
                <td className={`px-3 py-3.5 ${flash}`}>
                  <p className="truncate text-sm font-medium text-ink">{order.customerName || "No customer name"}</p>
                  <p className="truncate text-xs text-ink-2">{order.email || "No email"}</p>
                  {requestLine(order) ? <p className="truncate text-xs text-ink-2">{requestLine(order)}</p> : null}
                </td>
                <td className={`px-3 py-3.5 ${flash}`}>
                  <ItemsSummary order={order} />
                </td>
                <td className={`px-3 py-3.5 text-right ${flash}`}>
                  <Total order={order} />
                </td>
                <td className={`px-4 py-3 ${flash}`} onClick={(event) => event.stopPropagation()}>
                  <RowStatus
                    order={order}
                    statuses={statuses}
                    role={role}
                    busy={savingIds.has(order.id)}
                    onChangeStatus={onChangeStatus}
                  />
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

// Cards below 880px. The order number is a stretched button over the card;
// the status control sits above it so both stay usable.
export function OrderCards({ orders, statuses, role, flashing, rowErrors, savingIds, onOpen, onChangeStatus }: ListProps) {
  return (
    <ul className="flex flex-col gap-2 desk:hidden">
      {orders.map((order) => (
        <li
          key={order.id}
          className={`relative rounded-panel border border-line bg-surface p-4 shadow-panel ${
            flashing.has(order.id) ? "od-flash" : ""
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen(order.id)}
                className="font-mono text-[15px] font-semibold tabular-nums text-ink after:absolute after:inset-0 after:rounded-panel after:content-['']"
              >
                <span className="sr-only">{order.kind === "draft" ? "Open request " : "Open order "}</span>
                {order.name}
              </button>
              <KindMarks order={order} />
            </div>
            <Total order={order} />
          </div>
          <p className="mt-2 truncate text-sm font-medium text-ink">{order.customerName || "No customer name"}</p>
          <p className="truncate text-xs text-ink-2">{order.email || "No email"}</p>
          {requestLine(order) ? <p className="truncate text-xs text-ink-2">{requestLine(order)}</p> : null}
          <div className="mt-2">
            <ItemsSummary order={order} />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs tabular-nums text-ink-2">
              {formatDate(order.createdAt)}, {formatTime(order.createdAt)}
            </p>
            <div className="relative z-10 flex min-w-0 flex-col items-end">
              <RowStatus
                order={order}
                statuses={statuses}
                role={role}
                busy={savingIds.has(order.id)}
                onChangeStatus={onChangeStatus}
              />
              <RowError message={rowErrors[order.id]} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
