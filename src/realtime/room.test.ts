import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { KICK_CLOSE_CODE, WorkspaceRoom } from "./room";

// workerd globals the room touches, played by minimal stand-ins (vitest runs
// on Node; "cloudflare:workers" is aliased to src/test/cloudflare-workers-stub.ts).
class FakePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).WebSocketRequestResponsePair = FakePair;
});

type FakeSocket = {
  tags: string[];
  sent: string[];
  send(data: string): void;
  close(code?: number, reason?: string): void;
  closed?: [number?, string?];
};

function socket(opts?: { throws?: boolean; tags?: string[] }): FakeSocket {
  const s: FakeSocket = {
    tags: opts?.tags ?? [],
    sent: [],
    send(data: string) {
      if (opts?.throws) {
        throw new Error("socket closing");
      }
      s.sent.push(data);
    },
    close(code?: number, reason?: string) {
      s.closed = [code, reason];
    },
  };
  return s;
}

// Durable Object storage as the room uses it: a key-value map and one alarm.
function fakeStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    get alarm() {
      return alarm;
    },
    storage: {
      async get(key: string) {
        return data.get(key);
      },
      async put(key: string, value: unknown) {
        data.set(key, value);
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          data.delete(key);
        }
      },
      async list(opts: { prefix?: string }) {
        return new Map([...data].filter(([key]) => key.startsWith(opts.prefix ?? "")));
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(at: number) {
        alarm = at;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
  };
}

function room(sockets: FakeSocket[]) {
  const autoResponses: unknown[] = [];
  const accepted: Array<{ socket: unknown; tags: string[] }> = [];
  const store = fakeStorage();
  const ctx = {
    getWebSockets: (tag?: string) => (tag === undefined ? sockets : sockets.filter((s) => s.tags.includes(tag))),
    acceptWebSocket: (ws: unknown, tags: string[] = []) => accepted.push({ socket: ws, tags }),
    setWebSocketAutoResponse: (pair: unknown) => autoResponses.push(pair),
    storage: store.storage,
  };
  const instance = new WorkspaceRoom(ctx as unknown as DurableObjectState, {} as CloudflareEnv);
  return { instance, autoResponses, accepted, store };
}

// workerd's Response accepts status 101 with a webSocket; Node's refuses
// it, so the connect tests swap in a recording stand-in.
class UpgradeResponse {
  readonly status: number;
  readonly webSocket: unknown;
  constructor(_body: unknown, init: { status: number; webSocket?: unknown }) {
    this.status = init.status;
    this.webSocket = init.webSocket;
  }
}

class FakeWebSocketPair {
  0 = { side: "client" };
  1 = { side: "server" };
}

