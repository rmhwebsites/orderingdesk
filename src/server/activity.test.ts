import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace } from "./desk/test-helpers";
import { FEED_SIZE, UNREAD_CAP, loadActivityFeed, markAllRead } from "./activity";

const WS = "ws_impact";
let db: Db;
let n = 0;

async function event(overrides: Partial<typeof schema.events.$inferInsert> & { createdAt: number }) {
  n++;
  await db.insert(schema.events).values({
    id: `e${String(n).padStart(3, "0")}`,
    workspaceId: WS,
    orderId: "o1",
    type: "note",
    text: `event ${n}`,
    actorId: null,
    source: "app",
    ...overrides,
  });
}

async function setLastSeen(userId: string, at: number) {
  await db.update(schema.workspaceMembers).set({ lastSeenAt: at }).where(eq(schema.workspaceMembers.userId, userId));
}

beforeEach(async () => {
  n = 0;
  db = openTestDb().db;
  await seedWorkspace(db, WS);
  await seedWorkspace(db, "ws_other");
  await seedUser(db, "u_me", "me@example.com", "Jamie Rivers");
  await seedUser(db, "u_other", "other@example.com", "");
  await seedUser(db, "u_boss", "boss@example.com", "Boss");
  await seedMember(db, WS, "u_me", "staff");
  await seedMember(db, WS, "u_other", "manager");
  await seedOrder(db, WS, { id: "o1", name: "#1001" });
});

describe("loadActivityFeed unread count", () => {
  it("counts events newer than the member's last visit that someone else made", async () => {
    await setLastSeen("u_me", 100);
    await event({ createdAt: 90, actorId: "u_other" }); // seen already
    await event({ createdAt: 110, actorId: "u_other" }); // unread
    await event({ createdAt: 120, actorId: null, type: "order_new", text: "New order #1001", source: "shopify" }); // unread
    await event({ createdAt: 130, actorId: "u_me", type: "status", text: "Status set to Shipped" }); // mine
    await event({ createdAt: 140, actorId: "u_other", workspaceId: "ws_other", orderId: null }); // another workspace
    const feed = await loadActivityFeed(db, WS, "u_me");
    expect(feed.unread).toBe(2);
    expect(feed.lastSeenAt).toBe(100);
    expect(feed.items.map((item) => [item.id, item.unread, item.mine])).toEqual([
      ["e004", false, true],
      ["e003", true, false],
      ["e002", true, false],
      ["e001", false, false],
    ]);
  });

  it("leaves a successful Shopify write out of the feed, but shows a failed one", async () => {
    await event({ createdAt: 10, type: "shopify_write", text: "Shopify updated: tagged Ordering Desk: Shipped", meta: { ok: true }, source: "system" });
    await event({ createdAt: 20, type: "shopify_write", text: "Shopify did not take the tag", meta: { ok: false }, source: "system" });
    const feed = await loadActivityFeed(db, WS, "u_me");
    expect(feed.items.map((item) => item.text)).toEqual(["Shopify did not take the tag"]);
    expect(feed.unread).toBe(1);
  });

  it("leaves orders brought in by the order history import out of the feed and the count", async () => {
    await event({ createdAt: 10, type: "order_new", text: "New order #1001", meta: { orderName: "#1001" }, source: "shopify" });
    await event({
      createdAt: 20,
      type: "order_new",
      text: "Order #900 imported from the store's order history",
      meta: { orderName: "#900", imported: true },
      source: "shopify",
    });
    await event({ createdAt: 30, type: "order_new", text: "New order #1002", meta: null, source: "shopify" });
    const feed = await loadActivityFeed(db, WS, "u_me");
    expect(feed.items.map((item) => item.text)).toEqual(["New order #1002", "New order #1001"]);
    expect(feed.unread).toBe(2);
  });

  it(`stops counting at ${UNREAD_CAP + 1} so the badge can say ${UNREAD_CAP}+`, async () => {
    for (let i = 0; i < UNREAD_CAP + 20; i++) {
      await event({ createdAt: 1000 + i, actorId: "u_other" });
    }
    const feed = await loadActivityFeed(db, WS, "u_me");
    expect(feed.unread).toBe(UNREAD_CAP + 1);
    expect(feed.items).toHaveLength(FEED_SIZE);
  });

  it("gives a platform admin who is not a member the feed without an unread count", async () => {
    await event({ createdAt: 10, actorId: "u_other" });
    const feed = await loadActivityFeed(db, WS, "u_boss");
    expect(feed.unread).toBeNull();
    expect(feed.lastSeenAt).toBeNull();
    expect(feed.items.map((item) => item.unread)).toEqual([false]);
  });
});

describe("loadActivityFeed items", () => {
  it("names the order and who did it, newest first", async () => {
    await event({ createdAt: 10, actorId: "u_me", type: "note", text: "Called the customer" });
    await event({ createdAt: 20, actorId: "u_other", type: "status", text: "Status set to Shipped" });
    await event({ createdAt: 30, actorId: null, type: "sync_error", text: "Shopify did not answer", orderId: null, source: "system" });
    await event({ createdAt: 40, actorId: "u_gone", type: "note", text: "From someone who left" });
    const feed = await loadActivityFeed(db, WS, "u_me");
    expect(feed.items).toEqual([
      expect.objectContaining({ id: "e004", orderName: "#1001", actorName: null, actorId: "u_gone" }),
      expect.objectContaining({ id: "e003", orderId: null, orderName: null, actorName: null, type: "sync_error" }),
      expect.objectContaining({ id: "e002", orderName: "#1001", actorName: "other@example.com", type: "status" }),
      expect.objectContaining({ id: "e001", orderName: "#1001", actorName: "Jamie Rivers", mine: true }),
    ]);
  });
});

describe("markAllRead", () => {
  it("moves the member's last visit to now and never back", async () => {
    await event({ createdAt: 50, actorId: "u_other" });
    expect(await markAllRead(db, WS, "u_me", 100)).toEqual({ kind: "marked", lastSeenAt: 100 });
    expect((await loadActivityFeed(db, WS, "u_me")).unread).toBe(0);
    expect(await markAllRead(db, WS, "u_me", 60)).toEqual({ kind: "marked", lastSeenAt: 100 });
    // Only the caller's own record moves.
    const [other] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, "u_other"));
    expect(other.lastSeenAt).toBe(0);
  });

  it("has nothing to mark for someone who is not a member", async () => {
    expect(await markAllRead(db, WS, "u_boss", 100)).toEqual({ kind: "not-member" });
  });
});
