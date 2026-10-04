import { describe, it, expect } from "vitest";
import { LIVE_KICK_CLOSE_CODE, LIVE_REFRESH_CLOSE_CODE } from "./live-events";
import {
  MAX_RECONNECT_DELAY_MS,
  POLL_INTERVAL_MS,
  liveUrl,
  reconnectDelay,
  shouldReconnect,
  ticketRefusalIsFinal,
} from "./use-live";

describe("reconnectDelay", () => {
  it("doubles from one second with up to 20% jitter", () => {
    expect(reconnectDelay(0, 0)).toBe(800);
    expect(reconnectDelay(0, 1)).toBe(1200);
    expect(reconnectDelay(1, 0.5)).toBe(2000);
    expect(reconnectDelay(3, 0.5)).toBe(8000);
  });

  it("never waits longer than the cap", () => {
    for (const attempt of [5, 6, 10, 50]) {
      expect(reconnectDelay(attempt, 1)).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS);
    }
    expect(MAX_RECONNECT_DELAY_MS).toBe(30000);
  });

  it("polls every 30 seconds while the socket is down", () => {
    expect(POLL_INTERVAL_MS).toBe(30000);
  });
});

describe("liveUrl", () => {
  it("uses wss on https and carries the workspace and ticket", () => {
    expect(liveUrl({ protocol: "https:", host: "orderingdesk.example.dev" }, "ws_1", "a.b")).toBe(
      "wss://orderingdesk.example.dev/live?workspace=ws_1&ticket=a.b",
    );
    expect(liveUrl({ protocol: "http:", host: "localhost:3000" }, "w s", "t")).toBe(
      "ws://localhost:3000/live?workspace=w+s&ticket=t",
    );
  });
});

describe("shouldReconnect", () => {
  it("reconnects after any close except the room removing this person", () => {
    for (const code of [1000, 1001, 1006, 1011, 4000]) {
      expect(shouldReconnect(code)).toBe(true);
    }
    expect(shouldReconnect(LIVE_KICK_CLOSE_CODE)).toBe(false);
    expect(LIVE_KICK_CLOSE_CODE).toBe(4003);
  });

  it("reconnects when the room asks for a fresh ticket", () => {
    expect(shouldReconnect(LIVE_REFRESH_CLOSE_CODE)).toBe(true);
    expect(LIVE_REFRESH_CLOSE_CODE).toBe(4001);
  });
});

// The ticket route answers 401 once signed out and 404 once the person no
// longer has access: retrying cannot help, so the client stops and reloads
// (the server then shows whatever they may still see) instead of retrying
// and polling forever.
describe("ticketRefusalIsFinal", () => {
  it("is final for 401 and 404 only", () => {
    expect(ticketRefusalIsFinal(401)).toBe(true);
    expect(ticketRefusalIsFinal(404)).toBe(true);
    for (const status of [0, 429, 500, 502, 503]) {
      expect(ticketRefusalIsFinal(status)).toBe(false);
    }
  });
});
