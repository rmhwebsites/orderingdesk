import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import type { EventView } from "./shapes";

vi.mock("@/server/broadcast", () => ({ broadcast: vi.fn(async () => undefined) }));
vi.mock("@/server/notify", () => ({ notifyActivity: vi.fn(async () => ({ pushed: 0 })) }));
vi.mock("@/server/shopify/fanout", () => ({ pushAndShare: vi.fn(async () => undefined) }));

import { broadcast } from "@/server/broadcast";
import { notifyActivity } from "@/server/notify";
import { pushAndShare } from "@/server/shopify/fanout";
import { followNote, followStatusChange } from "./follow";

const db = {} as Db;
const env = {} as CloudflareEnv;
const event = (type: "status" | "note"): EventView => ({
  id: "e1",
  orderId: "o1",
  type,
  text: type === "note" ? "Checked" : "Status set to Processing",
  actorId: "u_casey",
  meta: null,
  createdAt: 1,
  source: "ai",
});

describe("follow-ups after a status change or a note", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shares a status change, pushes it and writes it to Shopify, in that order", async () => {
    const order = { id: "o1", statusKey: "processing", statusSetBy: "u_casey", statusSetAt: 1 };
    await followStatusChange(db, env, "ws1", { event: event("status"), order });
    expect(vi.mocked(broadcast).mock.calls).toEqual([[env, "ws1", { kind: "order.status", event: event("status"), order }]]);
    expect(vi.mocked(notifyActivity).mock.calls[0].slice(0, 4)).toEqual([db, env, "ws1", event("status")]);
    expect(vi.mocked(pushAndShare).mock.calls[0].slice(0, 4)).toEqual([db, env, "ws1", "o1"]);
  });

  it("shares a note and pushes it", async () => {
    await followNote(db, env, "ws1", event("note"));
    expect(vi.mocked(broadcast).mock.calls).toEqual([[env, "ws1", { kind: "order.note", event: event("note") }]]);
    expect(vi.mocked(notifyActivity)).toHaveBeenCalledTimes(1);
    expect(pushAndShare).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    vi.mocked(broadcast).mockRejectedValueOnce(new Error("socket down"));
    await expect(followNote(db, env, "ws1", event("note"))).resolves.toBeUndefined();
  });
});
