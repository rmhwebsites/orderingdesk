"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  applyLiveEvent,
  optimisticStatus,
  rollbackStatus,
  selectOrders,
  statusChips,
  totalOrders,
  type DeskFilter,
  type DeskState,
  type LiveEffects,
} from "@/lib/desk-state";
import { formatMoney } from "@/lib/format";
import { roleAtLeast } from "@/lib/roles";
import type { LiveEvent, LiveOrderStatus } from "@/lib/live-events";
import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
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
import { OrderCards, OrderTable } from "./order-list";
import { StatusStrip } from "./status-strip";
import { Toolbar } from "./toolbar";

type DeskPayload = {
  statuses: StatusView[];
  statusCounts: Record<string, number>;
  orders: OrderSummary[];
  hasMore: boolean;
};

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

const FLASH_MS = 1800;
const MEMBERS_REFRESH_MS = 60000;
const DRAWER_TITLE_ID = "order-drawer-title";

function announcement(orders: OrderSummary[]): { title: string; body?: string } {
  if (orders.length === 1) {
    const [order] = orders;
    const who = order.customerName ? ` from ${order.customerName}` : "";
    return { title: `New order ${order.name}${who}`, body: formatMoney(order.total, order.currency) || undefined };
  }
  const names = orders.slice(0, 3).map((order) => order.name);
  const rest = orders.length - names.length;
  return {
    title: `${orders.length} new orders`,
    body: rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", "),
  };
}

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
  const { workspace, userId, role, connection, subscribe } = useWorkspace();
  const toast = useToast();
  const searchParams = useSearchParams();
  const openOrderId = searchParams.get("order");

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [statuses, setStatuses] = useState<StatusView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [desk, setDesk] = useState<DeskState>({ orders: [], statusCounts: {}, timeline: null });
  const deskRef = useRef(desk);
  const [filter, setFilter] = useState<DeskFilter>({ query: "", statusKey: null, sort: "newest" });
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
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/orders`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The server answered ${response.status}.`);
      }
      const payload = (await response.json()) as DeskPayload;
      let next: DeskState = { ...deskRef.current, orders: payload.orders, statusCounts: payload.statusCounts };
      for (const [orderId, key] of pendingStatus.current) {
        next = optimisticStatus(next, orderId, key)?.state ?? next;
      }
      commit(next);
      setStatuses(payload.statuses);
      setHasMore(payload.hasMore);
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
            ? { ...announcement(found), tone: "good" }
            : { title: `${toAnnounce.length} new ${toAnnounce.length === 1 ? "order" : "orders"}`, tone: "good" },
        );
      }
      flash(pendingFlash.current.filter((id) => loadedIds.has(id)));
      pendingFlash.current = [];
    } catch (e) {
      const message = e instanceof Error ? e.message : "Check your connection and try again.";
      // A failed refresh keeps what is on screen; only a first load fails.
      setLoad((current) => (current.status === "ready" ? current : { status: "error", message }));
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
    const unknown = (desk.timeline?.events ?? []).some(
      (event) => event.actorId !== null && event.actorId !== userId && !members.has(event.actorId),
    );
    if (unknown && Date.now() - membersLoadedAt.current > MEMBERS_REFRESH_MS) {
      void loadMembers();
    }
  }, [desk.timeline, members, userId, loadMembers]);

  const handleEffects = useCallback(
    (effects: LiveEffects) => {
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
      const { state, effects } = applyLiveEvent(deskRef.current, event, userId);
      if (state !== deskRef.current) {
        commit(state);
      }
      if (event.kind === "order.status") {
        setDetail((current) => withDetailStatus(current, event.order));
      }
      handleEffects(effects);
    },
    [userId, commit, handleEffects],
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
      const optimistic = optimisticStatus(deskRef.current, orderId, nextKey);
      if (optimistic) {
        commit(optimistic.state);
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
          throw new Error(body?.error ?? "Not saved");
        }
        pendingStatus.current.delete(orderId);
        if (body.unchanged || !body.event || !body.order) {
          return;
        }
        applyEvent({ kind: "order.status", event: body.event, order: body.order });
        if (body.triggersPo) {
          // Phase 7 replaces this with the purchase order review modal.
          const label = statuses.find((status) => status.key === nextKey)?.label ?? "This status";
          toast({
            title: "Purchase orders are coming soon",
            body: `${label} will open a purchase order here once that feature ships. The status change is saved.`,
            tone: "info",
          });
        }
      } catch {
        pendingStatus.current.delete(orderId);
        if (optimistic) {
          commit(rollbackStatus(deskRef.current, orderId, nextKey, optimistic.previousKey));
        }
        setRowErrors((current) => ({ ...current, [orderId]: "Not saved. Try again." }));
      } finally {
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(orderId);
          return next;
        });
      }
    },
    [commit, applyEvent, statuses, toast],
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

  const chips = useMemo(() => statusChips(statuses, desk.statusCounts), [statuses, desk.statusCounts]);
  const visible = useMemo(() => selectOrders(desk.orders, filter), [desk.orders, filter]);
  const total = totalOrders(desk.statusCounts);
  const drawerSummary = drawerOrderId ? desk.orders.find((order) => order.id === drawerOrderId) : undefined;
  const drawerTimeline =
    drawerOrderId && desk.timeline?.orderId === drawerOrderId ? desk.timeline.events : [];

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <h1 id="desk-heading" tabIndex={-1} className="font-display text-2xl font-semibold tracking-tight focus:outline-none">
        Orders
      </h1>

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
            <StatusStrip
              chips={chips}
              total={total}
              active={filter.statusKey}
              onSelect={(statusKey) => setFilter((current) => ({ ...current, statusKey }))}
            />
            <Toolbar
              query={filter.query}
              onQuery={(query) => setFilter((current) => ({ ...current, query }))}
              sort={filter.sort}
              onSort={(sort) => setFilter((current) => ({ ...current, sort }))}
              shown={visible.length}
              loaded={desk.orders.length}
            />
            {visible.length === 0 ? (
              <NoMatches
                query={filter.query}
                onClear={() => setFilter((current) => ({ ...current, query: "", statusKey: null }))}
              />
            ) : (
              <>
                <OrderTable
                  orders={visible}
                  statuses={statuses}
                  flashing={flashing}
                  rowErrors={rowErrors}
                  savingIds={savingIds}
                  onOpen={openOrder}
                  onChangeStatus={changeStatus}
                />
                <OrderCards
                  orders={visible}
                  statuses={statuses}
                  flashing={flashing}
                  rowErrors={rowErrors}
                  savingIds={savingIds}
                  onOpen={openOrder}
                  onChangeStatus={changeStatus}
                />
              </>
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
            summary={drawerSummary}
            detail={detail}
            timeline={drawerTimeline}
            timelineStatus={timelineStatus}
            statuses={statuses}
            rowError={rowErrors[drawerOrderId]}
            statusBusy={savingIds.has(drawerOrderId)}
            members={members}
            selfUserId={userId}
            shopDomain={connection?.shopDomain ?? null}
            onChangeStatus={(statusKey) => void changeStatus(drawerOrderId, statusKey)}
            onAddNote={(text) => addNote(drawerOrderId, text)}
            onClose={closeOrder}
            onRetry={() => void loadDrawer(drawerOrderId, false)}
          />
        ) : null}
      </DrawerShell>
    </main>
  );
}
