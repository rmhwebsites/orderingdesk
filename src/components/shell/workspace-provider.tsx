"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LiveEvent } from "@/lib/live-events";
import { startSyncRechecks, syncAfterFailedCheck, type SyncLoadState } from "@/lib/sync-status";
import { useLive, type LiveStatus } from "@/lib/use-live";
import type { SyncConnectionView } from "@/server/desk/sync";
import { roleAtLeast, type Role } from "@/lib/roles";
import type { SyncResult } from "@/server/sync/run";
import { useToast } from "@/components/toasts";

// Workspace-wide client state for the shell and the desk: who is looking,
// the store connection (sync chip), the manual Sync button, and one message
// bus that carries live events (socket or this tab's own sync) and resync
// requests (after a reconnect, on each poll while offline).

// basePath: where this workspace's pages live on the current host. "/w/<slug>"
// on the hub; "" on the workspace's own client host, which serves it at its
// root (src/server/host.ts). Build workspace links as `${basePath}/...`.
export type WorkspaceIdentity = { id: string; slug: string; name: string; basePath: string };

export type BusMessage = { type: "event"; event: LiveEvent } | { type: "resync" };

export type ManualSyncState = {
  running: boolean;
  // Epoch ms until which the server's 30 second cooldown applies.
  cooldownUntil: number;
  // The last manual run's failure (502 or no response), with what still
  // landed; cleared by the next run that completes.
  failure: { message: string; added: number; updated: number } | null;
};

type WorkspaceContextValue = {
  workspace: WorkspaceIdentity;
  role: Role;
  userId: string;
  liveStatus: LiveStatus;
  sync: SyncLoadState;
  connection: SyncConnectionView | null;
  manual: ManualSyncState;
  runManualSync: () => void;
  subscribe: (listener: (message: BusMessage) => void) => () => void;
  // Requests waiting for approval (managers and platform admins; null for
  // staff and until it loads).
  needsApproval: number | null;
  // Ask for the count again soon (after an approve, a reject, a bulk move).
  refreshQueue: () => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  }
  return value;
}

