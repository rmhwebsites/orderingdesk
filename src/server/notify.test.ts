import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { normalizeOrders } from "@/server/shopify/normalize";
import { upsertFetchedOrder } from "@/server/sync/run";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace, snapshotOf } from "@/server/desk/test-helpers";
import type { PushNotice, PushTarget } from "./push";

// The fan-out against an in-memory database. The push transport is
// stubbed (src/server/push.test.ts covers sending, encryption and the
// 404 / 410 cleanup) so each device's notice can be read here; email goes
// to a stub EMAIL binding.
const pushed: Array<{ target: PushTarget; notice: PushNotice }> = [];
vi.mock("./push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./push")>();
  return {
    ...actual,
    sendPushToTargets: vi.fn(async (_db: unknown, _env: unknown, targets: PushTarget[], noticeFor: (t: PushTarget) => PushNotice | null) => {
      let sent = 0;
      for (const target of targets) {
        const notice = noticeFor(target);
        if (notice) {
          pushed.push({ target, notice });
          sent++;
        }
      }
      return { sent, gone: 0, failed: 0 };
    }),
  };
});

const { notifyActivity, notifyNewOrders, notifyPoSent, newOrderNotice, NEW_ORDER_MAX_AGE_MS, DIGEST_AFTER } = await import("./notify");
const { sendPushToTargets } = await import("./push");

const NOW = Date.parse("2026-10-04T15:00:00.000Z");
const WS = "ws_impact";
const sent: Array<{ from: unknown; to: unknown; subject: string; html: string; replyTo?: unknown }> = [];
const emailBinding = {
  send: vi.fn(async (message: { from: unknown; to: unknown; subject: string; html: string; replyTo?: unknown }) => {
    sent.push(message);
    return { messageId: `m${sent.length}` };
  }),
};
const env = {
  APP_URL: "https://orderingdesk.com",
  EMAIL_FROM: "Ordering Desk <orders@orderingdesk.com>",
  EMAIL: emailBinding,
  VAPID_PUBLIC_KEY: "pub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:ops@example.com",
} as unknown as CloudflareEnv;
const opts = { now: () => NOW };

let db: Db;

async function subscribe(id: string, userId: string, host: string | null) {
  await db.insert(schema.pushSubscriptions).values({
    id,
    userId,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: "k", auth: "a" },
    createdAt: 1,
    host,
  });
}

async function prefs(userId: string, values: { pushNewOrders?: boolean; emailNewOrders?: boolean; pushAllActivity?: boolean }) {
  await db.insert(schema.notificationPrefs).values({ id: `p_${userId}`, userId, workspaceId: WS, ...values });
}

async function order(id: string, overrides: { createdAt?: number; snapshot?: Record<string, unknown>; name?: string } = {}) {
  await seedOrder(db, WS, {
    id,
    name: overrides.name ?? `#${id}`,
    createdAt: overrides.createdAt ?? NOW - 3600000,
    shopify: snapshotOf({
      name: overrides.name ?? `#${id}`,
      shipping: { name: "Riley Oakes", a1: "12 Harbour Rd", a2: "", city: "Halifax", prov: "NS", zip: "B3H 1A1", country: "CA" },
      ...overrides.snapshot,
    }),
  });
}

