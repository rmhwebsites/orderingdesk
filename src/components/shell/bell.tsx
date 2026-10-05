"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { ChatTextIcon } from "@phosphor-icons/react/ChatText";
import { ChecksIcon } from "@phosphor-icons/react/Checks";
import { FileTextIcon } from "@phosphor-icons/react/FileText";
import { ShoppingBagIcon } from "@phosphor-icons/react/ShoppingBag";
import { StorefrontIcon } from "@phosphor-icons/react/Storefront";
import { TagIcon } from "@phosphor-icons/react/Tag";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { actorLabel, activityToasts, orderHref, unreadBadge } from "@/lib/activity-feed";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { ActivityFeed, ActivityItem } from "@/server/activity";
import { useToast } from "@/components/toasts";
import { ui } from "@/components/ui";
import { useWorkspace } from "./workspace-provider";

// The activity bell in the top bar: the unread count (events newer than
// this member's last visit that someone else made), a dropdown of recent
// activity linking to each order, and Mark all read. It reloads after
// every live event and resync on the workspace bus, and turns status
// changes and notes by others into toasts. A platform admin who is not a
// member sees the feed with no count.

const RELOAD_DELAY_MS = 400;

const ICONS: Record<ActivityItem["type"], typeof BellIcon> = {
  order_new: ShoppingBagIcon,
  status: TagIcon,
  note: ChatTextIcon,
  po_draft: FileTextIcon,
  po_sent: FileTextIcon,
  sync_error: WarningIcon,
  // Only failed Shopify writes reach the feed.
  shopify_write: StorefrontIcon,
};

function itemTitle(item: ActivityItem): string {
  if (item.orderName) {
    return item.orderName;
  }
  return item.type === "sync_error" ? "Store sync" : "Workspace";
}

function ItemContent({ item, now }: { item: ActivityItem; now: number }) {
  const Icon = item.type === "shopify_write" ? WarningIcon : ICONS[item.type] ?? BellIcon;
  return (
    <>
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-2">
        <Icon size={16} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-sm text-ink ${item.orderName ? "font-mono" : ""} ${item.unread ? "font-semibold" : "font-medium"}`}
          >
            {itemTitle(item)}
          </span>
          <time
            dateTime={new Date(item.createdAt).toISOString()}
            title={formatDateTime(item.createdAt)}
            className="shrink-0 text-xs tabular-nums text-ink-2"
          >
            {now > 0 ? relativeTime(item.createdAt, now) : formatDateTime(item.createdAt)}
          </time>
        </span>
        <span className="mt-0.5 line-clamp-2 break-words text-sm text-ink-2">{item.text}</span>
        <span className="mt-0.5 block text-xs text-ink-2">{actorLabel(item)}</span>
      </span>
      {item.unread ? (
        <span className="mt-2 size-2 shrink-0 rounded-full bg-primary-strong">
          <span className="sr-only">Unread</span>
        </span>
      ) : null}
    </>
  );
}

export function Bell() {
  const { workspace, subscribe } = useWorkspace();
  const toast = useToast();
  const now = useNow(30000);
  const panelId = useId();
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/activity`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as ActivityFeed;
      for (const next of activityToasts(known.current, body.items)) {
        toast(next);
      }
      known.current = new Set([...(known.current ?? []), ...body.items.map((item) => item.id)]);
      setFeed(body);
      setStatus("ready");
    } catch {
      // A failed refresh keeps what is shown; only a first load fails.
      setStatus((current) => (current === "ready" ? current : "error"));
    }
  }, [workspace.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every live event (and every resync after a reconnect or poll) may have
  // added activity: reload once things settle.
  useEffect(
    () =>
      subscribe(() => {
        if (reloadTimer.current) {
          clearTimeout(reloadTimer.current);
        }
        reloadTimer.current = setTimeout(() => void load(), RELOAD_DELAY_MS);
      }),
    [subscribe, load],
  );

  useEffect(
    () => () => {
      if (reloadTimer.current) {
        clearTimeout(reloadTimer.current);
      }
    },
    [],
  );

  // Open: focus the panel; a click outside or Escape closes it (Escape
  // gives focus back to the bell).
  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markAllRead() {
    setMarking(true);
    setMarkError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/seen`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const { lastSeenAt } = (await response.json()) as { lastSeenAt: number };
      setFeed((current) =>
        current ? { ...current, unread: 0, lastSeenAt, items: current.items.map((item) => ({ ...item, unread: false })) } : current,
      );
      buttonRef.current?.focus();
    } catch {
      setMarkError("Not marked as read. Try again.");
    } finally {
      setMarking(false);
    }
  }

  const badge = unreadBadge(feed?.unread ?? null);
  const items = feed?.items ?? [];

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={badge ? `Activity, ${badge} unread` : "Activity"}
        onClick={() => {
          setOpen((current) => !current);
          if (!open) {
            void load();
          }
        }}
        className={`${ui.iconButton} relative`}
      >
        <BellIcon size={20} aria-hidden />
        {badge ? (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 h-[1.125rem] min-w-[1.125rem] rounded-control bg-primary px-1 text-center text-[11px] font-semibold leading-[1.125rem] text-primary-ink tabular-nums ring-2 ring-surface"
          >
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="Activity"
          tabIndex={-1}
          className="od-rise absolute right-0 top-full z-10 mt-2 flex max-h-[min(34rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-lift focus:outline-none"
        >
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2">
            <h2 className="font-display text-sm font-semibold text-ink">Activity</h2>
            {feed && feed.unread !== null && feed.unread > 0 ? (
              <button type="button" onClick={markAllRead} disabled={marking} className={`${ui.buttonQuiet} -mr-2 h-8 text-xs`}>
                <ChecksIcon size={16} aria-hidden />
                {marking ? "Marking" : "Mark all read"}
              </button>
            ) : null}
          </div>
          {markError ? (
            <p role="alert" className="px-4 pt-2 text-xs text-bad">
              {markError}
            </p>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!feed && status === "loading" ? (
              <ul aria-label="Loading activity" className="flex flex-col gap-4 px-4 py-4">
                {[0, 1, 2].map((row) => (
                  <li key={row} className="flex gap-3">
                    <span className="od-skeleton size-8 shrink-0" />
                    <span className="flex flex-1 flex-col gap-1.5 pt-1">
                      <span className="od-skeleton h-3.5 w-24" />
                      <span className="od-skeleton h-3 w-48" />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {!feed && status === "error" ? (
              <p role="alert" className="px-4 py-4 text-sm text-bad">
                Activity did not load.{" "}
                <button type="button" onClick={() => void load()} className="font-semibold underline underline-offset-2">
                  Try again
                </button>
              </p>
            ) : null}

            {feed && items.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-2">No activity yet. New orders, status changes and notes show up here.</p>
            ) : null}

            {items.length > 0 ? (
              <ol className="divide-y divide-line">
                {items.map((item) => {
                  const rowClass = "flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2";
                  return (
                    <li key={item.id}>
                      {item.orderId ? (
                        <Link href={orderHref(workspace.basePath, item.orderId)} onClick={() => setOpen(false)} className={rowClass}>
                          <ItemContent item={item} now={now} />
                        </Link>
                      ) : (
                        <div className={rowClass}>
                          <ItemContent item={item} now={now} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
