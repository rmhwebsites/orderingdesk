import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";
import { LIVE_PATH, handleLiveRequest } from "./live";
import { signLiveTicket } from "./ticket";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const WS = "ws_impact";

// u1 is a staff member of ws_impact; u_gone was removed; boss@example.com
// is a bootstrap platform admin and u_promoted a promoted one, members of
// nothing.
let db: Db;
beforeEach(async () => {
  db = openTestDb().db;
  await seedWorkspace(db, WS);
  await seedUser(db, "u1", "u1@example.com");
  await seedUser(db, "u_gone", "gone@example.com");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_promoted", "promoted@example.com");
  await seedMember(db, WS, "u1", "staff");
  await db.insert(schema.platformAdmins).values({ userId: "u_promoted", grantedBy: "u_boss", createdAt: 1 });
});

// A fake ROOM namespace that records which room was asked for and what was
// forwarded to it.
function fakeEnv() {
  const named: string[] = [];
  const forwarded: Request[] = [];
  const env = {
    BETTER_AUTH_SECRET: SECRET,
    PLATFORM_ADMIN_EMAILS: "boss@example.com",
    ROOM: {
      idFromName(name: string) {
        named.push(name);
        return { name };
      },
      get(id: { name: string }) {
        return {
          async fetch(request: Request) {
            forwarded.push(request);
            return new Response(`room ${id.name}`, { status: 200 });
          },
        };
      },
    },
  } as unknown as CloudflareEnv;
  return { env, named, forwarded };
}

function liveRequest(query: string, headers: Record<string, string> = { Upgrade: "websocket" }) {
  return new Request(`https://orderingdesk.example.dev${LIVE_PATH}?${query}`, { headers });
}

describe("handleLiveRequest", () => {
  it("serves the /live path", () => {
    expect(LIVE_PATH).toBe("/live");
  });

  it("forwards a valid upgrade to the workspace's room", async () => {
    const { env, named, forwarded } = fakeEnv();
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: "u1" }, SECRET);
    const response = await handleLiveRequest(liveRequest(`workspace=${WS}&ticket=${ticket}`), env, db);
    expect(await response.text()).toBe(`room ${WS}`);
    expect(named).toEqual([WS]);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].headers.get("Upgrade")).toBe("websocket");
  });

  // The room tags the socket with the user (so a kick can find it) and
  // spends the ticket's nonce; both come from the verified ticket, never
  // from the client, and the room's internal paths stay unreachable.
  it("hands the room the verified user, nonce and expiry on its connect path", async () => {
    const { env, forwarded } = fakeEnv();
    const { ticket, expiresAt } = await signLiveTicket({ workspaceId: WS, userId: "u1" }, SECRET);
    await handleLiveRequest(
      liveRequest(`workspace=${WS}&ticket=${ticket}`, {
        Upgrade: "websocket",
        "x-live-user": "u_mallory",
        "x-live-nonce": "reused",
      }),
      env,
      db,
    );
    const request = forwarded[0];
    expect(new URL(request.url).pathname).toBe("/connect");
    expect(request.headers.get("x-live-user")).toBe("u1");
    expect(request.headers.get("x-live-nonce")).toMatch(/^[0-9a-f]{32}$/);
    expect(request.headers.get("x-live-exp")).toBe(String(expiresAt));
    expect(request.headers.get("Upgrade")).toBe("websocket");
  });

  it("answers 401 without a ticket", async () => {
    const { env, forwarded } = fakeEnv();
    const response = await handleLiveRequest(liveRequest(`workspace=${WS}`), env, db);
    expect(response.status).toBe(401);
    expect(response.headers.get("Upgrade")).toBeNull();
    expect(forwarded).toHaveLength(0);
  });

  it("answers 401 for a forged, expired or other-workspace ticket", async () => {
    const { env, forwarded } = fakeEnv();
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: "u1" }, SECRET);
    const expired = await signLiveTicket({ workspaceId: WS, userId: "u1" }, SECRET, Date.now() - 120000);
    const foreign = await signLiveTicket({ workspaceId: WS, userId: "u1" }, "not-the-secret");
    for (const query of [
      `workspace=${WS}&ticket=${ticket}x`,
      `workspace=${WS}&ticket=${expired.ticket}`,
      `workspace=${WS}&ticket=${foreign.ticket}`,
      `workspace=ws_other&ticket=${ticket}`,
      `ticket=${ticket}`,
    ]) {
      const response = await handleLiveRequest(liveRequest(query), env, db);
      expect(response.status).toBe(401);
    }
    expect(forwarded).toHaveLength(0);
  });

  // A ticket is checked against the database when it is used, not only when
  // it is issued: someone who kept an unused ticket in reserve cannot come
  // back after their access went (removed, tag revoked, admin revoked).
  it("answers 401 to a genuine ticket whose user no longer has access to the workspace", async () => {
    const { env, forwarded } = fakeEnv();
    const kept = await signLiveTicket({ workspaceId: WS, userId: "u_gone" }, SECRET);
    const response = await handleLiveRequest(liveRequest(`workspace=${WS}&ticket=${kept.ticket}`), env, db);
    expect(response.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("forwards a platform admin's ticket for a workspace they are not a member of", async () => {
    const { env, forwarded } = fakeEnv();
    const boss = await signLiveTicket({ workspaceId: WS, userId: "u_boss" }, SECRET);
    const promoted = await signLiveTicket({ workspaceId: WS, userId: "u_promoted" }, SECRET);
    for (const { ticket } of [boss, promoted]) {
      const response = await handleLiveRequest(liveRequest(`workspace=${WS}&ticket=${ticket}`), env, db);
      expect(response.status).toBe(200);
    }
    expect(forwarded).toHaveLength(2);
  });

  it("refuses a valid ticket on a request that is not a WebSocket upgrade", async () => {
    const { env, forwarded } = fakeEnv();
    const { ticket } = await signLiveTicket({ workspaceId: WS, userId: "u1" }, SECRET);
    const response = await handleLiveRequest(liveRequest(`workspace=${WS}&ticket=${ticket}`, {}), env, db);
    expect(response.status).toBe(426);
    expect(forwarded).toHaveLength(0);
  });
});