beforeEach(async () => {
  pushed.length = 0;
  sent.length = 0;
  emailBinding.send.mockClear();
  vi.mocked(sendPushToTargets).mockClear();
  db = openTestDb().db;
  await seedWorkspace(db, WS);
  await db
    .update(schema.workspaces)
    .set({ name: "IMPACT Rentals", customDomain: "orders.impactrentals.store", customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, WS));
  await db
    .update(schema.workspaceSettings)
    .set({ notificationEmails: ["orders@impactrentals.store", "Staff@Example.com"], replyTo: "office@impactrentals.store" })
    .where(eq(schema.workspaceSettings.workspaceId, WS));
  await seedWorkspace(db, "ws_other");
  for (const [id, email] of [
    ["u_manager", "manager@example.com"],
    ["u_staff", "staff@example.com"],
    ["u_quiet", "quiet@example.com"],
    ["u_all", "all@example.com"],
    ["u_outsider", "outsider@example.com"],
  ]) {
    await seedUser(db, id, email);
  }
  await seedMember(db, WS, "u_manager", "manager");
  await seedMember(db, WS, "u_staff", "staff");
  await seedMember(db, WS, "u_quiet", "staff");
  await seedMember(db, WS, "u_all", "staff", "shopify");
  await seedMember(db, "ws_other", "u_outsider", "manager");
  await prefs("u_quiet", { pushNewOrders: false, emailNewOrders: false });
  await prefs("u_all", { pushAllActivity: true });
  await subscribe("s_manager_phone", "u_manager", "orders.impactrentals.store");
  await subscribe("s_manager_laptop", "u_manager", "orderingdesk.com");
  await subscribe("s_staff", "u_staff", null);
  await subscribe("s_quiet", "u_quiet", "orderingdesk.com");
  await subscribe("s_all", "u_all", "orderingdesk.com");
  await subscribe("s_outsider", "u_outsider", "orderingdesk.com");
});

describe("newOrderNotice", () => {
  it("carries the order number, the customer's first name, the total and the link only", () => {
    const notice = newOrderNotice(
      { id: "o1", name: "#1001", customerName: "Riley Oakes", total: "120.00", currency: "CAD", items: [] },
      { workspaceName: "IMPACT Rentals", ownHost: true, url: "https://orders.impactrentals.store/?order=o1" },
    );
    expect(notice).toEqual({
      title: "New order #1001",
      body: "Riley, CA$120.00",
      url: "https://orders.impactrentals.store/?order=o1",
      tag: "order-o1",
    });
  });

  it("names the workspace on the hub, which serves many", () => {
    const notice = newOrderNotice(
      { id: "o1", name: "#1001", customerName: "", total: "120.00", currency: "CAD", items: [] },
      { workspaceName: "IMPACT Rentals", ownHost: false, url: "https://orderingdesk.com/w/impact?order=o1" },
    );
    expect(notice.body).toBe("IMPACT Rentals. CA$120.00");
  });
});