function connectRequest(headers: Record<string, string>) {
  return new Request("https://workspace-room/connect", { headers: { Upgrade: "websocket", ...headers } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspaceRoom", () => {
  it("answers ping with pong without waking from hibernation", () => {
    const { autoResponses } = room([]);
    expect(autoResponses).toEqual([new FakePair("ping", "pong")]);
  });

  it("also answers a ping that reaches the handler", async () => {
    const ws = socket();
    const { instance } = room([ws]);
    await instance.webSocketMessage(ws as unknown as WebSocket, "ping");
    await instance.webSocketMessage(ws as unknown as WebSocket, "hello");
    expect(ws.sent).toEqual(["pong"]);
  });

  it("fans a broadcast out to every socket, past one that fails", async () => {
    const a = socket();
    const broken = socket({ throws: true });
    const b = socket();
    const { instance } = room([a, broken, b]);
    const body = JSON.stringify({ kind: "order.note", event: { id: "e1" } });
    const response = await instance.fetch(
      new Request("https://workspace-room/broadcast", { method: "POST", body }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 2 });
    expect(a.sent).toEqual([body]);
    expect(b.sent).toEqual([body]);
  });

  it("only broadcasts on POST", async () => {
    const a = socket();
    const { instance } = room([a]);
    const response = await instance.fetch(new Request("https://workspace-room/broadcast"));
    expect(response.status).toBe(405);
    expect(a.sent).toEqual([]);
  });

  it("refuses anything else that is not a WebSocket upgrade", async () => {
    const { instance } = room([]);
    const response = await instance.fetch(new Request("https://workspace-room/live"));
    expect(response.status).toBe(426);
  });

  it("accepts a fresh ticket's socket tagged with its user, and spends the nonce until the ticket expires", async () => {
    const now = Date.now();
    const { instance, accepted, store } = room([]);
    vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
    const realResponse = Response;
    vi.stubGlobal("Response", Object.assign(UpgradeResponse, { json: realResponse.json.bind(realResponse) }));
    const headers = { "x-live-user": "u_marta", "x-live-nonce": "a".repeat(32), "x-live-exp": String(now + 60000) };
    const first = (await instance.fetch(connectRequest(headers))) as unknown as UpgradeResponse;
    expect(first.status).toBe(101);
    expect(first.webSocket).toEqual({ side: "client" });
    expect(accepted).toEqual([{ socket: { side: "server" }, tags: ["u_marta"] }]);
    expect(store.data.get("nonce:" + "a".repeat(32))).toBe(now + 60000);
    expect(store.alarm).toBe(now + 60000);

    // The same ticket again: refused, nothing accepted.
    vi.unstubAllGlobals();
    const replay = await instance.fetch(connectRequest(headers));
    expect(replay.status).toBe(401);
    expect(accepted).toHaveLength(1);
  });

  it("refuses a connect without the verified user, nonce or a future expiry", async () => {
    const now = Date.now();
    const { instance, accepted } = room([]);
    const cases: Array<Record<string, string>> = [
      { "x-live-nonce": "b".repeat(32), "x-live-exp": String(now + 60000) },
      { "x-live-user": "u_marta", "x-live-exp": String(now + 60000) },
      { "x-live-user": "u_marta", "x-live-nonce": "b".repeat(32) },
      { "x-live-user": "u_marta", "x-live-nonce": "b".repeat(32), "x-live-exp": String(now - 1) },
      { "x-live-user": "u_marta", "x-live-nonce": "b".repeat(32), "x-live-exp": "soon" },
    ];
    for (const headers of cases) {
      expect((await instance.fetch(connectRequest(headers))).status, JSON.stringify(headers)).toBe(401);
    }
    expect(accepted).toHaveLength(0);
  });

  it("forgets spent nonces once their tickets expire, keeping the alarm for the rest", async () => {
    const now = Date.now();
    const { instance, store } = room([]);
    store.data.set("nonce:old", now - 5);
    store.data.set("nonce:fresh", now + 30000);
    store.data.set("nonce:later", now + 50000);
    await instance.alarm();
    expect([...store.data.keys()].sort()).toEqual(["nonce:fresh", "nonce:later"]);
    expect(store.alarm).toBe(now + 30000);
  });

  it("closes only the kicked user's sockets", async () => {
    const marta = socket({ tags: ["u_marta"] });
    const martaPhone = socket({ tags: ["u_marta"] });
    const jo = socket({ tags: ["u_jo"] });
    const { instance } = room([marta, martaPhone, jo]);
    const response = await instance.fetch(
      new Request("https://workspace-room/kick", { method: "POST", body: JSON.stringify({ userId: "u_marta" }) }),
    );
    expect(await response.json()).toEqual({ closed: 2 });
    expect(marta.closed).toEqual([KICK_CLOSE_CODE, "Access removed"]);
    expect(martaPhone.closed).toEqual([KICK_CLOSE_CODE, "Access removed"]);
    expect(jo.closed).toBeUndefined();
    expect(KICK_CLOSE_CODE).toBe(4003);
  });

  it("only kicks on POST with a user id", async () => {
    const marta = socket({ tags: ["u_marta"] });
    const { instance } = room([marta]);
    expect((await instance.fetch(new Request("https://workspace-room/kick"))).status).toBe(405);
    expect(
      (await instance.fetch(new Request("https://workspace-room/kick", { method: "POST", body: "{}" }))).status,
    ).toBe(400);
    expect(marta.closed).toBeUndefined();
  });

  it("completes the close handshake, mapping reserved codes", async () => {
    const ws = socket();
    const { instance } = room([ws]);
    await instance.webSocketClose(ws as unknown as WebSocket, 1001, "going away", true);
    expect(ws.closed).toEqual([1001, "going away"]);
    const silent = socket();
    await instance.webSocketClose(silent as unknown as WebSocket, 1005, "", false);
    expect(silent.closed).toEqual([1000, ""]);
  });
});
