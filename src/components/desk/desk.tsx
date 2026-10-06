"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { XIcon } from "@phosphor-icons/react/X";
import type { DeskView, ViewCounts } from "@/lib/desk-query";
import {
  applyLiveEvent,
  approvalNotice,
  arrivalNotice,
  chipsForView,
  crossesClosed,
  deskKindCounts,
  dropsDeletedFilter,
  nextWaitingRequest,
  optimisticStatus,
  rollbackStatus,
  selectOrders,
  shiftViewCounts,
  statusChips,
  totalOrders,
  touchesPurchaseOrders,
  viewMatches,
  withPurchaseOrder,
  type DeskFilter,
  type DeskKind,
  type DeskState,
  type LiveEffects,
} from "@/lib/desk-state";
import { DEFAULT_QUEUE_SETTINGS, type QueueSettingsView } from "@/lib/queue-settings";
import { roleAtLeast } from "@/lib/roles";
import { DESK_MEDIA, useMediaQuery } from "@/lib/use-media-query";
import { useNow } from "@/lib/use-now";
import type { LiveEvent, LiveOrderStatus } from "@/lib/live-events";
import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
import type { PoView } from "@/server/po/service";
import { useWorkspace } from "@/components/shell/workspace-provider";
import { useToast } from "@/components/toasts";
import { DeskSkeleton } from "./desk-skeleton";
import { DeskLoadError, EmptyDesk, NoMatches } from "./empty-states";
import {
  DrawerShell,
  OrderDrawerContent,
  type DrawerDetail,
  type DrawerOrder,
  type MemberView,
} from "./order-drawer";
import { OrderList } from "./order-list";
import { PoModal } from "./po-modal";
import { Toolbar } from "./toolbar";
import { useDeskFilter } from "./use-desk-filter";
import { ui } from "@/components/ui";
import { InlineMessage } from "@/components/kit";

type DeskPayload = {
  statuses: StatusView[];
  statusCounts: Record<string, number>;
  orders: OrderSummary[];
  hasMore: boolean;
  draftCount: number;
  deletedDraftCount: number;
  drafts: { enabled: boolean; missingScopes: string[] };
  view: DeskView;
  viewCounts: ViewCounts;
  queue: QueueSettingsView;
};

type DraftsState = { draftCount: number; deletedDraftCount: number; enabled: boolean; missingScopes: string[] };

// A status change the server answered with a reason to show.
class StatusRefused extends Error {}

const BANNER_KEY = (workspaceId: string) => `od:drafts-banner-dismissed:${workspaceId}`;

function bannerDismissed(workspaceId: string): boolean {
  try {
    return window.localStorage.getItem(BANNER_KEY(workspaceId)) === "1";
  } catch {
    return false;
  }
}

function dismissBanner(workspaceId: string): void {
  try {
    window.localStorage.setItem(BANNER_KEY(workspaceId), "1");
  } catch {
    // Storage blocked: the banner just comes back next time.
  }
}

