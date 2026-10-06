"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/PaperPlaneRight";
import { XIcon } from "@phosphor-icons/react/X";
import {
  formatDateTime,
  relativeTime,
  sentenceCase,
  shopifyAdminDraftUrl,
  shopifyAdminOrderUrl,
} from "@/lib/format";
import { NOTE_MAX } from "@/lib/limits";
import { financialTone, fulfillmentTone, readSnapshot } from "@/lib/order-snapshot";
import { requestFieldsOf } from "@/lib/request-fields";
import { roleAtLeast, type Role } from "@/lib/roles";
import { statusOptionsFor } from "@/lib/status-options";
import { eventLook } from "@/lib/event-look";
import { useNow } from "@/lib/use-now";
import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
import { EventIcon } from "@/components/event-icon";
import { ui } from "@/components/ui";
import { focusSoon } from "@/components/settings/kit";
import { StatusSelect } from "./status-select";
import { APP_NAME } from "@/lib/brand";
import type { PoView } from "@/server/po/service";
import { PurchaseOrders } from "./po-history";
import { Chip, Spinner } from "@/components/kit";
import { CopyButton, Section } from "./drawer-kit";
import { ItemsSection, RequestSection, ShipToSection } from "./request-parts";
import { ReviewPanel, type NextRequest } from "./review-panel";

export type DrawerOrder = {
  id: string;
  // Null while the card is a request (draft orders spec section 2).
  shopifyOrderId: string | null;
  name: string;
  shopify: unknown;
  statusKey: string;
  statusSetBy: string | null;
  statusSetAt: number | null;
  createdAt: number;
  shopifyDraftId: string | null;
  draftName: string | null;
  draftSnapshot: unknown;
  draftDeletedAt: number | null;
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

function actorName(event: EventView, members: Map<string, MemberView>, selfUserId: string): string {
  if (!event.actorId) {
    return event.source === "shopify" || event.type === "order_new" ? "Shopify" : APP_NAME;
  }
  if (event.actorId === selfUserId) {
    return "You";
  }
  const member = members.get(event.actorId);
  if (member) {
    return member.name?.trim() || member.email || "Team member";
  }
  // Not a member: a platform admin from outside the workspace (who may
  // approve and reject), named by the server; else someone who left.
  return event.actorName?.trim() || "Former member";
}

// Who set the card's current status, for "Status set by ...": a member by
// the member list, else the name on the newest status entry that person
// wrote (a platform admin who is not a member), else a former member.
function statusSetterName(
  userId: string,
  members: Map<string, MemberView>,
  timeline: EventView[],
): string {
  const member = members.get(userId);
  const fromMembers = member?.name?.trim() || member?.email;
  if (fromMembers) {
    return fromMembers;
  }
  const entry = timeline
    .filter((event) => event.type === "status" && event.actorId === userId && event.actorName?.trim())
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return entry?.actorName?.trim() || "a former member";
}

function metaOf(event: EventView): Record<string, unknown> {
  return typeof event.meta === "object" && event.meta !== null ? (event.meta as Record<string, unknown>) : {};
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
      {events.map((event) => (
        <li key={event.id} className="flex gap-3">
          <EventIcon look={eventLook(event)} />
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
              <>
                {metaOf(event).rejectReason === true ? (
                  <p className="mt-1 text-xs font-semibold text-ink-2">Reason</p>
                ) : null}
                <p className="mt-1.5 whitespace-pre-wrap break-words rounded-panel bg-surface-2 px-3 py-2 text-sm text-ink">
                  {event.text}
                </p>
              </>
            ) : (
              <p className="mt-0.5 break-words text-sm text-ink-2">{event.text}</p>
            )}
          </div>
        </li>
      ))}
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
          <button
            type="submit"
            disabled={sending || text.trim().length === 0}
            aria-busy={sending || undefined}
            className={`${ui.buttonPrimary} h-9`}
          >
            {sending ? <Spinner /> : <PaperPlaneRightIcon size={16} aria-hidden />}
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

export type ReviewState = {
  // Whether draft orders sync for the store (the stored grant).
  draftsEnabled: boolean;
};

