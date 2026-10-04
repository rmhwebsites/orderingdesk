"use client";

// Live updates for one workspace: fetch a ticket, open the /live socket
// (src/realtime/live.ts), reconnect with exponential backoff, and fall back
// to polling while the socket is down. The caller refetches on onResync,
// which fires after every reconnect (missed events are never replayed) and
// on each poll tick.

import { useEffect, useRef, useState } from "react";
import { LIVE_KICK_CLOSE_CODE, LIVE_REFRESH_CLOSE_CODE, parseLiveEvent, type LiveEvent } from "./live-events";

export type LiveStatus = "connecting" | "live" | "offline";

export const POLL_INTERVAL_MS = 30000;
export const MAX_RECONNECT_DELAY_MS = 30000;
const HEARTBEAT_MS = 25000;

// 1s, 2s, 4s ... capped at 30s, each with up to 20% jitter so a room's
// clients do not reconnect in lockstep after a deploy.
export function reconnectDelay(attempt: number, random: number = Math.random()): number {
  const base = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.min(attempt, 10));
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(base * (0.8 + random * 0.4)));
}

// Every close is retried except the room removing this person (their
// access to the workspace went): then the page reloads instead, and the
// server answers with whatever they may still see. The room's refresh
// close (LIVE_REFRESH_CLOSE_CODE, a socket past its age cap) reconnects at
// once with a new ticket.
export function shouldReconnect(closeCode: number): boolean {
  return closeCode !== LIVE_KICK_CLOSE_CODE;
}

// The ticket route answers 401 once the session is gone and 404 once the
// person may no longer see the workspace. Retrying cannot change either,
// so the client stops and reloads, like a kick.
export function ticketRefusalIsFinal(status: number): boolean {
  return status === 401 || status === 404;
}

class TicketRefused extends Error {
  constructor(readonly status: number) {
    super(`ticket ${status}`);
  }
}

export function liveUrl(location: { protocol: string; host: string }, workspaceId: string, ticket: string): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ workspace: workspaceId, ticket });
  return `${scheme}//${location.host}/live?${query.toString()}`;
}

async function fetchTicket(workspaceId: string): Promise<string> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/live-ticket`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new TicketRefused(response.status);
  }
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string") {
    throw new Error("ticket missing");
  }
  return body.ticket;
}

export function useLive(opts: {
  workspaceId: string;
  onEvent: (event: LiveEvent) => void;
  onResync: () => void;
}): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const handlers = useRef({ onEvent: opts.onEvent, onResync: opts.onResync });

  useEffect(() => {
    handlers.current = { onEvent: opts.onEvent, onResync: opts.onResync };
  });

  const { workspaceId } = opts;

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let connecting = false;
    let attempt = 0;
    // Set once anything went wrong, so the next open refetches what the gap
    // may have missed.
    let hadGap = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    function startPolling() {
      if (pollTimer !== undefined) {
        return;
      }
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible") {
          handlers.current.onResync();
        }
      }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }

    function wentDown() {
      hadGap = true;
      setStatus("offline");
      startPolling();
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, reconnectDelay(attempt++));
    }

    // Access is gone (a kick, or the ticket route refusing for good): stop
    // and reload, so the server shows whatever this person may still see.
    function accessEnded() {
      disposed = true;
      clearTimeout(reconnectTimer);
      stopPolling();
      setStatus("offline");
      window.location.reload();
    }

    async function connect() {
      if (disposed || connecting || socket) {
        return;
      }
      connecting = true;
      let ticket: string;
      try {
        ticket = await fetchTicket(workspaceId);
      } catch (e) {
        connecting = false;
        if (disposed) {
          return;
        }
        if (e instanceof TicketRefused && ticketRefusalIsFinal(e.status)) {
          accessEnded();
          return;
        }
        wentDown();
        return;
      }
      if (disposed) {
        connecting = false;
        return;
      }
      const ws = new WebSocket(liveUrl(window.location, workspaceId, ticket));
      socket = ws;
      connecting = false;

      ws.onopen = () => {
        if (disposed || socket !== ws) {
          return;
        }
        attempt = 0;
        setStatus("live");
        stopPolling();
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("ping");
          }
        }, HEARTBEAT_MS);
        if (hadGap) {
          hadGap = false;
          handlers.current.onResync();
        }
      };
      ws.onmessage = (message) => {
        if (typeof message.data !== "string") {
          return;
        }
        const event = parseLiveEvent(message.data);
        if (event) {
          handlers.current.onEvent(event);
        }
      };
      ws.onclose = (event) => {
        if (socket !== ws) {
          return;
        }
        socket = null;
        clearInterval(heartbeatTimer);
        if (disposed) {
          return;
        }
        if (!shouldReconnect(event.code)) {
          accessEnded();
          return;
        }
        if (event.code === LIVE_REFRESH_CLOSE_CODE) {
          // A planned refresh, not an outage: reconnect now and refetch
          // what the moment between the sockets may have missed.
          hadGap = true;
          attempt = 0;
          void connect();
          return;
        }
        wentDown();
      };
    }

    // Back online or back to the tab: try now instead of waiting out the
    // backoff.
    function reconnectNow() {
      if (disposed || socket || connecting) {
        return;
      }
      attempt = 0;
      clearTimeout(reconnectTimer);
      void connect();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        reconnectNow();
      }
    }

    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisibility);
    void connect();

    return () => {
      disposed = true;
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(reconnectTimer);
      clearInterval(heartbeatTimer);
      stopPolling();
      if (socket) {
        const ws = socket;
        socket = null;
        ws.close(1000, "leaving");
      }
    };
  }, [workspaceId]);

  return status;
}
