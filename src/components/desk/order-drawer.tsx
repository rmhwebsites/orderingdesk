"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { ChatTextIcon } from "@phosphor-icons/react/ChatText";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import { ShoppingBagIcon } from "@phosphor-icons/react/ShoppingBag";
import { StorefrontIcon } from "@phosphor-icons/react/Storefront";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { XIcon } from "@phosphor-icons/react/X";
import { formatDateTime, formatMoney, relativeTime, sentenceCase, shopifyAdminOrderUrl } from "@/lib/format";
import { NOTE_MAX } from "@/lib/limits";
import { financialTone, fulfillmentTone, itemsSubtotal, readSnapshot, shippingLines } from "@/lib/order-snapshot";
import { useNow } from "@/lib/use-now";
import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
import { ui } from "@/components/ui";
import { StatusSelect } from "./status-select";
import { APP_NAME } from "@/lib/brand";
import type { PoView } from "@/server/po/service";
import { PurchaseOrders } from "./po-history";

export type DrawerOrder = {
  id: string;
  shopifyOrderId: string;
  name: string;
  shopify: unknown;
  statusKey: string;
  statusSetBy: string | null;
  statusSetAt: number | null;
  createdAt: number;
};

export type DrawerDetail =
  | { status: "loading" }
  | { status: "error"; message: string; missing: boolean }
  | { status: "ready"; order: DrawerOrder; itemsTruncated: boolean };

export type MemberView = { userId: string; role: string; email: string | null; name: string | null };

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The drawer frame: a portal into #workspace-overlays (inside the brand
// scope), a scrim, a right-side panel that is full screen on phones. While
// open the rest of the workspace is inert, focus is trapped in the panel,
// Esc and the scrim close it, and focus returns where it was on close.
export function DrawerShell({
  open,
  onClose,
  labelledBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [present, setPresent] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(document.getElementById("workspace-overlays") ?? document.body);
  }, []);

  useEffect(() => {
    if (open) {
      if (!returnFocus.current && document.activeElement instanceof HTMLElement) {
        returnFocus.current = document.activeElement;
      }
      setPresent(true);
      // Two frames: the panel first paints off screen, then slides in.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setShown(false);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setPresent(false), reduce ? 0 : 300);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (shown) {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [shown]);

  useEffect(() => {
    if (!present) {
      return;
    }
    const main = document.getElementById("workspace-main");
    main?.setAttribute("inert", "");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      main?.removeAttribute("inert");
      document.body.style.overflow = overflow;
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back && back.isConnected && back !== document.body) {
        back.focus({ preventScroll: true });
      } else {
        document.getElementById("desk-heading")?.focus({ preventScroll: true });
      }
    };
  }, [present]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) {
      return;
    }
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.getClientRects().length > 0,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!present || !target) {
    return null;
  }

  return createPortal(
    // z-40: above the top bar (z-30), below toasts (z-50).
    <div data-drawer-state={shown ? "open" : "closed"} className="fixed inset-0 z-40">
      <div aria-hidden className="od-drawer-scrim absolute inset-0 bg-scrim" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="od-drawer-panel absolute inset-y-0 right-0 flex w-full flex-col bg-surface shadow-lift outline-none sm:w-[36rem] sm:max-w-full sm:border-l sm:border-line"
      >
        {children}
      </div>
    </div>,
    target,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-5 first:border-t-0 first:pt-0">
      <h3 className="mb-3 font-display text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function ToneChip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      data-tone={tone}
      className="inline-flex h-7 items-center rounded-control bg-tone-fill px-2.5 text-xs font-semibold text-tone-text"
    >
      {children}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), 2400);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={copy} className={`${ui.buttonQuiet} h-8 border border-line px-3 text-xs`}>
        {state === "copied" ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
        {state === "copied" ? "Copied" : label}
      </button>
      <span role="status" className="text-xs text-ink-2">
        {state === "failed" ? "Copy is blocked here. Select the address instead." : ""}
      </span>
    </span>
  );
}

function actorName(event: EventView, members: Map<string, MemberView>, selfUserId: string): string {
  if (!event.actorId) {
    return event.source === "shopify" || event.type === "order_new" ? "Shopify" : APP_NAME;
  }
  if (event.actorId === selfUserId) {
    return "You";
  }
  const member = members.get(event.actorId);
  if (!member) {
    return "Former member";
  }
  return member.name?.trim() || member.email || "Team member";
}

const EVENT_ICONS: Record<EventView["type"], typeof ChatTextIcon> = {
  note: ChatTextIcon,
  status: TagIcon,
  order_new: ShoppingBagIcon,
  po_draft: FileTextIcon,
  po_sent: FileTextIcon,
  po_failed: WarningIcon,
  sync_error: WarningIcon,
  shopify_write: StorefrontIcon,
  draft_completed: CheckCircleIcon,
  draft_deleted: TrashIcon,
};