const DRAFT_STATUS_LABEL = { open: "Open", invoice_sent: "Invoice sent", completed: "Completed" } as const;

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
  role,
  shopDomain,
  drafts,
  onChangeStatus,
  onAddNote,
  onApprove,
  onReject,
  nextRequest,
  onApproveAndNext,
  onClose,
  onRetry,
  canManagePos,
  poRefreshKey,
  onCreatePo,
  onEditPo,
  showPrices = true,
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
  role: Role;
  shopDomain: string | null;
  drafts: ReviewState;
  onChangeStatus: (statusKey: string) => void;
  onAddNote: (text: string) => Promise<string | null>;
  // Approve and Reject a request: the error to show, or null.
  onApprove: () => Promise<string | null>;
  onReject: (reason: string) => Promise<string | null>;
  // Approve and next: the next request waiting, and the approval that then
  // opens it (comprehensive desk design section 1).
  nextRequest?: NextRequest | null;
  onApproveAndNext?: () => Promise<string | null>;
  onClose: () => void;
  onRetry: () => void;
  // Managers and platform admins create and send purchase orders; staff
  // see the history only (the server enforces it either way).
  canManagePos: boolean;
  poRefreshKey: number;
  onCreatePo: () => void;
  onEditPo: (po: PoView) => void;
  // Totals and the Paid chip (the workspace's Show prices setting); a card
  // with a price keeps its totals either way.
  showPrices?: boolean;
}) {
  const order = detail.status === "ready" ? detail.order : null;
  const snapshot = order ? readSnapshot(order.shopify) : null;
  // The card's kind follows its Shopify order id (a request has none). Right
  // after an approval the snapshot can still be the draft for a moment.
  const kind: "draft" | "order" = order ? (order.shopifyOrderId === null ? "draft" : "order") : (summary?.kind ?? "order");
  const showsDraft = kind === "draft" || snapshot?.kind === "draft";
  const loadingOrder = kind === "order" && snapshot?.kind === "draft";
  const draftName = order?.draftName ?? summary?.draftName ?? null;
  const name = order?.name ?? summary?.name ?? "";
  const createdAt = order?.createdAt ?? summary?.createdAt ?? null;
  const statusKey = summary?.statusKey ?? order?.statusKey ?? null;
  const statusSetBy = summary?.statusSetBy ?? order?.statusSetBy ?? null;
  const statusSetAt = summary?.statusSetAt ?? order?.statusSetAt ?? null;
  const financial = snapshot && !showsDraft ? snapshot.financialStatus : kind === "order" ? (summary?.financialStatus ?? "") : "";
  const fulfillment =
    snapshot && !showsDraft ? snapshot.fulfillmentStatus : kind === "order" ? (summary?.fulfillmentStatus ?? "") : "";
  const deleted = kind === "draft" && (order ? order.draftDeletedAt !== null : (summary?.draftDeleted ?? false));
  // A draft Shopify deleted keeps its last snapshot (status still "open"):
  // the Deleted chip carries its state alone, never next to "Open".
  const draftStatus = kind === "draft" && !deleted ? (snapshot?.draftStatus ?? summary?.draftStatus ?? null) : null;
  // A draft Shopify deleted has no admin page to open.
  const shopifyUrl = order
    ? order.shopifyOrderId !== null
      ? shopifyAdminOrderUrl(shopDomain, order.shopifyOrderId)
      : order.draftDeletedAt === null
        ? shopifyAdminDraftUrl(shopDomain, order.shopifyDraftId)
        : null
    : null;
  const itemsTruncated = detail.status === "ready" ? detail.itemsTruncated : (summary?.itemsTruncated ?? false);
  const fields = order ? requestFieldsOf(order.shopify, order.draftSnapshot) : null;
  const kept = order && kind === "order" && order.draftSnapshot ? readSnapshot(order.draftSnapshot) : null;
  const canReview = roleAtLeast(role, "manager");
  const statusOptions =
    statusKey !== null ? statusOptionsFor({ kind, role, currentKey: statusKey, statuses }) : null;
  const approvedStatus = statuses.find((status) => status.shopifyLink === "draft_completed");
  const rejectedStatus = statuses.find((status) => status.shopifyLink === "draft_rejected");
  const draftsOff = "Draft orders are not enabled for this store's Shopify app.";
  const approveBlock = deleted
    ? "Shopify no longer has this draft."
    : !drafts.draftsEnabled
      ? draftsOff
      : !approvedStatus
        ? "Set a status to follow Draft approved in Settings > Statuses."
        : null;
  const rejectBlock = !drafts.draftsEnabled
    ? draftsOff
    : !rejectedStatus
      ? "Set a status to follow Draft rejected in Settings > Statuses."
      : null;
  const zeroTotal = snapshot ? Number(snapshot.total) === 0 && snapshot.total.trim().length > 0 : true;
  // A status set with no person behind it came from Shopify (a fulfillment,
  // a delivery, a completion or the Ordering Desk tag edited there).
  const setBy = statusSetBy
    ? statusSetBy === selfUserId
      ? "you"
      : statusSetterName(statusSetBy, members, timeline)
    : statusSetAt !== null
      ? "Shopify"
      : null;
  const now = useNow(30000);
  const placedAt = kind === "order" && snapshot && !showsDraft ? snapshot.createdAt : null;

  return (
    <>
      <header className="border-b border-line px-4 pb-4 pt-4 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {name ? (
              <>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <h2 id={labelId} tabIndex={-1} className="font-mono text-xl font-semibold tabular-nums text-ink outline-none">
                    <span className="sr-only">{kind === "draft" ? "Draft order " : "Order "}</span>
                    {name}
                  </h2>
                  {kind === "draft" ? (
                    <Chip tone="slate" size="sm">
                      Draft
                    </Chip>
                  ) : null}
                  {deleted ? (
                    <Chip tone="amber" size="sm">
                      Deleted in Shopify
                    </Chip>
                  ) : null}
                </div>
                {kind === "order" && draftName ? (
                  <p className="mt-0.5 text-sm text-ink-2">
                    from draft <span className="font-mono tabular-nums">{draftName}</span>
                  </p>
                ) : null}
                {createdAt !== null ? (
                  <p className="mt-0.5 text-sm tabular-nums text-ink-2">
                    {kind === "draft"
                      ? `Submitted ${formatDateTime(createdAt)}`
                      : draftName
                        ? `Requested ${formatDateTime(createdAt)}.${placedAt !== null ? ` Order placed ${formatDateTime(placedAt)}.` : ""}`
                        : `Placed ${formatDateTime(createdAt)}`}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <h2 id={labelId} tabIndex={-1} className="sr-only">
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

        {draftStatus ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Chip tone="blue">{DRAFT_STATUS_LABEL[draftStatus]}</Chip>
          </div>
        ) : (financial && showPrices) || fulfillment ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {financial && showPrices ? <Chip tone={financialTone(financial)}>{sentenceCase(financial)}</Chip> : null}
            {fulfillment ? <Chip tone={fulfillmentTone(fulfillment)}>{sentenceCase(fulfillment)}</Chip> : null}
          </div>
        ) : null}

        {statusKey !== null && statusOptions ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <StatusSelect
              statuses={statusOptions.options}
              value={statusKey}
              onChange={onChangeStatus}
              label={`Status for ${kind === "draft" ? "request" : "order"} ${name}`}
              size="md"
              busy={statusBusy}
              disabled={statusOptions.disabled}
              hint={statusOptions.hint}
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
        {statusOptions?.hint ? (
          <p aria-hidden className="mt-2 text-xs text-ink-2">
            {statusOptions.hint}
          </p>
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

        {snapshot && order && fields ? (
          <>
            {loadingOrder ? (
              <p role="status" className="mb-5 flex items-center gap-2 text-sm text-ink-2">
                <InfoIcon size={16} aria-hidden className="shrink-0" />
                Loading order {name} from Shopify
              </p>
            ) : null}

            {kind === "draft" ? (
              <ReviewPanel
                name={name}
                email={snapshot.email}
                canReview={canReview}
                rejected={rejectedStatus !== undefined && statusKey === rejectedStatus.key}
                approveBlock={approveBlock}
                rejectBlock={rejectBlock}
                completeInShopify={zeroTotal || deleted ? null : { url: shopifyUrl }}
                onApprove={async () => {
                  const failure = await onApprove();
                  if (!failure) {
                    focusSoon(() => document.getElementById(labelId));
                  }
                  return failure;
                }}
                onReject={onReject}
                next={nextRequest ?? null}
                onApproveAndNext={
                  onApproveAndNext
                    ? async () => {
                        const failure = await onApproveAndNext();
                        if (!failure) {
                          focusSoon(() => document.getElementById(labelId));
                        }
                        return failure;
                      }
                    : undefined
                }
              />
            ) : null}

            {showsDraft || draftName ? (
              <RequestSection
                customerName={snapshot.customerName}
                email={snapshot.email}
                fields={fields}
                note={showsDraft ? snapshot.note : (kept?.note ?? "")}
                poNumber={showsDraft ? snapshot.poNumber : (kept?.poNumber ?? "")}
              />
            ) : (
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
            )}

            <ItemsSection snapshot={snapshot} itemsTruncated={itemsTruncated} shopifyUrl={shopifyUrl} showPrices={showPrices} />

            <ShipToSection shipping={snapshot.shipping} />

            <Section title={showsDraft ? "Tags" : "Tags and checkout note"}>
              {snapshot.tags.length === 0 && (showsDraft || !snapshot.note) ? (
                <p className="text-sm text-ink-2">{showsDraft ? "No tags." : "No tags or checkout note."}</p>
              ) : null}
              {snapshot.tags.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
                  {snapshot.tags.map((tag) => (
                    <li key={tag}>
                      <Chip tone="slate">{tag}</Chip>
                    </li>
                  ))}
                </ul>
              ) : null}
              {!showsDraft && snapshot.note ? (
                <p className="mt-3 whitespace-pre-wrap break-words rounded-panel bg-surface-2 px-3 py-2.5 text-sm text-ink">
                  {snapshot.note}
                </p>
              ) : null}
            </Section>

            {kind === "order" ? (
              <PurchaseOrders
                orderId={orderId}
                needsPo={statuses.find((status) => status.key === statusKey && status.triggersPo)?.label ?? null}
                canManage={canManagePos}
                refreshKey={poRefreshKey}
                onCreate={onCreatePo}
                onEdit={onEditPo}
              />
            ) : null}
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
