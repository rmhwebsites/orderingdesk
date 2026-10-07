"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { XIcon } from "@phosphor-icons/react/X";
import {
  DESK_QUERY_MAX,
  SEARCH_DEFAULTS,
  deskParams,
  filterChips,
  listScope,
  parseDeskQuery,
  querySortDefault,
  reloadLimit,
  understoodChips,
  type DeskQuery,
  type DeskView,
  type ViewCounts,
} from "@/lib/desk-query";
import {
  applyLiveEvent,
  approvalNotice,
  arrivalNotice,
  chipsForView,
  crossesClosed,
  dropsDeletedFilter,
  listFilter,
  nextWaitingRequest,
  optimisticStatus,
  rollbackStatus,
  selectOrders,
  shiftViewCounts,
  statusChips,
  totalOrders,
  touchesPurchaseOrders,
  viewLoadState,
  withPurchaseOrder,
  type DeskFilter,
  type DeskKind,
  type DeskState,
  type LiveEffects,
} from "@/lib/desk-state";
import { DEFAULT_QUEUE_SETTINGS, pricesShown, type QueueSettingsView } from "@/lib/queue-settings";
import { roleAtLeast } from "@/lib/roles";
import { shouldAskAi } from "@/lib/search-shortcut";
import type { EditRequestBody, RequestEditor } from "@/lib/request-edit";
import { selectAll, toggleSelection, type Selection } from "@/lib/selection";
import { BULK_STATUS_MAX, type BulkCard } from "@/lib/status-rules";
import { DESK_MEDIA, useMediaQuery } from "@/lib/use-media-query";
import { useNow } from "@/lib/use-now";
import type { LiveEvent, LiveOrderStatus } from "@/lib/live-events";
import type { OrderSummary } from "@/server/desk/read";
import type { EventView, StatusView } from "@/server/desk/shapes";
import type { PoView } from "@/server/po/service";
import { useWorkspace } from "@/components/shell/workspace-provider";
import { useToast } from "@/components/toasts";
import { BulkBar, type BulkResult } from "./bulk-bar";
import { DeskSkeleton } from "./desk-skeleton";
import type { EditSaveOutcome } from "./edit-request";
import { DeskLoadError, EmptyDesk, NoMatches } from "./empty-states";
import { aiFallbackNotice, FilterChips } from "./filter-chips";
import { LoadMore } from "./load-more";
import {
  DrawerShell,
  OrderDrawerContent,
  type DrawerDetail,
  type DrawerOrder,
  type MemberView,
} from "./order-drawer";
import { OrderList } from "./order-list";
import { PoModal } from "./po-modal";
import type { ShipToLocation } from "./request-parts";
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
  nextCursor: string | null;
  matchCount: number;
  searchReady: boolean;
  locations: { id: string; name: string }[];
  aiSearch: boolean;
  requester: { id: string; name: string } | null;
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

// AI search for the question last submitted (design section 3): asking,
// understood (the answer replaced the query; answer is that query and
// fromView the view the person was on, null once they pick a view) or a
// fallback (the keyword results stand).
type AiState =
  | { status: "idle" }
  | { status: "asking"; q: string }
  | { status: "understood"; q: string; answer: DeskQuery; fromView: DeskView | null }
  | { status: "fallback"; q: string; reason: string };
