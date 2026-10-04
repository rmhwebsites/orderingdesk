import { DurableObject } from "cloudflare:workers";
import { LIVE_KICK_CLOSE_CODE, LIVE_REFRESH_CLOSE_CODE } from "../lib/live-events";
import { LIVE_TICKET_TTL_MS } from "./ticket";

// One room per workspace (idFromName(workspaceId)). Every open desk holds a
// WebSocket here; server mutations POST compact JSON events to /broadcast,
// which fans them out to every socket. The room keeps no events: a client
// that reconnects refetches the desk instead of replaying missed events.
//
// Hibernation API: sockets are accepted with ctx.acceptWebSocket, so an idle
// room is evicted from memory while its sockets stay open, and the "ping"
// heartbeat is answered by an auto-response that does not wake it.
//
// Reachable only through the ROOM binding: custom-worker.ts forwards a
// verified /live upgrade to /connect (src/realtime/live.ts), and server code
// posts to /broadcast and /kick (src/server/broadcast.ts). Nothing public
// routes to /broadcast or /kick.
//
// - /connect: the verified ticket's user, nonce and expiry arrive as
//   headers (src/realtime/live.ts has already checked that the user still
//   has access). A nonce is admitted once: it is stored until its ticket
//   expires, so a replayed ticket gets a 401. A ticket issued before its
//   user's last kick gets a 401 too. The socket is tagged with the user id
//   and carries {userId, connectedAt} as its attachment.
// - /kick {userId}: closes that user's sockets with LIVE_KICK_CLOSE_CODE,
//   after their membership or platform admin access was removed (the
//   client stops reconnecting on that code), and records when, until every
//   ticket issued before it has expired, so a ticket the person kept in
//   reserve cannot reopen a socket.
// - Age cap: a socket open for MAX_SOCKET_AGE_MS is closed with
//   LIVE_REFRESH_CLOSE_CODE; the client reconnects with a new ticket, whose
//   route and /live check access again. That covers access that ends
//   without a kick (a platform admin taken off the bootstrap list, a
//   signed-out session).
// - One alarm does the upkeep: it forgets expired nonces and kick records,
//   closes sockets past the age cap, and wakes again for the next of them.

export const KICK_CLOSE_CODE = LIVE_KICK_CLOSE_CODE;
export const MAX_SOCKET_AGE_MS = 30 * 60 * 1000;
const NONCE_PREFIX = "nonce:";
const KICK_PREFIX = "kick:";

type SocketAttachment = { userId: string; connectedAt: number };

function attachmentOf(socket: WebSocket): SocketAttachment | null {
  try {
    const value = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
    return value && typeof value.connectedAt === "number" && typeof value.userId === "string"
      ? { userId: value.userId, connectedAt: value.connectedAt }
      : null;
  } catch {
    return null;
  }
}

function refuse(status: number, text: string): Response {
  return new Response(text, { status });
}

export class WorkspaceRoom extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast") {
      if (request.method !== "POST") {
        return refuse(405, "Method not allowed");
      }
      const body = await request.text();
      let sent = 0;
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(body);
          sent++;
        } catch {
          // A socket mid-close; the runtime cleans it up.
        }
      }
      return Response.json({ sent });
    }

    if (url.pathname === "/kick") {
      if (request.method !== "POST") {
        return refuse(405, "Method not allowed");
      }
      const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
      const userId = typeof body?.userId === "string" ? body.userId : "";
      if (userId.length === 0) {
        return refuse(400, "userId is required");
      }
      const kickedAt = Date.now();
      await this.ctx.storage.put(KICK_PREFIX + userId, kickedAt);
      await this.wakeBy(kickedAt + LIVE_TICKET_TTL_MS);
      let closed = 0;
      for (const socket of this.ctx.getWebSockets(userId)) {
        try {
          socket.close(KICK_CLOSE_CODE, "Access removed");
          closed++;
        } catch {
          // Already closed.
        }
      }
      return Response.json({ closed });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return refuse(426, "Expected a WebSocket upgrade");
    }
    const userId = request.headers.get("x-live-user") ?? "";
    const nonce = request.headers.get("x-live-nonce") ?? "";
    const exp = Number(request.headers.get("x-live-exp"));
    if (userId.length === 0 || nonce.length === 0 || !Number.isFinite(exp) || exp <= Date.now()) {
      return refuse(401, "Unauthorized");
    }
    // A ticket lives LIVE_TICKET_TTL_MS, so it was issued at exp minus that.
    const kickedAt = await this.ctx.storage.get(KICK_PREFIX + userId);
    if (typeof kickedAt === "number" && exp - LIVE_TICKET_TTL_MS <= kickedAt) {
      return refuse(401, "Unauthorized");
    }
    // Storage calls do not let another request in between (input gates),
    // so two connects with one ticket cannot both pass this check.
    const key = NONCE_PREFIX + nonce;
    if ((await this.ctx.storage.get(key)) !== undefined) {
      return refuse(401, "Ticket already used");
    }
    await this.ctx.storage.put(key, exp);
    await this.wakeBy(exp);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [userId]);
    const attachment: SocketAttachment = { userId, connectedAt: Date.now() };
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Sets the alarm to `at` unless it already fires sooner.
  private async wakeBy(at: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  // The room's upkeep (see the header): forgets expired nonces and kick
  // records, closes sockets past the age cap, and wakes again for the next
  // of them.
  async alarm(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];
    let next: number | null = null;
    const consider = (at: number) => {
      if (next === null || at < next) {
        next = at;
      }
    };
    for (const [key, exp] of await this.ctx.storage.list<number>({ prefix: NONCE_PREFIX })) {
      if (typeof exp !== "number" || exp <= now) {
        expired.push(key);
      } else {
        consider(exp);
      }
    }
    for (const [key, kickedAt] of await this.ctx.storage.list<number>({ prefix: KICK_PREFIX })) {
      if (typeof kickedAt !== "number" || kickedAt + LIVE_TICKET_TTL_MS <= now) {
        expired.push(key);
      } else {
        consider(kickedAt + LIVE_TICKET_TTL_MS);
      }
    }
    // storage.delete takes at most 128 keys per call.
    for (let i = 0; i < expired.length; i += 128) {
      await this.ctx.storage.delete(expired.slice(i, i + 128));
    }
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(socket);
      // A socket without an attachment predates the age cap: refresh it.
      if (attachment === null || attachment.connectedAt + MAX_SOCKET_AGE_MS <= now) {
        try {
          socket.close(LIVE_REFRESH_CLOSE_CODE, "Refresh");
        } catch {
          // Already closed.
        }
      } else {
        consider(attachment.connectedAt + MAX_SOCKET_AGE_MS);
      }
    }
    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  // Normally answered by the auto-response; kept for a ping that arrives
  // while the room is awake and the auto-response is not consulted.
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      socket.send("pong");
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    // 1005 and 1006 describe how the peer left and may not be sent back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try {
      socket.close(1011, "error");
    } catch {
      // Already closed.
    }
  }
}