const SKIP_MESSAGES: Record<NonNullable<SyncResult["skipped"]>, string> = {
  running: "A sync is already running. New orders will appear here when it finishes.",
  "no-connection": "No Shopify store is connected to this workspace yet.",
  disabled: "Sync is paused for this store.",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function WorkspaceProvider({
  workspace,
  role,
  userId,
  children,
}: {
  workspace: WorkspaceIdentity;
  role: Role;
  userId: string;
  children: React.ReactNode;
}) {
  const toast = useToast();
  const listeners = useRef(new Set<(message: BusMessage) => void>());
  const [sync, setSync] = useState<SyncLoadState>({ status: "loading" });
  const [manual, setManual] = useState<ManualSyncState>({ running: false, cooldownUntil: 0, failure: null });
  const runningRef = useRef(false);
  const canApprove = roleAtLeast(role, "manager");
  const [needsApproval, setNeedsApproval] = useState<number | null>(null);
  const queueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publish = useCallback((message: BusMessage) => {
    for (const listener of listeners.current) {
      listener(message);
    }
  }, []);

  const subscribe = useCallback((listener: (message: BusMessage) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const reloadSync = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/sync`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as { connection: SyncConnectionView | null };
      setSync({ status: "ready", connection: body.connection, checkedAt: Date.now() });
    } catch (e) {
      const message = e instanceof Error ? e.message : "failed";
      setSync((current) => syncAfterFailedCheck(current, message, Date.now()));
    }
  }, [workspace.id]);

  useEffect(() => {
    void reloadSync();
  }, [reloadSync]);

  // A quiet store's cron runs are not broadcast, so re-read the status on a
  // timer while the page is visible, and when it comes back into view
  // (src/lib/sync-status.ts SYNC_RECHECK_MS).
  useEffect(() => startSyncRechecks(() => void reloadSync(), document), [reloadSync]);

  const loadQueue = useCallback(async () => {
    if (!canApprove) {
      return;
    }
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/queue`, { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { needsApproval?: unknown };
      setNeedsApproval(typeof body.needsApproval === "number" ? body.needsApproval : null);
    } catch {
      // Keep the last count through a blip.
    }
  }, [workspace.id, canApprove]);

  // Many live events can land together (a sync): one reload for all of them.
  const refreshQueue = useCallback(() => {
    if (queueTimer.current) {
      clearTimeout(queueTimer.current);
    }
    queueTimer.current = setTimeout(() => {
      queueTimer.current = null;
      void loadQueue();
    }, 400);
  }, [loadQueue]);

  useEffect(() => {
    void loadQueue();
    return () => {
      if (queueTimer.current) {
        clearTimeout(queueTimer.current);
      }
    };
  }, [loadQueue]);

  const liveStatus = useLive({
    workspaceId: workspace.id,
    onEvent: (event) => {
      publish({ type: "event", event });
      if (event.kind === "orders.synced") {
        void reloadSync();
      }
      if (event.kind !== "order.note") {
        refreshQueue();
      }
    },
    onResync: () => {
      publish({ type: "resync" });
      void reloadSync();
      refreshQueue();
    },
  });

  const runManualSync = useCallback(async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setManual((current) => ({ ...current, running: true }));
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/sync`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
        setManual((current) => ({ ...current, cooldownUntil: Date.now() + wait * 1000 }));
        return;
      }

      if (response.status === 502) {
        const added = typeof body?.added === "number" ? body.added : 0;
        const updated = typeof body?.updated === "number" ? body.updated : 0;
        const message = typeof body?.error === "string" ? body.error : "Shopify did not answer.";
        setManual((current) => ({
          ...current,
          failure: { message, added, updated },
          // The server only starts the cooldown when something landed.
          cooldownUntil: added + updated > 0 ? Date.now() + 30000 : current.cooldownUntil,
        }));
        if (added + updated > 0) {
          publish({ type: "resync" });
        }
        return;
      }

      if (!response.ok || !body) {
        const message =
          typeof body?.error === "string" ? body.error : `The sync could not start (HTTP ${response.status}).`;
        setManual((current) => ({ ...current, failure: { message, added: 0, updated: 0 } }));
        return;
      }

      const result = body as unknown as SyncResult;
      if (result.skipped) {
        setManual((current) => ({ ...current, failure: null }));
        toast({ title: SKIP_MESSAGES[result.skipped] ?? "Nothing to sync.", tone: "info" });
        return;
      }
      setManual((current) => ({ ...current, failure: null, cooldownUntil: Date.now() + 30000 }));
      // The same path a broadcast takes, so the desk refreshes and announces
      // new orders once (the broadcast echo of this run is then a no-op).
      publish({
        type: "event",
        event: {
          kind: "orders.synced",
          addedOrderIds: result.addedOrderIds ?? [],
          updatedOrderIds: result.updatedOrderIds ?? [],
        },
      });
      if (result.added === 0) {
        toast({
          title: result.updated > 0 ? `Updated ${plural(result.updated, "order")} from Shopify` : "Up to date",
          body: result.updated > 0 ? undefined : "Shopify has no new or changed orders.",
          tone: "good",
        });
      }
    } catch {
      setManual((current) => ({
        ...current,
        failure: { message: "Could not reach the server. Check your connection and try again.", added: 0, updated: 0 },
      }));
    } finally {
      runningRef.current = false;
      setManual((current) => ({ ...current, running: false }));
      void reloadSync();
    }
  }, [workspace.id, publish, reloadSync, toast]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspace,
      role,
      userId,
      liveStatus,
      sync,
      connection: sync.status === "ready" ? sync.connection : null,
      manual,
      runManualSync: () => void runManualSync(),
      subscribe,
      needsApproval,
      refreshQueue,
    }),
    [workspace, role, userId, liveStatus, sync, manual, runManualSync, subscribe, needsApproval, refreshQueue],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