const AI_IDLE: AiState = { status: "idle" };

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
  const [desk, setDesk] = useState<DeskState>({ orders: [], statusCounts: {}, timeline: null });
  const deskRef = useRef(desk);
  // The view and filters live in the address (use-desk-filter.ts); the
  // server searches with all of them (src/server/search/query.ts).
  const [deskQuery, updateDeskQuery, searchText] = useDeskFilter();
  const queryKey = useMemo(() => deskParams(deskQuery).toString(), [deskQuery]);
  const queryKeyRef = useRef(queryKey);
  // How many cards are loaded for the current query (a reload keeps them).
  const depthRef = useRef(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [matchCount, setMatchCount] = useState(0);
  const [searchReady, setSearchReady] = useState(true);
  const [aiSearch, setAiSearch] = useState(false);
  const [vocab, setVocab] = useState<{ locations: { id: string; name: string }[]; requester: { id: string; name: string } | null }>({
    locations: [],
    requester: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped when the desk rewrites the words itself, so the search box shows them.
  const [searchReset, setSearchReset] = useState(0);
  const [ai, setAi] = useState<AiState>(AI_IDLE);
  // The question waiting for an answer ("" when none): a late answer to an
  // abandoned question is dropped.
  const asked = useRef("");
  // The view the person was on when an AI answer replaced the query (its
  // own view): clearing the search goes back to it, as clearing typed
  // words does (owner decision). A view the person picks afterwards wins.
  const viewBeforeAi = useRef<DeskView | null>(null);

  useEffect(() => {
    queryKeyRef.current = queryKey;
  }, [queryKey]);

  // The list filters only view, kind and status (src/lib/desk-state.ts):
  // words search every card whatever the view (listScope).
  const filter = useMemo<DeskFilter>(() => ({ statusKey: deskQuery.status, ...listScope(deskQuery) }), [deskQuery]);
  const view: DeskView = deskQuery.view;
  const [viewCounts, setViewCounts] = useState<ViewCounts>({ open: 0, approval: 0, all: 0, closed: 0 });
  const [queue, setQueue] = useState<QueueSettingsView>(DEFAULT_QUEUE_SETTINGS);
  // The query whose cards the desk holds, and the last query whose load
  // failed (query keys, deskParams). While the address asks for another
  // query the list keeps the loaded cards, dimmed, until the new ones land.
  const [loadedKey, setLoadedKey] = useState(queryKey);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const loadedQuery: DeskQuery = useMemo(() => parseDeskQuery(new URLSearchParams(loadedKey)), [loadedKey]);
  const loadedView = listScope(loadedQuery).view;
  const viewState = viewLoadState(queryKey, loadedKey, failedKey);
  const switching = viewState === "loading";
  const closedRef = useRef<ReadonlySet<string>>(new Set());
  const rejectedRef = useRef<ReadonlySet<string>>(new Set());
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

  // Bulk selection (comprehensive desk design section 1).
  const [selection, setSelection] = useState<Selection>({ selected: new Set(), anchor: null });
  const selectionRef = useRef(selection);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  const replaceSelection = useCallback((next: Selection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  // A different filter shows different cards: start the selection over.
  useEffect(() => {
    replaceSelection({ selected: new Set(), anchor: null });
  }, [queryKey, replaceSelection]);

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

  // The current query at the loaded depth. A response for a query that
  // changed meanwhile is dropped and the new one fetched.
  const fetchDesk = useCallback(async () => {
    const key = queryKeyRef.current;
    try {
      const params = new URLSearchParams(key);
      params.set("limit", String(reloadLimit(depthRef.current)));
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/orders?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The server answered ${response.status}.`);
      }
      const payload = (await response.json()) as DeskPayload;
      if (key !== queryKeyRef.current) {
        reloadAgain.current = true;
        return;
      }
      depthRef.current = payload.orders.length;
      setNextCursor(payload.nextCursor);
      setMatchCount(payload.matchCount);
      setSearchReady(payload.searchReady);
      setAiSearch(payload.aiSearch);
      setVocab({ locations: payload.locations, requester: payload.requester });
      let next: DeskState = { ...deskRef.current, orders: payload.orders, statusCounts: payload.statusCounts };
      for (const [orderId, key] of pendingStatus.current) {
        next = optimisticStatus(next, orderId, key)?.state ?? next;
      }
      commit(next);
      setStatuses(payload.statuses);
      setViewCounts(payload.viewCounts);
      setQueue(payload.queue);
      setLoadedKey(key);
      setFailedKey(null);
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
      setFailedKey(key);
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

  // Every query loads from its first page (the list stays, dimmed, until
  // it lands); this is also the first load.
  useEffect(() => {
    depthRef.current = 0;
    void reload();
  }, [queryKey, reload]);

  // Older cards for the loaded query, one page at a time.
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) {
      return;
    }
    const key = queryKeyRef.current;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams(key);
      params.set("cursor", nextCursor);
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/orders?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const payload = (await response.json()) as DeskPayload;
      if (key !== queryKeyRef.current) {
        return;
      }
      const known = new Set(deskRef.current.orders.map((order) => order.id));
      const orders = [...deskRef.current.orders, ...payload.orders.filter((order) => !known.has(order.id))];
      commit({ ...deskRef.current, orders });
      depthRef.current = orders.length;
      setNextCursor(payload.nextCursor);
    } catch {
      toast({ title: "Older cards did not load. Try again.", tone: "warn" });
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, workspace.id, commit, toast]);

  // Typing writes the words after a short pause; Enter, the clear button
  // and Clear filters write them at once and show them in the box.
  // writtenQ is what the desk last wrote, so words that change in the
  // address from outside (a link, Back) reach the box too.
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writtenQ = useRef(searchText);
  const stopTyping = useCallback(() => {
    if (typing.current) {
      clearTimeout(typing.current);
      typing.current = null;
    }
  }, []);
  useEffect(() => stopTyping, [stopTyping]);
  const writeWords = useCallback(
    (text: string) => {
      const q = text.slice(0, DESK_QUERY_MAX);
      writtenQ.current = q;
      updateDeskQuery({ q });
    },
    [updateDeskQuery],
  );
  const onQueryText = useCallback(
    (text: string) => {
      stopTyping();
      asked.current = "";
      setAi((current) => (current.status === "idle" ? current : AI_IDLE));
      typing.current = setTimeout(() => {
        typing.current = null;
        writeWords(text);
      }, 250);
    },
    [stopTyping, writeWords],
  );
  // Enter: keyword results at once, then a question of three words or
  // more goes to AI search (when the workspace has it on). Its answer
  // replaces the whole query (its own view, never q, the open drawer
  // stays) and shows as removable chips; any fallback keeps the keyword
  // results.
  const onSearchSubmit = useCallback(
    async (text: string) => {
      stopTyping();
      writeWords(text);
      setSearchReset((count) => count + 1);
      const q = text.trim().slice(0, DESK_QUERY_MAX);
      asked.current = "";
      if (!aiSearch || !shouldAskAi(q)) {
        setAi(AI_IDLE);
        return;
      }
      const fromView = parseDeskQuery(new URLSearchParams(window.location.search)).view;
      asked.current = q;
      setAi({ status: "asking", q });
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/search/ai`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q }),
        });
        const body = (await response.json().catch(() => null)) as { params?: string; fallback?: string } | null;
        if (asked.current !== q) {
          return; // a newer search replaced this one
        }
        asked.current = "";
        if (response.ok && typeof body?.params === "string") {
          if (viewBeforeAi.current === null) {
            viewBeforeAi.current = fromView;
          }
          writtenQ.current = "";
          const answer = parseDeskQuery(new URLSearchParams(body.params));
          updateDeskQuery(answer);
          setSearchReset((count) => count + 1);
          setAi({ status: "understood", q, answer, fromView: viewBeforeAi.current });
        } else {
          setAi({ status: "fallback", q, reason: body?.fallback ?? "error" });
        }
      } catch {
        if (asked.current === q) {
          asked.current = "";
          setAi({ status: "fallback", q, reason: "error" });
        }
      }
    },
    [stopTyping, writeWords, aiSearch, workspace.id, updateDeskQuery],
  );
  const clearFilters = useCallback(() => {
    stopTyping();
    asked.current = "";
    setAi(AI_IDLE);
    writtenQ.current = "";
    const view = viewBeforeAi.current;
    viewBeforeAi.current = null;
    updateDeskQuery({ ...SEARCH_DEFAULTS, q: "", status: null, kind: "all", ...(view ? { view } : {}) });
    setSearchReset((count) => count + 1);
  }, [stopTyping, updateDeskQuery]);
  useEffect(() => {
    if (searchText !== writtenQ.current) {
      writtenQ.current = searchText;
      setSearchReset((count) => count + 1);
    }
  }, [searchText]);

  const closedKeys = useMemo(
    () => new Set(statuses.filter((status) => status.closed).map((status) => status.key)),
    [statuses],
  );
  // The status linked to draft_rejected: its requests never wait for
  // approval, closed or not (src/lib/desk-state.ts viewMatches).
  const rejectedKeys = useMemo(
    () => new Set(statuses.filter((status) => status.shopifyLink === "draft_rejected").map((status) => status.key)),
    [statuses],
  );
  useEffect(() => {
    closedRef.current = closedKeys;
    rejectedRef.current = rejectedKeys;
  }, [closedKeys, rejectedKeys]);

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
        const body = (await detailResult.value.json()) as {
          order: DrawerOrder;
          itemsTruncated: boolean;
          location?: ShipToLocation | null;
        };
        setDetail({ status: "ready", order: body.order, itemsTruncated: body.itemsTruncated, location: body.location ?? null });
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
          setViewCounts((current) =>
            shiftViewCounts(current, before, before.statusKey, after.statusKey, closedRef.current, rejectedRef.current),
          );
        } else if (!before && crossesClosed(event.event.meta, closedRef.current, rejectedRef.current)) {
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
          setViewCounts((current) =>
            shiftViewCounts(current, before, optimistic.previousKey, nextKey, closedRef.current, rejectedRef.current),
          );
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
              setViewCounts((current) =>
                shiftViewCounts(current, before, nextKey, optimistic.previousKey, closedRef.current, rejectedRef.current),
              );
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

  // Edit a request before approval (comprehensive design section 2). A 409
  // that carries the fresh editor reloads it in place.
  const editRequestAction = useCallback(
    async (orderId: string, body: EditRequestBody): Promise<EditSaveOutcome> => {
      let response: Response;
      try {
        response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        return { error: "Could not reach the server. Your changes are still here; check the request before saving again." };
      }
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        editor?: RequestEditor;
        kind?: "edited" | "unchanged";
        event?: EventView;
        warning?: string | null;
      } | null;
      if (!response.ok || !result?.kind) {
        return {
          error: result?.error ?? `Not saved (the server answered ${response.status}). Try again.`,
          ...(result?.editor ? { editor: result.editor } : {}),
        };
      }
      if (result.kind === "edited" && result.event) {
        applyEvent({ kind: "order.activity", event: result.event });
        toast({ title: "Request updated in Shopify.", tone: "good" });
      } else {
        toast({ title: "Nothing changed on this request.", tone: "info" });
      }
      void reload();
      if (openRef.current === orderId) {
        void loadDrawer(orderId, true);
      }
      return { warning: result.warning ?? null };
    },
    [applyEvent, toast, reload, loadDrawer],
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

  // Cancel an order after approval (comprehensive design section 2): the
  // error to show inline, or null. The server reads Shopify first, so a
  // retry after a lost answer never sends a second cancel.
  const cancelOrderAction = useCallback(
    async (orderId: string, reason: string): Promise<string | null> => {
      let response: Response;
      try {
        response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
      } catch {
        return "Could not reach the server. Check the order before trying again; a cancel that went through is never sent twice.";
      }
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        kind?: "cancelled" | "already-cancelled" | "cancelled-in-shopify";
        order?: LiveOrderStatus;
        events?: EventView[];
        confirmed?: boolean;
        message?: string;
      } | null;
      if (!response.ok || !body?.kind) {
        return body?.error ?? `Not cancelled (the server answered ${response.status}). Try again.`;
      }
      if (body.kind === "cancelled") {
        for (const event of body.events ?? []) {
          if (event.type === "status" && body.order) {
            applyEvent({ kind: "order.status", event, order: body.order });
          } else if (event.type === "note") {
            applyEvent({ kind: "order.note", event });
          } else {
            applyEvent({ kind: "order.activity", event });
          }
        }
        toast({
          title: body.confirmed
            ? "Cancelled in Shopify. No email, restock or refund."
            : "Shopify is finishing the cancellation. No email, restock or refund.",
          tone: "good",
        });
      } else if (body.kind === "already-cancelled") {
        toast({ title: "This order is already cancelled.", tone: "info" });
      } else {
        toast({ title: body.message ?? "This order was already cancelled in Shopify.", tone: "info" });
      }
      void reload();
      if (openRef.current === orderId) {
        void loadDrawer(orderId, true);
      }
      return null;
    },
    [applyEvent, toast, reload, loadDrawer],
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
  // The list filters by the loaded view (src/lib/desk-state.ts listFilter):
  // the toolbar follows the address, the cards follow what has landed.
  const visible = useMemo(
    () => selectOrders(desk.orders, listFilter(filter, loadedView), closedKeys, rejectedKeys),
    [desk.orders, filter, loadedView, closedKeys, rejectedKeys],
  );
  // Totals and the Paid chip (the workspace's Show prices setting).
  const showPrices = useMemo(
    () => pricesShown(queue.priceDisplay, desk.orders.map((row) => row.total)),
    [queue.priceDisplay, desk.orders],
  );
  const visibleIds = useMemo(() => visible.map((row) => row.id), [visible]);
  const selectedCards: BulkCard[] = useMemo(
    () =>
      visible
        .filter((row) => selection.selected.has(row.id))
        .map((row) => ({ id: row.id, name: row.name, customerName: row.customerName, kind: row.kind, statusKey: row.statusKey })),
    [visible, selection],
  );

  const capNotice = useCallback(() => {
    toast({ title: `Up to ${BULK_STATUS_MAX} cards at a time`, body: "Move these, then pick the rest.", tone: "info" });
  }, [toast]);

  const toggleCard = useCallback(
    (orderId: string, range: boolean) => {
      const next = toggleSelection(selectionRef.current, visibleIds, orderId, { range, max: BULK_STATUS_MAX });
      replaceSelection({ selected: next.selected, anchor: next.anchor });
      if (next.capped) {
        capNotice();
      }
    },
    [visibleIds, replaceSelection, capNotice],
  );

  const toggleAll = useCallback(() => {
    const everyShown = visibleIds.length > 0 && visibleIds.every((id) => selectionRef.current.selected.has(id));
    if (everyShown) {
      replaceSelection({ selected: new Set(), anchor: null });
      return;
    }
    const next = selectAll(visibleIds, BULK_STATUS_MAX);
    replaceSelection({ selected: next.selected, anchor: null });
    if (next.capped) {
      capNotice();
    }
  }, [visibleIds, replaceSelection, capNotice]);

  const moveSelected = useCallback(
    async (statusKey: string) => {
      const ids = visibleIds.filter((id) => selectionRef.current.selected.has(id));
      setBulkBusy(true);
      setBulkResult(null);
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/orders/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderIds: ids, statusKey }),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          statusLabel?: string;
          results?: { orderId: string; name: string | null; outcome: string; error?: string }[];
          changed?: { event: EventView; order: LiveOrderStatus }[];
          triggersPo?: boolean;
        } | null;
        if (!response.ok || !body?.results || !body.changed) {
          setBulkResult({ tone: "warn", text: body?.error ?? "Nothing moved. Try again.", refusals: [] });
          return;
        }
        for (const change of body.changed) {
          applyEvent({ kind: "order.status", event: change.event, order: change.order });
        }
        const moved = body.results.filter((row) => row.outcome === "changed").length;
        const refusals = body.results
          .filter((row) => row.outcome === "refused" || row.outcome === "not-found")
          .map((row) => ({ name: row.name, error: row.error ?? "It is no longer in this workspace." }));
        setBulkResult({
          tone: refusals.length > 0 ? "warn" : "good",
          text: `Moved ${moved} ${moved === 1 ? "card" : "cards"} to ${body.statusLabel ?? "the status"}.`,
          refusals,
        });
        replaceSelection({ selected: new Set(), anchor: null });
        if (body.triggersPo) {
          toast({
            title: `${body.statusLabel ?? "This status"} usually needs a purchase order`,
            body: canManagePos ? "Create one from each order." : "A manager creates them from each order.",
            tone: "info",
          });
        }
        refreshQueue();
      } catch {
        setBulkResult({
          tone: "warn",
          text: "Could not reach the server, so it is not known what moved. Check the cards; moving them again is safe.",
          refusals: [],
        });
      } finally {
        setBulkBusy(false);
      }
    },
    [visibleIds, workspace.id, applyEvent, replaceSelection, toast, canManagePos, refreshQueue],
  );

  const viewChips = useMemo(() => chipsForView(chips, view, closedKeys), [chips, view, closedKeys]);
  // The search filters with no control of their own (the status filter
  // has its own chips above), each removable.
  const searchChips = useMemo(
    () => filterChips(deskQuery, { locations: vocab.locations, requesterName: vocab.requester?.name ?? null }),
    [deskQuery, vocab],
  );
  // While an AI answer holds, the view, kind, status and sort it set are
  // chips too (every part of the understanding is one), in front.
  const activeChips = useMemo(
    () => (ai.status === "understood" ? [...understoodChips(ai.answer, deskQuery, ai.fromView, statuses), ...searchChips] : searchChips),
    [ai, deskQuery, statuses, searchChips],
  );
  // An answer holds while some part of it is still in force: removing or
  // overriding its last part ends it, and the row goes.
  const understood = ai.status === "understood" && activeChips.length > 0;
  const fallbackText = ai.status === "fallback" ? aiFallbackNotice(ai.reason) : null;
  const total = totalOrders(desk.statusCounts);
  const drawerSummary = drawerOrderId ? desk.orders.find((order) => order.id === drawerOrderId) : undefined;
  const nextRequest = drawerOrderId ? nextWaitingRequest(visible, drawerOrderId, closedKeys, rejectedKeys) : null;
  const drawerTimeline =
    drawerOrderId && desk.timeline?.orderId === drawerOrderId ? desk.timeline.events : [];

  const showToolbar = load.status === "ready" && !(total === 0 && desk.orders.length === 0);

  return (
    <main
      className={`mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-4 sm:px-6 sm:py-5 ${
        selectedCards.length > 0 || bulkResult ? "pb-40 sm:pb-40" : ""
      }`}
    >
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
            onView={(next) => {
              viewBeforeAi.current = null;
              setAi((current) => (current.status === "understood" && current.fromView !== null ? { ...current, fromView: null } : current));
              updateDeskQuery({ view: next, status: null });
            }}
            viewCounts={viewCounts}
            showApproval={roleAtLeast(role, "manager")}
            statusKey={deskQuery.status}
            onStatus={(statusKey) => updateDeskQuery({ status: statusKey })}
            statusChips={viewChips}
            query={searchText}
            resetKey={searchReset}
            onQuery={onQueryText}
            onSubmit={onSearchSubmit}
            asking={ai.status === "asking"}
            aiHint={aiSearch}
            sort={deskQuery.sort}
            sortDefault={querySortDefault(deskQuery)}
            onSort={(sort) => updateDeskQuery({ sort })}
            kindFilter={
              showKindFilter && view !== "approval"
                ? {
                    kind: deskQuery.kind,
                    onKind: (kind: DeskKind) => updateDeskQuery({ kind }),
                    // The payload's counts over every card (the loaded page
                    // is already filtered by kind).
                    draftCount: drafts.draftCount,
                    deletedCount: drafts.deletedDraftCount,
                  }
                : null
            }
            count={matchCount}
          />
        ) : null}
      </div>

      {showToolbar ? (
        <>
          <FilterChips
            chips={activeChips}
            understood={understood}
            onRemove={(patch) => updateDeskQuery(patch)}
            onClear={clearFilters}
          />
          {/* Kept in the page so a fallback is announced when it lands. */}
          <p role="status" className={fallbackText ? "text-sm text-ink-2" : "sr-only"}>
            {fallbackText}
          </p>
        </>
      ) : null}

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
            {viewState === "failed" ? (
              <InlineMessage
                tone="warn"
                action={
                  <button
                    type="button"
                    onClick={() => {
                      setFailedKey(null);
                      void reload();
                    }}
                    className={ui.buttonSecondary}
                  >
                    Try again
                  </button>
                }
              >
                These cards did not load. The cards below are from before your last change.
              </InlineMessage>
            ) : null}
            {!searchReady && deskQuery.q.trim() !== "" ? (
              <InlineMessage tone="info">Search is still indexing older cards, so some may be missing for a little while.</InlineMessage>
            ) : null}
            {/* The loaded query's list or empty state, dimmed while another
                query loads. */}
            <div aria-busy={switching || undefined} className={switching ? "opacity-60 transition-opacity" : undefined}>
              {visible.length === 0 ? (
                <NoMatches
                  view={loadedQuery.view}
                  query={deskQuery.q}
                  filtered={searchChips.length > 0}
                  kind={filter.kind ?? "all"}
                  statusLabel={
                    filter.statusKey === null
                      ? null
                      : (chips.find((chip) => chip.key === filter.statusKey)?.label ?? "this status")
                  }
                  onClear={clearFilters}
                />
              ) : (
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
                  selection={{ selected: selection.selected, onToggle: toggleCard, onToggleAll: toggleAll }}
                  showPrices={showPrices}
                />
              )}
            </div>
            {/* The cursor belongs to the loaded query, so older cards are
                offered only once the list holds the address's query. */}
            <LoadMore
              remaining={nextCursor && viewState === "ready" ? Math.max(0, matchCount - desk.orders.length) : 0}
              busy={loadingMore}
              onLoad={() => void loadMore()}
            />
          </>
        )
      ) : null}

      <BulkBar
        cards={selectedCards}
        statuses={statuses}
        role={role}
        busy={bulkBusy}
        result={bulkResult}
        onMove={moveSelected}
        onClear={() => replaceSelection({ selected: new Set(), anchor: null })}
        onDismissResult={() => setBulkResult(null)}
      />

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
            onCancelOrder={(reason) => cancelOrderAction(drawerOrderId, reason)}
            onEditRequest={(body) => editRequestAction(drawerOrderId, body)}
            nextRequest={nextRequest}
            onApproveAndNext={nextRequest ? () => approveAndNext(drawerOrderId, nextRequest.id) : undefined}
            onClose={closeOrder}
            onRetry={() => void loadDrawer(drawerOrderId, false)}
            canManagePos={canManagePos}
            poRefreshKey={poRefresh}
            onCreatePo={() => setPoModal({ orderId: drawerOrderId, po: null })}
            onEditPo={(po) => setPoModal({ orderId: drawerOrderId, po })}
            showPrices={showPrices}
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
