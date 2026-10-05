import { describe, it, expect, vi, afterEach } from "vitest";
import type { LiveEvent } from "../lib/live-events";
import { broadcast, broadcastMerges, broadcastSync, kickUsers } from "./broadcast";

const WS = "ws_impact";

type Call = { room: string; url: string; method: string; body: string };

function fakeEnv(respond: () => Promise<Response> | Response) {
  const calls: Call[] = [];
  const env = {
    ROOM: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        async fetch(url: string, init: RequestInit) {
          calls.push({ room: id.name, url, method: String(init.method), body: String(init.body) });
          return respond();
        },
      }),
    },
  } as unknown as CloudflareEnv;
  return { env, calls };
}

const noteEvent: LiveEvent = {
  kind: "order.note",
  event: {
    id: "e1",
    orderId: "o1",
    type: "note",
    text: "Called the customer",
    actorId: "u1",
    meta: null,
    createdAt: 1,
    source: "app",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("broadcast", () => {
  it("POSTs the event as JSON to the workspace room's /broadcast", async () => {
    const { env, calls } = fakeEnv(() => Response.json({ sent: 1 }));
    await broadcast(env, WS, noteEvent);
    expect(calls).toEqual([
      {
        room: WS,
        url: "https://workspace-room/broadcast",
        method: "POST",
        body: JSON.stringify(noteEvent),
      },
    ]);
  });

  it("never throws when the room fails, refuses or the binding is broken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rejecting = fakeEnv(() => Promise.reject(new Error("DO unavailable")));
    await expect(broadcast(rejecting.env, WS, noteEvent)).resolves.toBeUndefined();
    const refusing = fakeEnv(() => new Response("nope", { status: 500 }));
    await expect(broadcast(refusing.env, WS, noteEvent)).resolves.toBeUndefined();
    const broken = {
      ROOM: {
        idFromName: () => {
          throw new Error("binding misconfigured");
        },
      },
    } as unknown as CloudflareEnv;
    await expect(broadcast(broken, WS, noteEvent)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("gives up on a room that does not answer", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env } = fakeEnv(() => new Promise<Response>(() => undefined));
    const pending = broadcast(env, WS, noteEvent);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("is a silent no-op when the environment has no ROOM binding", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(broadcast({} as CloudflareEnv, WS, noteEvent)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("broadcastSync", () => {
  it("sends one orders.synced event with the landed ids", async () => {
    const { env, calls } = fakeEnv(() => Response.json({ sent: 1 }));
    await broadcastSync(env, WS, { addedOrderIds: ["a"], updatedOrderIds: ["b", "c"] });
    expect(calls.map((call) => JSON.parse(call.body))).toEqual([
      { kind: "orders.synced", addedOrderIds: ["a"], updatedOrderIds: ["b", "c"] },
    ]);
  });

  it("sends nothing when the run landed nothing", async () => {
    const { env, calls } = fakeEnv(() => Response.json({ sent: 1 }));
    await broadcastSync(env, WS, { addedOrderIds: [], updatedOrderIds: [] });
    expect(calls).toEqual([]);
  });
});

describe("kickUsers", () => {
  it("asks the workspace room to close each user's sockets", async () => {
    const { env, calls } = fakeEnv(() => Response.json({ closed: 1 }));
    await kickUsers(env, WS, ["u_marta", "u_jo"]);
    expect(calls).toEqual([
      { room: WS, url: "https://workspace-room/kick", method: "POST", body: JSON.stringify({ userId: "u_marta" }) },
      { room: WS, url: "https://workspace-room/kick", method: "POST", body: JSON.stringify({ userId: "u_jo" }) },
    ]);
  });

  it("sends nothing for nobody, and never throws", async () => {
    const quiet = fakeEnv(() => Response.json({ closed: 0 }));
    await kickUsers(quiet.env, WS, []);
    expect(quiet.calls).toEqual([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = fakeEnv(() => Promise.reject(new Error("DO unavailable")));
    await expect(kickUsers(broken.env, WS, ["u_marta"])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    await expect(kickUsers({} as CloudflareEnv, WS, ["u_marta"])).resolves.toBeUndefined();
  });
});

// Draft orders (spec section 6.4): an order card folded into a draft card
// tells open desks which id went and which one it became.
describe("broadcastMerges", () => {
  it("sends one order.merged event per merge, and nothing for none", async () => {
    const { env, calls } = fakeEnv(() => Response.json({ sent: 1 }));
    await broadcastMerges(env, WS, []);
    expect(calls).toEqual([]);
    await broadcastMerges(env, WS, [
      { fromId: "o_orphan", toId: "o_draft" },
      { fromId: "o_b", toId: "o_c" },
    ]);
    expect(calls.map((call) => JSON.parse(call.body))).toEqual([
      { kind: "order.merged", fromId: "o_orphan", toId: "o_draft" },
      { kind: "order.merged", fromId: "o_b", toId: "o_c" },
    ]);
  });
});