// Platform admins only (draft orders spec section 11.8): this store's app
// lacks the draft scopes, so requests are not synced.
function DraftsBanner({ settingsHref, onDismiss }: { settingsHref: string; onDismiss: () => void }) {
  return (
    <InlineMessage
      tone="info"
      action={
        <button type="button" onClick={onDismiss} className={`${ui.iconButton} size-9 text-tone-text`}>
          <XIcon size={16} aria-hidden />
          <span className="sr-only">Dismiss this message</span>
        </button>
      }
    >
      Draft orders are not synced for this store. Grant read_draft_orders and write_draft_orders to the Shopify app, then
      use Refresh connection in{" "}
      <a href={settingsHref} className="font-semibold underline underline-offset-2">
        Settings
      </a>
      .
    </InlineMessage>
  );
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

const FLASH_MS = 1800;
const MEMBERS_REFRESH_MS = 60000;
const DRAWER_TITLE_ID = "order-drawer-title";

function withDetailStatus(detail: DrawerDetail, change: LiveOrderStatus): DrawerDetail {
  if (detail.status !== "ready" || detail.order.id !== change.id) {
    return detail;
  }
  if (detail.order.statusSetAt !== null && detail.order.statusSetAt > change.statusSetAt) {
    return detail;
  }
  return {
    ...detail,
    order: {
      ...detail.order,
      statusKey: change.statusKey,
      statusSetBy: change.statusSetBy,
      statusSetAt: change.statusSetAt,
    },
  };
}

export function Desk() {
  const { workspace, userId, role, connection, subscribe, refreshQueue } = useWorkspace();
  const toast = useToast();
  const searchParams = useSearchParams();
  const openOrderId = searchParams.get("order");
  const isDesk = useMediaQuery(DESK_MEDIA);
  const now = useNow(60000);

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [statuses, setStatuses] = useState<StatusView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [desk, setDesk] = useState<DeskState>({ orders: [], statusCounts: {}, timeline: null });
  const deskRef = useRef(desk);
  // The view and filters live in the address (use-desk-filter.ts).
  const [deskQuery, updateDeskQuery] = useDeskFilter();
  const filter = useMemo<DeskFilter>(
    () => ({ query: deskQuery.q, statusKey: deskQuery.status, sort: deskQuery.sort, kind: deskQuery.kind, view: deskQuery.view }),
    [deskQuery],
  );
  const view: DeskView = deskQuery.view;
  const [viewCounts, setViewCounts] = useState<ViewCounts>({ open: 0, approval: 0, all: 0, closed: 0 });
  const [queue, setQueue] = useState<QueueSettingsView>(DEFAULT_QUEUE_SETTINGS);
  // A different view is loading; the list stays while it does.
  const [switching, setSwitching] = useState(false);
  const viewRef = useRef<DeskView>(view);
  const closedRef = useRef<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<DraftsState>({ draftCount: 0, deletedDraftCount: 0, enabled: false, missingScopes: [] });
  const [bannerHidden, setBannerHidden] = useState(true);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Orders whose status change is saving: their status control saves
  // nothing else meanwhile (src/lib/status-commit.ts).
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set());

  // Drawer state. drawerOrderId outlives openOrderId through the closing
  // slide so the panel does not empty while it leaves.
  const [drawerOrderId, setDrawerOrderId] = useState<string | null>(openOrderId);
  const [detail, setDetail] = useState<DrawerDetail>({ status: "loading" });
  const [timelineStatus, setTimelineStatus] = useState<"loading" | "error" | "ready">("loading");
  const [members, setMembers] = useState<Map<string, MemberView>>(() => new Map());
  const openRef = useRef(openOrderId);
  const pushedRef = useRef(false);
  const membersLoadedAt = useRef(0);
  // The purchase order review modal (managers and platform admins), and a
  // counter that reloads the open drawer's PO history.
  const canManagePos = roleAtLeast(role, "manager");
  const [poModal, setPoModal] = useState<{ orderId: string; po: PoView | null } | null>(null);
  const [poRefresh, setPoRefresh] = useState(0);

  // Status changes still waiting for the server, re-applied over any reload
  // that lands meanwhile so the row does not flick back.
  const pendingStatus = useRef(new Map<string, string>());
  const pendingAnnounce = useRef<string[]>([]);
  const pendingFlash = useRef<string[]>([]);
  const announced = useRef(new Set<string>());
  const inFlight = useRef<Promise<void> | null>(null);
  const reloadAgain = useRef(false);

  useEffect(() => {
    openRef.current = openOrderId;
  }, [openOrderId]);

  const commit = useCallback((next: DeskState) => {
    deskRef.current = next;
    setDesk(next);
  }, []);

  const flash = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    setFlashing((current) => new Set([...current, ...ids]));
    setTimeout(() => {
      setFlashing((current) => {
        const next = new Set(current);
        for (const id of ids) {
          next.delete(id);
        }
        return next;
      });
    }, FLASH_MS);
  }, []);

  const fetchDesk = useCallback(async () => {
    const requested = viewRef.current;
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/orders?view=${requested}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The server answered ${response.status}.`);
      }
      const payload = (await response.json()) as DeskPayload;
      if (requested !== viewRef.current) {
        // The view changed while this request was out: load the new one.
        reloadAgain.current = true;
        return;
      }
      let next: DeskState = { ...deskRef.current, orders: payload.orders, statusCounts: payload.statusCounts };
      for (const [orderId, key] of pendingStatus.current) {
        next = optimisticStatus(next, orderId, key)?.state ?? next;
      }
      commit(next);
      setStatuses(payload.statuses);
      setViewCounts(payload.viewCounts);
      setQueue(payload.queue);
      setSwitching(false);
      setHasMore(payload.hasMore);
      setDrafts({
        draftCount: payload.draftCount ?? 0,
        deletedDraftCount: payload.deletedDraftCount ?? 0,
        enabled: payload.drafts?.enabled ?? false,
        missingScopes: payload.drafts?.missingScopes ?? [],
      });
      setLoad({ status: "ready" });

      const loadedIds = new Set(payload.orders.map((order) => order.id));
      const toAnnounce = pendingAnnounce.current.filter((id) => !announced.current.has(id));
      pendingAnnounce.current = [];
      if (toAnnounce.length > 0) {
        for (const id of toAnnounce) {
          announced.current.add(id);
        }
        const found = payload.orders.filter((order) => toAnnounce.includes(order.id));
        toast(
          found.length > 0
            ? { ...arrivalNotice(found), tone: "good" }
            : { title: `${toAnnounce.length} new ${toAnnounce.length === 1 ? "order" : "orders"}`, tone: "good" },
        );
      }
      flash(pendingFlash.current.filter((id) => loadedIds.has(id)));
      pendingFlash.current = [];
    } catch (e) {
      const message = e instanceof Error ? e.message : "Check your connection and try again.";
      // A failed refresh keeps what is on screen; only a first load fails.
      setLoad((current) => (current.status === "ready" ? current : { status: "error", message }));
      setSwitching(false);
    }
  }, [workspace.id, commit, flash, toast]);

  // One reload at a time; requests that arrive meanwhile fold into one more.
  const reload = useCallback(() => {
    if (inFlight.current) {
      reloadAgain.current = true;
      return inFlight.current;
    }
    const run = async () => {
      do {
        reloadAgain.current = false;
        await fetchDesk();
      } while (reloadAgain.current);
    };
    inFlight.current = run().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  }, [fetchDesk]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const closedKeys = useMemo(
    () => new Set(statuses.filter((status) => status.closed).map((status) => status.key)),
    [statuses],
  );
  useEffect(() => {
    closedRef.current = closedKeys;
  }, [closedKeys]);

  // A different view: load it (the server filters; the list stays until
  // the new one lands).
  useEffect(() => {
    if (viewRef.current === view) {
      return;
    }
    viewRef.current = view;
    setSwitching(true);
    void reload();
  }, [view, reload]);

  const loadMembers = useCallback(async () => {
    membersLoadedAt.current = Date.now();
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`, {
        cache: "no-store",
      });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { members: MemberView[] };
      setMembers(new Map(body.members.map((member) => [member.userId, member])));
    } catch {
      // Names fall back to "Former member" until the next try.
    }
  }, [workspace.id]);

  // The open order and its timeline. quiet keeps what is shown while it
  // refreshes (after a reconnect, a poll, or a sync that touched it).
  const loadDrawer = useCallback(
    async (orderId: string, quiet: boolean) => {
      if (!quiet) {
        setDetail({ status: "loading" });
        setTimelineStatus("loading");
        commit({ ...deskRef.current, timeline: { orderId, events: [] } });
      }
      const [detailResult, eventsResult] = await Promise.allSettled([
        fetch(`/api/orders/${encodeURIComponent(orderId)}`, { cache: "no-store" }),
        fetch(
          `/api/workspaces/${encodeURIComponent(workspace.id)}/events?orderId=${encodeURIComponent(orderId)}`,
          { cache: "no-store" },
        ),
      ]);
      if (openRef.current !== orderId) {
        return;
      }

      if (detailResult.status === "fulfilled" && detailResult.value.ok) {
        const body = (await detailResult.value.json()) as { order: DrawerOrder; itemsTruncated: boolean };
        setDetail({ status: "ready", order: body.order, itemsTruncated: body.itemsTruncated });
      } else if (detailResult.status === "fulfilled" && detailResult.value.status === 404) {
        setDetail({ status: "error", message: "Not found", missing: true });
      } else if (!quiet) {
        setDetail({ status: "error", message: "This order did not load. Check your connection.", missing: false });
      }

      if (eventsResult.status === "fulfilled" && eventsResult.value.ok) {
        const body = (await eventsResult.value.json()) as { events: EventView[] };
        if (openRef.current !== orderId) {
          return;
        }
        // Keep anything a live event added while the request was out.
        const current = deskRef.current.timeline;
        const extra =
          current && current.orderId === orderId
            ? current.events.filter((event) => !body.events.some((loaded) => loaded.id === event.id))
            : [];
        const events = [...extra, ...body.events].sort((a, b) => b.createdAt - a.createdAt);
        commit({ ...deskRef.current, timeline: { orderId, events } });
        setTimelineStatus("ready");
      } else if (!quiet) {
        setTimelineStatus("error");
      }
    },
    [workspace.id, commit],
  );

  useEffect(() => {
    if (!openOrderId) {
      // Closed (the close button, Esc, the scrim, or the browser's back).
      pushedRef.current = false;
      return;
    }
    setDrawerOrderId(openOrderId);
    void loadDrawer(openOrderId, false);
    if (membersLoadedAt.current === 0) {
      void loadMembers();
    }
  }, [openOrderId, loadDrawer, loadMembers]);

  // A name we cannot resolve (someone joined since): refresh the list, at
  // most once a minute.
  useEffect(() => {
    // An entry the server already named (a platform admin who is not a
    // member) needs no refresh.
    const unknown = (desk.timeline?.events ?? []).some(
      (event) => event.actorId !== null && event.actorId !== userId && !members.has(event.actorId) && !event.actorName,
    );
    if (unknown && Date.now() - membersLoadedAt.current > MEMBERS_REFRESH_MS) {
      void loadMembers();
    }
  }, [desk.timeline, members, userId, loadMembers]);

  const handleEffects = useCallback(
    (effects: LiveEffects) => {
      // An order card folded into its request card: a drawer open on the old
      // card follows to the request card (same history, notes and POs).
      if (effects.merged && openRef.current === effects.merged.fromId) {
        const params = new URLSearchParams(window.location.search);
        params.set("order", effects.merged.toId);
        window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      }
      if (effects.refetch) {
        pendingAnnounce.current.push(...effects.announceOrderIds);
        pendingFlash.current.push(...effects.flashOrderIds);
        void reload();
      } else {
        flash(effects.flashOrderIds);
      }
      if (effects.reloadOpenOrder && openRef.current) {
        void loadDrawer(openRef.current, true);
      }
    },
    [reload, flash, loadDrawer],
  );

  const applyEvent = useCallback(
    (event: LiveEvent) => {
      const before = event.kind === "order.status" ? deskRef.current.orders.find((row) => row.id === event.order.id) : undefined;
      const { state, effects } = applyLiveEvent(deskRef.current, event, userId);
      if (state !== deskRef.current) {
        commit(state);
      }
      if (event.kind === "order.status") {
        setDetail((current) => withDetailStatus(current, event.order));
        const after = state.orders.find((row) => row.id === event.order.id);
        if (before && after && before.statusKey !== after.statusKey) {
          setViewCounts((current) => shiftViewCounts(current, before, before.statusKey, after.statusKey, closedRef.current));
        } else if (!before && crossesClosed(event.event.meta, closedRef.current)) {
          void reload();
        }
      }
      if (touchesPurchaseOrders(event, openRef.current)) {
        setPoRefresh((count) => count + 1);
      }
      handleEffects(effects);
    },
    [userId, commit, handleEffects, reload],
  );

  useEffect(
    () =>
      subscribe((message) => {
        if (message.type === "resync") {
          void reload();
          if (openRef.current) {
            void loadDrawer(openRef.current, true);
          }
        } else {
          applyEvent(message.event);
        }
      }),
    [subscribe, reload, loadDrawer, applyEvent],
  );

  const changeStatus = useCallback(
    async (orderId: string, nextKey: string) => {
      setRowErrors((current) => {
        if (!(orderId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[orderId];
        return next;
      });
      const before = deskRef.current.orders.find((row) => row.id === orderId);
      const optimistic = optimisticStatus(deskRef.current, orderId, nextKey);
      if (optimistic) {
        commit(optimistic.state);
        if (before) {
          setViewCounts((current) => shiftViewCounts(current, before, optimistic.previousKey, nextKey, closedRef.current));
        }
      }
      pendingStatus.current.set(orderId, nextKey);
      setSavingIds((current) => new Set(current).add(orderId));
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statusKey: nextKey }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          unchanged?: boolean;
          event?: EventView;
          order?: LiveOrderStatus;
          triggersPo?: boolean;
        } | null;
        if (!response.ok || !body) {
          // A rule the server refused (a request into a linked status, staff
          // reopening a rejected request) says why; anything else is generic.
          throw new StatusRefused(
            (response.status === 400 || response.status === 403) && body?.error ? body.error : "Not saved. Try again.",
          );
        }
        pendingStatus.current.delete(orderId);
        if (body.unchanged || !body.event || !body.order) {
          return;
        }
        applyEvent({ kind: "order.status", event: body.event, order: body.order });
        if (body.triggersPo) {
          // The status is saved either way. Managers review a purchase
          // order now (nothing is sent until they confirm it); staff are
          // told a manager will.
          if (canManagePos) {
            setPoModal({ orderId, po: null });
          } else {
            const label = statuses.find((status) => status.key === nextKey)?.label ?? "This status";
            toast({
              title: `${label} usually needs a purchase order`,
              body: "A manager creates and sends it from the order.",
              tone: "info",
            });
          }
        }
      } catch (e) {
        pendingStatus.current.delete(orderId);
        if (optimistic) {
          const rolled = rollbackStatus(deskRef.current, orderId, nextKey, optimistic.previousKey);
          if (rolled !== deskRef.current) {
            commit(rolled);
            if (before) {
              setViewCounts((current) => shiftViewCounts(current, before, nextKey, optimistic.previousKey, closedRef.current));
            }
          }
        }
        const message = e instanceof StatusRefused ? e.message : "Not saved. Try again.";
        setRowErrors((current) => ({ ...current, [orderId]: message }));
      } finally {
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(orderId);
          return next;
        });
      }
    },
    [commit, applyEvent, statuses, toast, canManagePos],
  );

  const addNote = useCallback(
    async (orderId: string, text: string): Promise<string | null> => {
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/note`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        const body = (await response.json().catch(() => null)) as { error?: string; event?: EventView } | null;
        if (!response.ok || !body?.event) {
          return body?.error ?? "The note was not saved. Try again.";
        }
        applyEvent({ kind: "order.note", event: body.event });
        return null;
      } catch {
        return "Could not reach the server. Your note is still here, so you can try again.";
      }
    },
    [applyEvent],
  );

  // Approve a request (draft orders spec section 9.1): the error to show
  // inline, or null. The server is idempotent, so a retry after a lost
  // answer never creates a second order. openPo false (Approve and next)
  // skips the purchase order review the status would open; the toast says
  // to create it from the order, which says PO not created until then.
  const approve = useCallback(
    async (orderId: string, opts: { openPo: boolean } = { openPo: true }): Promise<string | null> => {
      let response: Response;
      try {
        response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/approve`, { method: "POST" });
      } catch {
        return "Could not reach the server. Try again; an approval that already went through is never sent twice.";
      }
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        kind?: "approved" | "already-approved" | "completed-in-shopify";
        order?: LiveOrderStatus;
        orderName?: string;
        message?: string;
        events?: EventView[];
        triggersPo?: boolean;
      } | null;
      if (!response.ok || !body?.kind) {
        return body?.error ?? `Not approved (the server answered ${response.status}). Try again.`;
      }
      if (body.kind === "approved") {
        for (const event of body.events ?? []) {
          if (event.type === "status" && body.order) {
            applyEvent({ kind: "order.status", event, order: body.order });
          } else {
            applyEvent({ kind: "order.activity", event });
          }
        }
        const poLater = !opts.openPo && body.triggersPo === true && canManagePos;
        toast({ ...approvalNotice(body.orderName ?? "", poLater), tone: "good" });
        if (body.triggersPo && canManagePos && opts.openPo) {
          setPoModal({ orderId, po: null });
        }
      } else if (body.kind === "already-approved") {
        toast({ title: `Already approved. This request is order ${body.orderName ?? ""}.`, tone: "info" });
      } else {
        toast({ title: body.message ?? "This draft was already completed in Shopify.", tone: "info" });
      }
      void reload();
      refreshQueue();
      if (openRef.current === orderId) {
        void loadDrawer(orderId, true);
      }
      return null;
    },
    [applyEvent, toast, canManagePos, reload, refreshQueue, loadDrawer],
  );

  // Reject a request with its reason (draft orders spec section 9.2).
  const reject = useCallback(
    async (orderId: string, reason: string): Promise<string | null> => {
      let response: Response;
      try {
        response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
      } catch {
        return "Could not reach the server. Your reason is still here, so you can try again.";
      }
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        kind?: "rejected" | "unchanged";
        order?: LiveOrderStatus;
        events?: EventView[];
      } | null;
      if (!response.ok || !body?.kind) {
        return body?.error ?? `Not rejected (the server answered ${response.status}). Try again.`;
      }
      if (body.kind === "rejected") {
        for (const event of body.events ?? []) {
          if (event.type === "status" && body.order) {
            applyEvent({ kind: "order.status", event, order: body.order });
          } else {
            applyEvent({ kind: "order.note", event });
          }
        }
        toast({ title: "Rejected. The reason is saved as a note.", tone: "good" });
        refreshQueue();
      } else {
        toast({ title: "This request was already rejected.", tone: "info" });
      }
      return null;
    },
    [applyEvent, toast, refreshQueue],
  );

  // Approve and next (comprehensive desk design section 1): approve, then
  // open the next waiting request in place of this one (no extra history
  // entry, so Back still closes the drawer).
  const approveAndNext = useCallback(
    async (orderId: string, nextId: string): Promise<string | null> => {
      const failure = await approve(orderId, { openPo: false });
      if (failure) {
        return failure;
      }
      const params = new URLSearchParams(window.location.search);
      params.set("order", nextId);
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      return null;
    },
    [approve],
  );

  // Opening pushes a history entry so the browser's back closes the drawer;
  // a deep link (?order=) is closed by replacing the entry instead.
  const openOrder = useCallback((orderId: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("order", orderId);
    window.history.pushState(null, "", `${window.location.pathname}?${params.toString()}`);
    pushedRef.current = true;
  }, []);

  const closeOrder = useCallback(() => {
    if (pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.delete("order");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
  }, []);

  useEffect(() => {
    setBannerHidden(bannerDismissed(workspace.id));
  }, [workspace.id]);

  // The Deleted filter goes away with the last deleted request (counted
  // once the desk has loaded, src/lib/desk-state.ts).
  const loaded = load.status === "ready";
  useEffect(() => {
    if (dropsDeletedFilter({ kind: deskQuery.kind, deletedCount: drafts.deletedDraftCount, loaded })) {
      updateDeskQuery({ kind: "all" });
    }
  }, [deskQuery.kind, drafts.deletedDraftCount, loaded, updateDeskQuery]);

  const showKindFilter = drafts.enabled || drafts.draftCount > 0 || drafts.deletedDraftCount > 0;
  const showBanner =
    role === "platform" && !drafts.enabled && drafts.missingScopes.length > 0 && !bannerHidden && load.status === "ready";
  const chips = useMemo(() => statusChips(statuses, desk.statusCounts), [statuses, desk.statusCounts]);
  const visible = useMemo(
    () => selectOrders(desk.orders, view === "approval" ? { ...filter, kind: "all" } : filter, closedKeys),
    [desk.orders, filter, view, closedKeys],
  );
  const viewChips = useMemo(() => chipsForView(chips, view, closedKeys), [chips, view, closedKeys]);
  // Drafts and Deleted counts for what this view holds.
  const kindCounts = useMemo(
    () => deskKindCounts(desk.orders.filter((row) => viewMatches(row, view === "approval" ? "open" : view, closedKeys))),
    [desk.orders, view, closedKeys],
  );
  const total = totalOrders(desk.statusCounts);
  const drawerSummary = drawerOrderId ? desk.orders.find((order) => order.id === drawerOrderId) : undefined;
  const nextRequest = drawerOrderId ? nextWaitingRequest(visible, drawerOrderId, closedKeys) : null;
  const drawerTimeline =
    drawerOrderId && desk.timeline?.orderId === drawerOrderId ? desk.timeline.events : [];

  const showToolbar = load.status === "ready" && !(total === 0 && desk.orders.length === 0);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-4 sm:px-6 sm:py-5">
      {/* Phones: one sticky bar under the 56px top bar (z-20, below the
          top bar's z-30 and the drawer's z-40), on the page background so
          cards scroll under it. From 880px it is an ordinary row. */}
      <div className="flex flex-col gap-2 max-desk:sticky max-desk:top-14 max-desk:z-20 max-desk:-mx-4 max-desk:bg-bg max-desk:px-4 max-desk:py-2 desk:min-h-12 desk:flex-row desk:items-center desk:gap-4">
        <h1
          id="desk-heading"
          tabIndex={-1}
          className="sr-only font-display text-xl font-semibold tracking-tight focus:outline-none desk:not-sr-only desk:shrink-0"
        >
          Orders
        </h1>
        {showToolbar ? (
          <Toolbar
            layout={isDesk ? "row" : "phone"}
            view={view}
            onView={(next) => updateDeskQuery({ view: next, status: null })}
            viewCounts={viewCounts}
            showApproval={roleAtLeast(role, "manager")}
            statusKey={filter.statusKey}
            onStatus={(statusKey) => updateDeskQuery({ status: statusKey })}
            statusChips={viewChips}
            query={filter.query}
            onQuery={(query) => updateDeskQuery({ q: query })}
            sort={filter.sort}
            onSort={(sort) => updateDeskQuery({ sort })}
            kindFilter={
              showKindFilter && view !== "approval"
                ? {
                    kind: filter.kind ?? "all",
                    onKind: (kind: DeskKind) => updateDeskQuery({ kind }),
                    draftCount: kindCounts.drafts,
                    deletedCount: kindCounts.deleted,
                  }
                : null
            }
            shown={visible.length}
          />
        ) : null}
      </div>

      {showBanner ? (
        <DraftsBanner
          settingsHref={`${workspace.basePath}/settings#store`}
          onDismiss={() => {
            dismissBanner(workspace.id);
            setBannerHidden(true);
          }}
        />
      ) : null}

      {load.status === "loading" ? <DeskSkeleton /> : null}

      {load.status === "error" ? (
        <DeskLoadError
          message={load.message}
          onRetry={() => {
            setLoad({ status: "loading" });
            void reload();
          }}
        />
      ) : null}

      {load.status === "ready" ? (
        total === 0 && desk.orders.length === 0 ? (
          <EmptyDesk basePath={workspace.basePath} canConnect={roleAtLeast(role, "platform")} />
        ) : (
          <>
            {visible.length === 0 ? (
              <NoMatches
                view={view}
                query={filter.query}
                kind={filter.kind ?? "all"}
                statusLabel={
                  filter.statusKey === null
                    ? null
                    : (chips.find((chip) => chip.key === filter.statusKey)?.label ?? "this status")
                }
                onClear={() => updateDeskQuery({ q: "", status: null, kind: "all" })}
              />
            ) : (
              <div aria-busy={switching || undefined} className={switching ? "opacity-60 transition-opacity" : undefined}>
                <OrderList
                  layout={isDesk ? "table" : "cards"}
                  orders={visible}
                  statuses={statuses}
                  role={role}
                  flashing={flashing}
                  rowErrors={rowErrors}
                  savingIds={savingIds}
                  now={now}
                  onOpen={openOrder}
                  onChangeStatus={changeStatus}
                  ageRule={{ amberDays: queue.ageAmberDays, redDays: queue.ageRedDays }}
                  closedKeys={closedKeys}
                />
              </div>
            )}
            {hasMore ? (
              <p className="text-xs text-ink-2">
                Showing the newest 1,000 orders. Older orders are still in Shopify, and the counts above include them.
              </p>
            ) : null}
          </>
        )
      ) : null}

      <DrawerShell open={openOrderId !== null} onClose={closeOrder} labelledBy={DRAWER_TITLE_ID}>
        {drawerOrderId ? (
          <OrderDrawerContent
            labelId={DRAWER_TITLE_ID}
            orderId={drawerOrderId}
            summary={drawerSummary}
            detail={detail}
            timeline={drawerTimeline}
            timelineStatus={timelineStatus}
            statuses={statuses}
            rowError={rowErrors[drawerOrderId]}
            statusBusy={savingIds.has(drawerOrderId)}
            members={members}
            selfUserId={userId}
            role={role}
            shopDomain={connection?.adminShopDomain ?? null}
            drafts={{ draftsEnabled: drafts.enabled }}
            onChangeStatus={(statusKey) => void changeStatus(drawerOrderId, statusKey)}
            onAddNote={(text) => addNote(drawerOrderId, text)}
            onApprove={() => approve(drawerOrderId)}
            onReject={(reason) => reject(drawerOrderId, reason)}
            nextRequest={nextRequest}
            onApproveAndNext={nextRequest ? () => approveAndNext(drawerOrderId, nextRequest.id) : undefined}
            onClose={closeOrder}
            onRetry={() => void loadDrawer(drawerOrderId, false)}
            canManagePos={canManagePos}
            poRefreshKey={poRefresh}
            onCreatePo={() => setPoModal({ orderId: drawerOrderId, po: null })}
            onEditPo={(po) => setPoModal({ orderId: drawerOrderId, po })}
          />
        ) : null}
      </DrawerShell>

      {poModal && canManagePos ? (
        <PoModal
          key={`${poModal.orderId}-${poModal.po?.id ?? "new"}`}
          workspaceId={workspace.id}
          orderId={poModal.orderId}
          po={poModal.po}
          onClose={() => setPoModal(null)}
          onSaved={() => {
            setPoRefresh((count) => count + 1);
            commit(withPurchaseOrder(deskRef.current, poModal.orderId));
          }}
          onSent={(po) => {
            setPoRefresh((count) => count + 1);
            commit(withPurchaseOrder(deskRef.current, poModal.orderId));
            toast({
              title: `Purchase order ${po.number ?? ""} sent`,
              body: po.vendor ? `To ${po.vendor.name}` : undefined,
              tone: "good",
            });
          }}
        />
      ) : null}
    </main>
  );
}
