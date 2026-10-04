import { DurableObject } from "cloudflare:workers";
import { LIVE_KICK_CLOSE_CODE } from "../lib/live-events";

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
//   headers. A nonce is admitted once: it is stored until its ticket
//   expires (an alarm forgets expired ones), so a replayed ticket gets a
//   401. The socket is tagged with the user id.
// - /kick {userId}: closes that user's sockets with LIVE_KICK_CLOSE_CODE,
//   after their membership or platform admin access was removed; the client
//   stops reconnecting on that code.

export const KICK_CLOSE_CODE = LIVE_KICK_CLOSE_CODE;
const NONCE_PREFIX = "nonce:";

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
    // Storage calls do not let another request in between (input gates),
    // so two connects with one ticket cannot both pass this check.
    const key = NONCE_PREFIX + nonce;
    if ((await this.ctx.storage.get(key)) !== undefined) {
      return refuse(401, "Ticket already used");
    }
    await this.ctx.storage.put(key, exp);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > exp) {
      await this.ctx.storage.setAlarm(exp);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [userId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Forgets the nonces of expired tickets and wakes again for the next one.
  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>({ prefix: NONCE_PREFIX });
    const expired: string[] = [];
    let next: number | null = null;
    for (const [key, exp] of entries) {
      if (typeof exp !== "number" || exp <= now) {
        expired.push(key);
      } else if (next === null || exp < next) {
        next = exp;
      }
    }
    // storage.delete takes at most 128 keys per call.
    for (let i = 0; i < expired.length; i += 128) {
      await this.ctx.storage.delete(expired.slice(i, i + 128));
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
