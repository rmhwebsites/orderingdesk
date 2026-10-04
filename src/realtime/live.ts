// The realtime socket endpoint, served by custom-worker.ts before requests
// reach OpenNext (a Next.js route handler cannot reliably return a WebSocket
// upgrade). The client opens
//   wss://<host>/live?workspace=<workspace id>&ticket=<live ticket>
// with a ticket from GET /api/workspaces/[id]/live-ticket. A genuine,
// unexpired ticket for that workspace is forwarded to the workspace's
// WorkspaceRoom; anything else gets a 401 and no upgrade. Relative imports
// only: bundled into the custom worker.
//
// The room is handed the verified user, nonce and expiry as headers on its
// /connect path (whatever the client sent under those names is replaced):
// it tags the socket with the user, so a kick can close it, and spends the
// nonce, so the ticket works once.
//
// Access is checked again when the ticket is used, not only when it was
// issued: a genuine ticket whose user is no longer a member (and not a
// platform admin) gets the same 401, so a ticket kept in reserve is
// worthless once the person's access goes.

import type { Db } from "../db";
import { canSeeWorkspace } from "../server/access";
import { verifyLiveTicket } from "./ticket";

export const LIVE_PATH = "/live";
const ROOM_CONNECT_URL = "https://workspace-room/connect";

export async function handleLiveRequest(request: Request, env: CloudflareEnv, db: Db): Promise<Response> {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspace") ?? "";
  const ticket = url.searchParams.get("ticket") ?? "";
  const claims =
    workspaceId.length > 0 && ticket.length > 0
      ? await verifyLiveTicket(ticket, { secret: env.BETTER_AUTH_SECRET, workspaceId })
      : null;
  if (!claims) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  if (!(await canSeeWorkspace(db, env, claims.userId, claims.workspaceId))) {
    return new Response("Unauthorized", { status: 401 });
  }
  // The room routes by path: this always lands on /connect, so its
  // /broadcast and /kick paths are reachable through the binding alone.
  const headers = new Headers(request.headers);
  headers.set("x-live-user", claims.userId);
  headers.set("x-live-nonce", claims.nonce);
  headers.set("x-live-exp", String(claims.exp));
  const room = env.ROOM.get(env.ROOM.idFromName(claims.workspaceId));
  return room.fetch(new Request(ROOM_CONNECT_URL, { method: "GET", headers }));
}