describe("notifyNewOrders", () => {
  it("pushes to members who allow it and emails the list plus members who allow it, once each", async () => {
    await order("o1");
    const result = await notifyNewOrders(db, env, WS, ["o1"], opts);
    expect(result).toMatchObject({ claimed: 1, announced: ["o1"], emailed: 4 });

    // Push: manager (both devices), staff, the all-activity member; not
    // the member who turned new-order push off, not another workspace's.
    expect(pushed.map((entry) => entry.target.id).sort()).toEqual(["s_all", "s_manager_laptop", "s_manager_phone", "s_staff"]);
    // Each link opens the order on the host that device subscribed on.
    const link = (id: string) => pushed.find((entry) => entry.target.id === id)?.notice.url;
    expect(link("s_manager_phone")).toBe("https://orders.impactrentals.store/?order=o1");
    expect(link("s_manager_laptop")).toBe("https://orderingdesk.com/w/ws_impact?order=o1");
    expect(link("s_staff")).toBe("https://orderingdesk.com/w/ws_impact?order=o1");

    // Email: the notification list plus opted-in members, deduplicated
    // whatever the case, one message per address.
    expect(sent.map((message) => message.to).sort()).toEqual([
      ["all@example.com"],
      ["manager@example.com"],
      ["orders@impactrentals.store"],
      ["staff@example.com"],
    ]);
    for (const message of sent) {
      expect(message.subject).toBe("New order #o1 from Riley Oakes");
      // The workspace's name on the platform address until its own sender
      // is verified, with the workspace reply-to.
      expect(message.from).toEqual({ name: "IMPACT Rentals", email: "orders@orderingdesk.com" });
      expect(message.replyTo).toBe("office@impactrentals.store");
      expect(message.html).toContain('href="https://orders.impactrentals.store/?order=o1"');
    }
  });

  it("uses the workspace's own verified sender", async () => {
    await db
      .update(schema.workspaces)
      .set({ sendingVerifiedAt: 5 })
      .where(eq(schema.workspaces.id, WS));
    await order("o1");
    await notifyNewOrders(db, env, WS, ["o1"], opts);
    expect(sent[0].from).toEqual({ name: "IMPACT Rentals", email: "accounts@orders.impactrentals.store" });
  });

  it("keeps customer emails, addresses and last names out of every push", async () => {
    await order("o1", { snapshot: { email: "riley.oakes@example.com" } });
    await notifyNewOrders(db, env, WS, ["o1"], opts);
    for (const { notice } of pushed) {
      const text = JSON.stringify(notice);
      expect(text).not.toContain("riley.oakes@example.com");
      expect(text).not.toContain("Harbour");
      expect(text).not.toContain("B3H");
      expect(text).not.toContain("Oakes");
      expect(Object.keys(notice).sort()).toEqual(["body", "tag", "title", "url"]);
    }
  });

  it("announces an order exactly once, however many callers race to announce it", async () => {
    await order("o1");
    const [a, b] = await Promise.all([notifyNewOrders(db, env, WS, ["o1"], opts), notifyNewOrders(db, env, WS, ["o1"], opts)]);
    expect([a.announced, b.announced].flat()).toEqual(["o1"]);
    await notifyNewOrders(db, env, WS, ["o1"], opts);
    expect(pushed).toHaveLength(4);
    expect(sent).toHaveLength(4);
  });

  it("announces once when the cron sync and a webhook land the same order", async () => {
    const [node] = normalizeOrders([
      {
        id: "gid://shopify/Order/9001",
        name: "#9001",
        createdAt: new Date(NOW - 60000).toISOString(),
        customer: { displayName: "Riley Oakes" },
        currentTotalPriceSet: { shopMoney: { amount: "120.00", currencyCode: "CAD" } },
        lineItems: { nodes: [] },
      },
    ]);
    // Both paths write through upsertFetchedOrder's claim rule; whichever
    // lands second sees the order as known.
    const [webhook, cron] = await Promise.all([upsertFetchedOrder(db, WS, node, NOW), upsertFetchedOrder(db, WS, node, NOW + 1)]);
    const addedIds = [webhook, cron].flatMap((outcome) => (outcome.kind === "added" ? [outcome.orderId] : []));
    expect(addedIds).toHaveLength(1);
    // Each path notifies what it saw land; even a duplicate report of the
    // same id (a retried run) announces nothing twice.
    await Promise.all([
      notifyNewOrders(db, env, WS, addedIds, opts),
      notifyNewOrders(db, env, WS, addedIds, opts),
    ]);
    expect(new Set(pushed.map((entry) => entry.notice.title))).toEqual(new Set(["New order #9001"]));
    expect(pushed).toHaveLength(4);
    expect(sent).toHaveLength(4);
  });

  it("claims but does not announce orders older than a day (a first sync's backfill)", async () => {
    await order("old", { createdAt: NOW - NEW_ORDER_MAX_AGE_MS - 1 });
    const result = await notifyNewOrders(db, env, WS, ["old"], opts);
    expect(result).toMatchObject({ claimed: 1, announced: [] });
    expect(pushed).toEqual([]);
    expect(sent).toEqual([]);
    const [row] = await db.select({ notifiedAt: schema.orders.notifiedAt }).from(schema.orders).where(eq(schema.orders.id, "old"));
    expect(row.notifiedAt).toBe(NOW);
  });

  it("sends a notification and an email per order for a few orders at once", async () => {
    await order("o1");
    await order("o2", { createdAt: NOW - 60000 });
    await notifyNewOrders(db, env, WS, ["o1", "o2"], opts);
    const phone = pushed.filter((entry) => entry.target.id === "s_manager_phone").map((entry) => entry.notice.tag);
    expect(phone).toEqual(["order-o2", "order-o1"]);
    expect(sent.filter((message) => (message.to as string[])[0] === "manager@example.com").map((message) => message.subject)).toEqual([
      "New order #o2 from Riley Oakes",
      "New order #o1 from Riley Oakes",
    ]);
  });

  it("sends one summary instead of a flood when many orders land at once", async () => {
    const ids = Array.from({ length: DIGEST_AFTER + 2 }, (_, i) => `o${i}`);
    for (const id of ids) {
      await order(id);
    }
    await notifyNewOrders(db, env, WS, ids, opts);
    expect(pushed).toHaveLength(4);
    expect(pushed[0].notice.title).toBe(`${ids.length} new orders`);
    expect(pushed.find((entry) => entry.target.id === "s_manager_phone")?.notice.url).toBe("https://orders.impactrentals.store/");
    expect(sent).toHaveLength(4);
    expect(sent[0].subject).toBe(`${ids.length} new orders in IMPACT Rentals`);
  });

  it("ignores orders of another workspace", async () => {
    await seedOrder(db, "ws_other", { id: "foreign", createdAt: NOW });
    expect(await notifyNewOrders(db, env, WS, ["foreign"], opts)).toMatchObject({ claimed: 0, announced: [] });
    expect(pushed).toEqual([]);
  });

  it("never throws: a failing email or push is logged and the rest go on", async () => {
    await order("o1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emailBinding.send.mockRejectedValueOnce(new Error("refused"));
    vi.mocked(sendPushToTargets).mockRejectedValueOnce(new Error("push down"));
    const result = await notifyNewOrders(db, env, WS, ["o1"], opts);
    expect(result.emailed).toBe(3);
    // Logs never carry an address.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@/);
    warn.mockRestore();
  });

  it("does nothing for an empty list", async () => {
    expect(await notifyNewOrders(db, env, WS, [], opts)).toEqual({ claimed: 0, announced: [], pushed: 0, emailed: 0 });
  });
});

describe("notifyActivity", () => {
  const event = (overrides: Partial<import("./desk/shapes").EventView> = {}) => ({
    id: "e1",
    orderId: "o1",
    type: "status" as const,
    text: "Status set to Shipped",
    actorId: "u_manager",
    meta: { from: "new", to: "shipped" },
    createdAt: NOW,
    source: "app" as const,
    ...overrides,
  });

  it("pushes status changes by someone else to members who opted into all activity", async () => {
    await order("o1", { name: "#1001" });
    await notifyActivity(db, env, WS, event(), opts);
    expect(pushed.map((entry) => entry.target.id)).toEqual(["s_all"]);
    expect(pushed[0].notice).toEqual({
      title: "Order #1001",
      body: "IMPACT Rentals. Status set to Shipped",
      url: "https://orderingdesk.com/w/ws_impact?order=o1",
      tag: "order-o1-activity",
    });
    expect(sent).toEqual([]);
  });

  it("does not push someone their own change", async () => {
    await order("o1");
    await notifyActivity(db, env, WS, event({ actorId: "u_all" }), opts);
    expect(pushed).toEqual([]);
  });

  it("says a note was added without its text", async () => {
    await order("o1");
    await notifyActivity(db, env, WS, event({ type: "note", text: "Customer called: gate code 4411", meta: null }), opts);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].notice.body).toBe("IMPACT Rentals. New note");
    expect(JSON.stringify(pushed[0].notice)).not.toContain("4411");
  });

  it("stays in-app for everything else", async () => {
    await order("o1");
    for (const type of ["order_new", "shopify_write", "sync_error", "po_draft"] as const) {
      await notifyActivity(db, env, WS, event({ type }), opts);
    }
    expect(pushed).toEqual([]);
  });
});

describe("notifyPoSent", () => {
  it("pushes and emails the new-order audience, but not the sender's own devices", async () => {
    await order("o1", { name: "#1001" });
    const result = await notifyPoSent(
      db,
      env,
      WS,
      { poId: "po1", poNumber: "IMP-2026-0041", orderId: "o1", orderName: "#1001", vendorName: "North Supply", actorId: "u_manager" },
      opts,
    );
    expect(pushed.map((entry) => entry.target.id).sort()).toEqual(["s_all", "s_staff"]);
    expect(pushed[0].notice.title).toBe("Purchase order IMP-2026-0041 sent");
    expect(result.emailed).toBe(4);
    expect(sent.map((message) => message.subject)).toEqual(Array(4).fill("Purchase order IMP-2026-0041 sent to North Supply"));
  });
});