// A Shopify write that failed reads as a warning, so it stands out.
function eventIcon(event: EventView): typeof ChatTextIcon {
  const failed =
    event.type === "shopify_write" &&
    typeof event.meta === "object" &&
    event.meta !== null &&
    (event.meta as { ok?: unknown }).ok === false;
  return failed ? WarningIcon : (EVENT_ICONS[event.type] ?? InfoIcon);
}

function Timeline({
  events,
  status,
  members,
  selfUserId,
  onRetry,
}: {
  events: EventView[];
  status: "loading" | "error" | "ready";
  members: Map<string, MemberView>;
  selfUserId: string;
  onRetry: () => void;
}) {
  const now = useNow(30000);
  if (events.length === 0 && status === "loading") {
    return (
      <ul aria-label="Loading activity" className="flex flex-col gap-4">
        {[0, 1, 2].map((row) => (
          <li key={row} className="flex gap-3">
            <span className="od-skeleton size-8 shrink-0" />
            <span className="flex flex-1 flex-col gap-1.5 pt-1">
              <span className="od-skeleton h-3.5 w-40" />
              <span className="od-skeleton h-3 w-56" />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (events.length === 0 && status === "error") {
    return (
      <p role="alert" className="text-sm text-bad">
        Activity did not load.{" "}
        <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
          Try again
        </button>
      </p>
    );
  }
  if (events.length === 0) {
    return <p className="text-sm text-ink-2">No activity yet. Notes and status changes appear here.</p>;
  }
  return (
    <ol className="flex flex-col gap-4">
      {events.map((event) => {
        const Icon = eventIcon(event);
        return (
          <li key={event.id} className="flex gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-2">
              <Icon size={16} aria-hidden />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-semibold text-ink">{actorName(event, members, selfUserId)}</span>
                <time
                  dateTime={new Date(event.createdAt).toISOString()}
                  title={formatDateTime(event.createdAt)}
                  className="text-xs tabular-nums text-ink-2"
                >
                  {now > 0 ? relativeTime(event.createdAt, now) : formatDateTime(event.createdAt)}
                </time>
              </p>
              {event.type === "note" ? (
                <p className="mt-1.5 whitespace-pre-wrap break-words rounded-panel bg-surface-2 px-3 py-2 text-sm text-ink">
                  {event.text}
                </p>
              ) : (
                <p className="mt-0.5 break-words text-sm text-ink-2">{event.text}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const COUNTER_FROM = NOTE_MAX - 400;

function NoteComposer({ onSubmit }: { onSubmit: (text: string) => Promise<string | null> }) {
  const id = useId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = NOTE_MAX - text.length;
  const showCount = text.length >= COUNTER_FROM;

  async function send() {
    if (sending || text.trim().length === 0) {
      return;
    }
    setSending(true);
    setError(null);
    const failure = await onSubmit(text);
    setSending(false);
    if (failure) {
      setError(failure);
    } else {
      setText("");
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={`${id}-note`} className={ui.label}>
        Add a note
      </label>
      <textarea
        id={`${id}-note`}
        rows={3}
        maxLength={NOTE_MAX}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder="Visible to everyone in this workspace"
        aria-describedby={`${id}-help${showCount ? ` ${id}-count` : ""}${error ? ` ${id}-error` : ""}`}
        aria-invalid={error ? true : undefined}
        className="w-full resize-y rounded-panel border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-3"
      />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p id={`${id}-help`} className="text-xs text-ink-2">
          Enter sends. Shift+Enter adds a new line.
        </p>
        <div className="ml-auto flex items-center gap-3">
          {showCount ? (
            <p id={`${id}-count`} className={`text-xs font-medium tabular-nums ${remaining <= 100 ? "text-bad" : "text-warn"}`}>
              {remaining.toLocaleString("en-US")} characters left
            </p>
          ) : null}
          <button type="submit" disabled={sending || text.trim().length === 0} className={`${ui.buttonPrimary} h-9`}>
            <PaperPlaneRightIcon size={16} aria-hidden />
            {sending ? "Sending" : "Send"}
          </button>
        </div>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className={ui.errorText}>
          {error}
        </p>
      ) : null}
    </form>
  );
}

function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <span className="od-skeleton h-6 w-28" />
      <span className="od-skeleton h-3.5 w-40" />
    </div>
  );
}

export function OrderDrawerContent({
  labelId,
  orderId,
  summary,
  detail,
  timeline,
  timelineStatus,
  statuses,
  rowError,
  statusBusy = false,
  members,
  selfUserId,
  shopDomain,
  onChangeStatus,
  onAddNote,
  onClose,
  onRetry,
  canManagePos,
  poRefreshKey,
  onCreatePo,
  onEditPo,
}: {
  labelId: string;
  orderId: string;
  summary: OrderSummary | undefined;
  detail: DrawerDetail;
  timeline: EventView[];
  timelineStatus: "loading" | "error" | "ready";
  statuses: StatusView[];
  rowError?: string;
  // A status change for this order is saving.
  statusBusy?: boolean;
  members: Map<string, MemberView>;
  selfUserId: string;
  shopDomain: string | null;
  onChangeStatus: (statusKey: string) => void;
  onAddNote: (text: string) => Promise<string | null>;
  onClose: () => void;
  onRetry: () => void;
  // Managers and platform admins create and send purchase orders; staff
  // see the history only (the server enforces it either way).
  canManagePos: boolean;
  poRefreshKey: number;
  onCreatePo: () => void;
  onEditPo: (po: PoView) => void;
}) {
  const order = detail.status === "ready" ? detail.order : null;
  const snapshot = order ? readSnapshot(order.shopify) : null;
  const name = order?.name ?? summary?.name ?? "";
  const createdAt = order?.createdAt ?? summary?.createdAt ?? null;
  const statusKey = summary?.statusKey ?? order?.statusKey ?? null;
  const statusSetBy = summary?.statusSetBy ?? order?.statusSetBy ?? null;
  const statusSetAt = summary?.statusSetAt ?? order?.statusSetAt ?? null;
  const financial = snapshot?.financialStatus ?? summary?.financialStatus ?? "";
  const fulfillment = snapshot?.fulfillmentStatus ?? summary?.fulfillmentStatus ?? "";
  const shopifyUrl = order ? shopifyAdminOrderUrl(shopDomain, order.shopifyOrderId) : null;
  const itemsTruncated = detail.status === "ready" ? detail.itemsTruncated : (summary?.itemsTruncated ?? false);
  // A status set with no person behind it came from Shopify (a fulfillment,
  // a delivery or the Ordering Desk tag edited there).
  const setBy = statusSetBy
    ? statusSetBy === selfUserId
      ? "you"
      : members.get(statusSetBy)?.name?.trim() || members.get(statusSetBy)?.email || "a former member"
    : statusSetAt !== null
      ? "Shopify"
      : null;
  const now = useNow(30000);

  return (
    <>
      <header className="border-b border-line px-4 pb-4 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {name ? (
              <>
                <h2 id={labelId} className="font-mono text-xl font-semibold tabular-nums text-ink">
                  <span className="sr-only">Order </span>
                  {name}
                </h2>
                {createdAt !== null ? (
                  <p className="mt-0.5 text-sm tabular-nums text-ink-2">Placed {formatDateTime(createdAt)}</p>
                ) : null}
              </>
            ) : (
              <>
                <h2 id={labelId} className="sr-only">
                  Order details
                </h2>
                <HeaderSkeleton />
              </>
            )}
          </div>
          <button type="button" onClick={onClose} className={`${ui.iconButton} -mr-2 -mt-1`}>
            <XIcon size={20} aria-hidden />
            <span className="sr-only">Close order</span>
          </button>
        </div>

        {financial || fulfillment ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {financial ? <ToneChip tone={financialTone(financial)}>{sentenceCase(financial)}</ToneChip> : null}
            {fulfillment ? <ToneChip tone={fulfillmentTone(fulfillment)}>{sentenceCase(fulfillment)}</ToneChip> : null}
          </div>
        ) : null}

        {statusKey !== null ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <StatusSelect
              statuses={statuses}
              value={statusKey}
              onChange={onChangeStatus}
              label={`Status for order ${name}`}
              size="md"
              busy={statusBusy}
            />
            {shopifyUrl ? (
              <a href={shopifyUrl} target="_blank" rel="noopener noreferrer" className={`${ui.buttonSecondary} h-9`}>
                <ArrowSquareOutIcon size={16} aria-hidden />
                Open in Shopify
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </div>
        ) : null}
        {setBy && statusSetAt !== null ? (
          <p className="mt-2 text-xs text-ink-2">
            Status set by {setBy}, {now > 0 ? relativeTime(statusSetAt, now) : formatDateTime(statusSetAt)}
          </p>
        ) : null}
        {rowError ? (
          <p role="alert" className="mt-2 text-xs font-medium text-bad">
            {rowError}
          </p>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
        {detail.status === "error" ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-ink">
              {detail.missing ? "This order is not in this workspace. It may have been removed." : detail.message}
            </p>
            {detail.missing ? null : (
              <button type="button" onClick={onRetry} className={`${ui.buttonSecondary} h-9`}>
                Try again
              </button>
            )}
          </div>
        ) : null}

        {detail.status === "loading" ? (
          <div aria-label="Loading order" className="flex flex-col gap-3">
            <span className="od-skeleton h-4 w-40" />
            <span className="od-skeleton h-3.5 w-56" />
            <span className="od-skeleton mt-4 h-4 w-24" />
            <span className="od-skeleton h-12 w-full rounded-panel" />
            <span className="od-skeleton h-12 w-full rounded-panel" />
          </div>
        ) : null}

        {snapshot && order ? (
          <>
            <Section title="Customer">
              <p className="text-sm font-medium text-ink">{snapshot.customerName || "No customer name"}</p>
              {snapshot.email ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="select-all break-all text-sm text-ink-2">{snapshot.email}</span>
                  <CopyButton text={snapshot.email} label="Copy email" />
                </div>
              ) : (
                <p className="mt-1 text-sm text-ink-2">No email on this order.</p>
              )}
            </Section>

            <Section title="Items">
              {itemsTruncated ? (
                <p data-tone="amber" className="mb-3 flex gap-2 rounded-panel bg-tone-fill px-3 py-2.5 text-sm text-tone-text">
                  <InfoIcon size={18} aria-hidden className="mt-px shrink-0" />
                  <span>This order has more items than {APP_NAME} syncs. Open it in Shopify to see all of them.</span>
                </p>
              ) : null}
              {snapshot.items.length === 0 ? (
                <p className="text-sm text-ink-2">No line items.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {snapshot.items.map((item, index) => {
                    const unit = item.price === null ? null : formatMoney(item.price, snapshot.currency);
                    const line =
                      item.price === null || !Number.isFinite(Number(item.price))
                        ? null
                        : formatMoney((Number(item.price) * item.qty).toFixed(2), snapshot.currency);
                    return (
                      <li key={index} className="flex gap-4 py-3 first:pt-0 last:pb-0">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-ink">{item.title || "Untitled item"}</p>
                          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-2">
                            {item.variant ? <span>{item.variant}</span> : null}
                            {item.sku ? <span className="font-mono">SKU {item.sku}</span> : null}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-mono text-sm tabular-nums text-ink">{line ?? "No price"}</p>
                          <p className="font-mono text-xs tabular-nums text-ink-2">
                            {item.qty} x {unit ?? "?"}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <dl className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3 text-sm">
                {!itemsTruncated && itemsSubtotal(snapshot.items) !== null ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-2">Items</dt>
                    <dd className="font-mono tabular-nums text-ink">
                      {formatMoney(itemsSubtotal(snapshot.items) ?? "", snapshot.currency)}
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4">
                  <dt className="font-semibold text-ink">Order total</dt>
                  <dd className="font-mono font-semibold tabular-nums text-ink">
                    {formatMoney(snapshot.total, snapshot.currency)}
                  </dd>
                </div>
              </dl>
              <p className="mt-1.5 text-xs text-ink-2">
                The order total comes from Shopify and includes shipping, taxes and discounts.
              </p>
            </Section>

            <Section title="Ship to">
              {snapshot.shipping ? (
                <address className="text-sm not-italic leading-relaxed text-ink">
                  {shippingLines(snapshot.shipping).map((line, index) => (
                    <span key={index} className="block">
                      {line}
                    </span>
                  ))}
                </address>
              ) : (
                <p className="text-sm text-ink-2">No shipping address on this order.</p>
              )}
            </Section>

            <Section title="Tags and checkout note">
              {snapshot.tags.length === 0 && !snapshot.note ? (
                <p className="text-sm text-ink-2">No tags or checkout note.</p>
              ) : null}
              {snapshot.tags.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
                  {snapshot.tags.map((tag) => (
                    <li key={tag}>
                      <ToneChip tone="slate">{tag}</ToneChip>
                    </li>
                  ))}
                </ul>
              ) : null}
              {snapshot.note ? (
                <p className="mt-3 whitespace-pre-wrap break-words rounded-panel bg-surface-2 px-3 py-2.5 text-sm text-ink">
                  {snapshot.note}
                </p>
              ) : null}
            </Section>

            <PurchaseOrders
              orderId={orderId}
              canManage={canManagePos}
              refreshKey={poRefreshKey}
              onCreate={onCreatePo}
              onEdit={onEditPo}
            />
          </>
        ) : null}

        {detail.status !== "error" || !detail.missing ? (
          <Section title="Activity">
            <NoteComposer onSubmit={onAddNote} />
            <div className="mt-6">
              <Timeline
                events={timeline}
                status={timelineStatus}
                members={members}
                selfUserId={selfUserId}
                onRetry={onRetry}
              />
            </div>
          </Section>
        ) : null}
      </div>
    </>
  );
}
