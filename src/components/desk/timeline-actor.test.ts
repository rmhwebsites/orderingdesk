import { describe, it, expect } from "vitest";
import type { EventView } from "@/server/desk/shapes";
import { timelineActor } from "./timeline-actor";

const event = (overrides: Partial<EventView> = {}): EventView => ({
  id: "e1",
  orderId: "o1",
  type: "status",
  text: "Status set to Processing",
  actorId: "u_casey",
  meta: null,
  createdAt: 1,
  source: "app",
  ...overrides,
});

const members = new Map([["u_casey", { userId: "u_casey", role: "staff", name: "Casey Lin", email: "casey.lin@example.com" }]]);

describe("timelineActor", () => {
  it("names the person, and the AI app when the change came through one", () => {
    expect(timelineActor(event(), members, "u_self")).toEqual({ name: "Casey Lin", via: null });
    expect(timelineActor(event({ source: "ai", meta: { ai: { client: "claude" } } }), members, "u_self")).toEqual({
      name: "Casey Lin",
      via: "via Claude",
    });
    expect(timelineActor(event({ source: "ai", meta: { ai: { client: "chatgpt" } } }), members, "u_casey")).toEqual({
      name: "You",
      via: "via ChatGPT",
    });
  });

  it("keeps the old names for Shopify, the app and former members", () => {
    expect(timelineActor(event({ actorId: null, source: "shopify" }), members, "u_self").name).toBe("Shopify");
    expect(timelineActor(event({ actorId: "u_gone" }), members, "u_self").name).toBe("Former member");
    expect(timelineActor(event({ actorId: "u_admin", actorName: "Avery Stone" }), members, "u_self").name).toBe("Avery Stone");
  });
});
