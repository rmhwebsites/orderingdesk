import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { openTestDb, seedOrder, seedWorkspace, snapshotOf } from "@/server/desk/test-helpers";
import { SHOPIFY_TAG_MAX, STATUS_LABEL_MAX } from "@/lib/status-label";
import {
  ECHO_WINDOW_MS,
  STATUS_TAG_PREFIX,
  applyShopifyMove,
  decideShopifyMove,
  evaluateShopifyTransitions,
  initialStatusFor,
  pushOrderStatus,
  shopifyStateOf,
  statusTag,
  type StatusRow,
} from "./status-sync";

// Two-way status (platform amendment section 4). Pure decisions first, then
// the database side, then the App -> Shopify push against a stubbed store.

const STATUSES: StatusRow[] = [
  { key: "new", label: "New", sort: 0, shopifyLink: null },
  { key: "processing", label: "Processing", sort: 1, shopifyLink: null },
  { key: "approved", label: "Approved", sort: 2, shopifyLink: null },
  { key: "shipped", label: "Shipped", sort: 3, shopifyLink: "fulfilled" },
  { key: "delivered", label: "Delivered", sort: 4, shopifyLink: "delivered" },
];

const unfulfilled = (tags = "") => snapshotOf({ fulfillmentStatus: "unfulfilled", delivered: false, tags });
const fulfilled = (tags = "") => snapshotOf({ fulfillmentStatus: "fulfilled", delivered: false, tags });
const delivered = (tags = "") => snapshotOf({ fulfillmentStatus: "fulfilled", delivered: true, tags });
const none = new Set<string>();

function decide(before: unknown, after: unknown, currentKey: string, recentlyHeld = none, statuses = STATUSES) {
  return decideShopifyMove({ before, after, currentKey, statuses, recentlyHeld });
}

describe("status tags", () => {
  it("is one tag per status label", () => {
    expect(STATUS_TAG_PREFIX).toBe("Ordering Desk: ");
    expect(statusTag("Shipped")).toBe("Ordering Desk: Shipped");
    // Shopify splits tags on commas, so a comma in a label cannot survive.
    expect(statusTag("Packed, waiting")).toBe("Ordering Desk: Packed waiting");
  });

  // Shopify allows 40 characters per order tag; labels are capped so that
  // the longest one still fits (src/server/desk/statuses.ts).
  it("fits Shopify's 40 character tag limit for the longest label allowed", () => {
    expect(SHOPIFY_TAG_MAX).toBe(40);
    expect(statusTag("w".repeat(STATUS_LABEL_MAX)).length).toBe(SHOPIFY_TAG_MAX);
  });
});

describe("shopifyStateOf", () => {
  it("maps the stored snapshot to the Shopify state a status can link to", () => {
    expect(shopifyStateOf(unfulfilled())).toBeNull();
    expect(shopifyStateOf(snapshotOf({ fulfillmentStatus: "partially fulfilled" }))).toBeNull();
    expect(shopifyStateOf(fulfilled())).toBe("fulfilled");
    expect(shopifyStateOf(delivered())).toBe("delivered");
    // A snapshot stored before delivered existed reads as not delivered.
    expect(shopifyStateOf(snapshotOf({ fulfillmentStatus: "fulfilled", delivered: undefined }))).toBe("fulfilled");
    expect(shopifyStateOf(null)).toBeNull();
    expect(shopifyStateOf("junk")).toBeNull();
  });
});

describe("initialStatusFor", () => {
  it("starts a new order at its tag, else its linked Shopify state, else the first status", () => {
    expect(initialStatusFor(unfulfilled(), STATUSES, "new")).toBe("new");
    expect(initialStatusFor(fulfilled(), STATUSES, "new")).toBe("shipped");
    expect(initialStatusFor(delivered(), STATUSES, "new")).toBe("delivered");
    expect(initialStatusFor(unfulfilled("vip, Ordering Desk: Approved"), STATUSES, "new")).toBe("approved");
    // Two status tags say nothing certain.
    expect(
      initialStatusFor(fulfilled("Ordering Desk: Approved, Ordering Desk: Processing"), STATUSES, "new"),
    ).toBe("shipped");
    // No delivered link: a delivered order is still fulfilled.
    const noDelivered = STATUSES.map((status) => ({ ...status, shopifyLink: status.key === "delivered" ? null : status.shopifyLink }));
    expect(initialStatusFor(delivered(), noDelivered, "new")).toBe("shipped");
    expect(initialStatusFor(fulfilled(), STATUSES.map((s) => ({ ...s, shopifyLink: null })), "new")).toBe("new");
  });
});

describe("decideShopifyMove", () => {
  it("moves forward to the linked status when Shopify newly reports the order fulfilled or delivered", () => {
    expect(decide(unfulfilled(), fulfilled(), "processing")).toEqual({ to: STATUSES[3], reason: "fulfilled" });
    expect(decide(fulfilled(), delivered(), "shipped")).toEqual({ to: STATUSES[4], reason: "delivered" });
    expect(decide(unfulfilled(), delivered(), "new")).toEqual({ to: STATUSES[4], reason: "delivered" });
  });

  it("never moves backward past a later status", () => {
    expect(decide(unfulfilled(), fulfilled(), "delivered")).toBeNull();
    expect(decide(unfulfilled(), fulfilled(), "shipped")).toBeNull();
  });

  it("acts on a change in Shopify, not on a state that was already there", () => {
    expect(decide(fulfilled(), fulfilled(), "new")).toBeNull();
    expect(decide(delivered(), delivered(), "processing")).toBeNull();
    // Shopify going back (a fulfillment canceled) never moves the status.
    expect(decide(fulfilled(), unfulfilled(), "shipped")).toBeNull();
    expect(decide(delivered(), fulfilled(), "delivered")).toBeNull();
  });

  it("falls back to the fulfilled link when no status is linked to delivered", () => {
    const noDelivered = STATUSES.map((status) => ({ ...status, shopifyLink: status.key === "delivered" ? null : status.shopifyLink }));
    expect(decide(unfulfilled(), delivered(), "new", none, noDelivered)).toEqual({
      to: noDelivered[3],
      reason: "delivered",
    });
    expect(decide(fulfilled(), delivered(), "shipped", none, noDelivered)).toBeNull();
  });

  it("adopts the status a person tagged in Shopify, either direction", () => {
    expect(decide(unfulfilled("Ordering Desk: Processing"), unfulfilled("Ordering Desk: Approved"), "processing")).toEqual({
      to: STATUSES[2],
      reason: "tag",
    });
    expect(decide(fulfilled("Ordering Desk: Shipped"), fulfilled("Ordering Desk: Processing"), "shipped")).toEqual({
      to: STATUSES[1],
      reason: "tag",
    });
    // Matching ignores case and surrounding space; other tags do not matter.
    expect(decide(unfulfilled("vip"), unfulfilled("vip,  ordering desk: approved "), "new")).toEqual({
      to: STATUSES[2],
      reason: "tag",
    });
    // A second status tag added next to the old one is the new choice.
    expect(
      decide(unfulfilled("Ordering Desk: Processing"), unfulfilled("Ordering Desk: Processing, Ordering Desk: Approved"), "processing"),
    ).toEqual({ to: STATUSES[2], reason: "tag" });
  });

  it("prefers the tag over a fulfillment that arrives in the same change", () => {
    expect(decide(unfulfilled("Ordering Desk: New"), fulfilled("Ordering Desk: Approved"), "new")).toEqual({
      to: STATUSES[2],
      reason: "tag",
    });
  });

  // Echo safety: the app's own writes come back from Shopify.
  it("ignores the app's own tag and fulfillment coming back", () => {
    // The app moved the order to Shipped, tagged it and fulfilled it.
    expect(decide(unfulfilled("Ordering Desk: Approved"), fulfilled("Ordering Desk: Shipped"), "shipped")).toBeNull();
    // A tag for a status the order held moments ago is an echo of an older
    // write that landed late, not a person's choice.
    expect(
      decide(unfulfilled(), unfulfilled("Ordering Desk: Shipped"), "processing", new Set(["shipped"])),
    ).toBeNull();
  });

  it("does nothing with an ambiguous, unknown or removed tag", () => {
    expect(
      decide(unfulfilled(), unfulfilled("Ordering Desk: Approved, Ordering Desk: Shipped"), "new"),
    ).toBeNull();
    expect(decide(unfulfilled(), unfulfilled("Ordering Desk: Nonsense"), "new")).toBeNull();
    expect(decide(unfulfilled("Ordering Desk: Approved"), unfulfilled(""), "approved")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Database side

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const TOKEN = "shpat_status_push_token_5c5c";
const ORDER_GID = "gid://shopify/Order/shop-o1";

async function setup(opts: { connection?: "ok" | "disabled" | "none" } = {}) {
  const { db, raw } = openTestDb();
  await seedWorkspace(db, WS);
  // test-helpers seeds New, Processing, Approved and Shipped (linked to
  // fulfilled); add Delivered after them.
  await db.insert(schema.statuses).values({
    id: `${WS}_st_delivered`,
    workspaceId: WS,
    key: "delivered",
    label: "Delivered",
    color: "green",
    sort: 4,
    shopifyLink: "delivered",
  });
  if ((opts.connection ?? "ok") !== "none") {
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impact-rentals.myshopify.com",
      encryptedToken: await encryptSecret(TOKEN, KEY, WS),
      status: opts.connection === "disabled" ? "disabled" : "ok",
    });
  }
  return { db, raw };
}

async function orderRow(db: Db, id = "o1") {
  const rows = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
  return rows[0];
}

async function orderEvents(db: Db, id = "o1") {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.workspaceId, WS), eq(schema.events.orderId, id)));
}

describe("applyShopifyMove", () => {
  it("moves the order with a shopify-sourced status event", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "processing" });
    const change = await applyShopifyMove(db, WS, "o1", "processing", STATUSES[3], "fulfilled", NOW);
    expect(change).toEqual({
      event: {
        id: expect.any(String),
        orderId: "o1",
        type: "status",
        text: "Status set to Shipped: Shopify reports the order fulfilled",
        actorId: null,
        meta: { from: "processing", to: "shipped", reason: "fulfilled" },
        createdAt: NOW,
        source: "shopify",
      },
      order: { id: "o1", statusKey: "shipped", statusSetBy: null, statusSetAt: NOW },
    });
    expect(await orderRow(db)).toMatchObject({ statusKey: "shipped", statusSetBy: null, statusSetAt: NOW });
    const events = await orderEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "status", source: "shopify", actorId: null });
  });

  it("words tag and delivered moves for the timeline", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const viaTag = await applyShopifyMove(db, WS, "o1", "shipped", STATUSES[1], "tag", NOW);
    expect(viaTag?.event.text).toBe("Status set to Processing from the Ordering Desk tag in Shopify");
    const viaDelivery = await applyShopifyMove(db, WS, "o1", "processing", STATUSES[4], "delivered", NOW + 1);
    expect(viaDelivery?.event.text).toBe("Status set to Delivered: Shopify reports the order delivered");
  });

  it("changes nothing when someone moved the order first", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
    expect(await applyShopifyMove(db, WS, "o1", "processing", STATUSES[3], "fulfilled", NOW)).toBeNull();
    expect((await orderRow(db)).statusKey).toBe("approved");
    expect(await orderEvents(db)).toHaveLength(0);
  });
});

describe("evaluateShopifyTransitions", () => {
  it("applies each landed snapshot change against the order's current status", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "processing" });
    await seedOrder(db, WS, { id: "o2", statusKey: "delivered" });
    const changes = await evaluateShopifyTransitions(
      db,
      WS,
      [
        { orderId: "o1", before: unfulfilled(), after: fulfilled() },
        { orderId: "o2", before: unfulfilled(), after: fulfilled() },
      ],
      NOW,
    );
    expect(changes.map((change) => change.order)).toEqual([
      { id: "o1", statusKey: "shipped", statusSetBy: null, statusSetAt: NOW },
    ]);
    expect((await orderRow(db, "o2")).statusKey).toBe("delivered");
  });

  it("treats a tag naming a status the order held within the echo window as an echo", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "processing" });
    await db.insert(schema.events).values({
      id: "e-recent",
      workspaceId: WS,
      orderId: "o1",
      type: "status",
      text: "Status set to Shipped",
      actorId: "user_1",
      meta: { from: "approved", to: "shipped" },
      createdAt: NOW - ECHO_WINDOW_MS + 1000,
      source: "app",
    });
    const transition = { orderId: "o1", before: unfulfilled(), after: unfulfilled("Ordering Desk: Shipped") };
    expect(await evaluateShopifyTransitions(db, WS, [transition], NOW)).toEqual([]);
    // Outside the window the same tag is a person's choice.
    expect(await evaluateShopifyTransitions(db, WS, [transition], NOW + 2000)).toHaveLength(1);
    expect((await orderRow(db)).statusKey).toBe("shipped");
  });

  it("reads nothing for changes that cannot move a status", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "processing" });
    const select = vi.spyOn(db, "select");
    expect(
      await evaluateShopifyTransitions(
        db,
        WS,
        [{ orderId: "o1", before: unfulfilled("vip"), after: unfulfilled("vip, rush") }],
        NOW,
      ),
    ).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// App -> Shopify

type ShopCall = { query: string; variables: Record<string, unknown> };

type StoreScript = {
  tags?: string[] | null;
  fulfillable?: string[];
  refuse?: Partial<Record<"tagsAdd" | "tagsRemove" | "fulfillmentCreate", string>>;
  status?: number;
  onCall?: (call: ShopCall) => void;
};

function store(script: StoreScript = {}) {
  const calls: ShopCall[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ShopCall;
    const call = { query: body.query, variables: body.variables };
    calls.push(call);
    script.onCall?.(call);
    if (script.status) {
      return new Response("{}", { status: script.status });
    }
    const refusal = (field: "tagsAdd" | "tagsRemove" | "fulfillmentCreate") =>
      script.refuse?.[field] ? [{ field: ["tags"], message: script.refuse[field] }] : [];
    let data: unknown;
    if (body.query.includes("tagsRemove(")) {
      data = { tagsRemove: { userErrors: refusal("tagsRemove") } };
    } else if (body.query.includes("tagsAdd(")) {
      data = { tagsAdd: { userErrors: refusal("tagsAdd") } };
    } else if (body.query.includes("fulfillmentOrders(")) {
      data = {
        order: {
          id: ORDER_GID,
          fulfillmentOrders: {
            nodes: [
              ...(script.fulfillable ?? ["gid://shopify/FulfillmentOrder/77"]).map((id) => ({
                id,
                status: "OPEN",
                supportedActions: [{ action: "CREATE_FULFILLMENT" }, { action: "HOLD" }],
              })),
              { id: "gid://shopify/FulfillmentOrder/1", status: "CLOSED", supportedActions: [] },
            ],
          },
        },
      };
    } else if (body.query.includes("fulfillmentCreate(")) {
      data = {
        fulfillmentCreate: {
          fulfillment: script.refuse?.fulfillmentCreate ? null : { id: "gid://shopify/Fulfillment/5", status: "SUCCESS" },
          userErrors: refusal("fulfillmentCreate"),
        },
      };
    } else if (body.query.includes("order(id: $id) { id tags }")) {
      data = { order: script.tags === null ? null : { id: ORDER_GID, tags: script.tags ?? [] } };
    } else {
      throw new Error("unexpected request: " + body.query);
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const kindOf = (call: ShopCall) =>
  call.query.includes("tagsRemove(")
    ? "tagsRemove"
    : call.query.includes("tagsAdd(")
      ? "tagsAdd"
      : call.query.includes("fulfillmentOrders(")
        ? "fulfillmentOrders"
        : call.query.includes("fulfillmentCreate(")
          ? "fulfillmentCreate"
          : "tags";

describe("pushOrderStatus", () => {
  it("writes the one status tag and fulfills a status linked to fulfilled, without emailing the customer", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const shop = store({ tags: ["vip", "Ordering Desk: Processing", "ordering desk: approved"] });
    const events = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW });

    expect(shop.calls.map((call) => [kindOf(call), call.variables])).toEqual([
      ["tags", { id: ORDER_GID }],
      ["tagsRemove", { id: ORDER_GID, tags: ["Ordering Desk: Processing", "ordering desk: approved"] }],
      ["tagsAdd", { id: ORDER_GID, tags: ["Ordering Desk: Shipped"] }],
      ["fulfillmentOrders", { id: ORDER_GID }],
      [
        "fulfillmentCreate",
        {
          fulfillment: {
            lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/77" }],
            notifyCustomer: false,
          },
        },
      ],
    ]);
    expect(events).toEqual([
      {
        id: expect.any(String),
        orderId: "o1",
        type: "shopify_write",
        text: "Shopify updated: tagged Ordering Desk: Shipped, marked fulfilled without emailing the customer",
        actorId: null,
        meta: { ok: true, tag: "Ordering Desk: Shipped", statusKey: "shipped", fulfillments: 1 },
        createdAt: NOW,
        source: "system",
      },
    ]);
    expect(await orderEvents(db)).toHaveLength(1);
  });

  it("fulfills every open fulfillment order, one fulfillment each", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const shop = store({
      tags: ["Ordering Desk: Shipped"],
      fulfillable: ["gid://shopify/FulfillmentOrder/77", "gid://shopify/FulfillmentOrder/78"],
    });
    const events = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW });
    expect(shop.calls.filter((call) => kindOf(call) === "fulfillmentCreate").map((call) => call.variables)).toEqual([
      { fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/77" }], notifyCustomer: false } },
      { fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/78" }], notifyCustomer: false } },
    ]);
    expect(events[0].text).toBe("Shopify updated: marked fulfilled without emailing the customer");
  });

  it("only tags a status with no Shopify link, and never fulfills for a Shopify-originated move", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
    await seedOrder(db, WS, { id: "o2", statusKey: "shipped" });
    const approved = store({ tags: [] });
    await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: approved.impl, now: () => NOW });
    expect(approved.calls.map(kindOf)).toEqual(["tags", "tagsAdd"]);
    const fromShopify = store({ tags: ["Ordering Desk: Approved"] });
    const events = await pushOrderStatus(db, env, WS, "o2", { fulfill: false, fetchImpl: fromShopify.impl, now: () => NOW });
    expect(fromShopify.calls.map(kindOf)).toEqual(["tags", "tagsRemove", "tagsAdd"]);
    expect(events[0].text).toBe("Shopify updated: tagged Ordering Desk: Shipped");
  });

  // Compare before writing: nothing to change means no request and no event.
  it("writes nothing when Shopify already shows the status", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
    const shop = store({ tags: ["vip", "Ordering Desk: Approved"] });
    expect(await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW })).toEqual([]);
    expect(shop.calls.map(kindOf)).toEqual(["tags"]);
    expect(await orderEvents(db)).toHaveLength(0);
  });

  it("records a refusal in the timeline and keeps the app's status", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
    const shop = store({ tags: [], refuse: { tagsAdd: "Access denied for tagsAdd field. Required access: `write_orders`." } });
    const events = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "shopify_write",
      source: "system",
      text: "Shopify was not updated: Access denied for tagsAdd field. Required access: `write_orders`. The status here is kept.",
      meta: { ok: false, tag: "Ordering Desk: Approved", statusKey: "approved", fulfillments: 0 },
    });
    expect(shop.calls.map(kindOf)).toEqual(["tags", "tagsAdd"]);
    expect((await orderRow(db)).statusKey).toBe("approved");
  });

  // The tag only shows the status in Shopify; fulfilling is what a status
  // linked to fulfilled is for, so a refused tag must not stop it.
  it("still fulfills when the tag write is refused, and says what landed", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const shop = store({ tags: [], refuse: { tagsAdd: "Tags is too long (maximum is 40 characters)" } });
    const [event] = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW });
    expect(shop.calls.map(kindOf)).toEqual(["tags", "tagsAdd", "fulfillmentOrders", "fulfillmentCreate"]);
    expect(event).toMatchObject({
      text: "Shopify was only partly updated (marked fulfilled without emailing the customer): Tags is too long (maximum is 40 characters). The status here is kept.",
      meta: { ok: false, fulfillments: 1 },
    });
    expect((await orderRow(db)).statusKey).toBe("shipped");
  });

  it("names both refusals when the tag and the fulfillment are both refused", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const shop = store({ tags: [], refuse: { tagsAdd: "Tag refused.", fulfillmentCreate: "Fulfillment order is on hold" } });
    const [event] = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW });
    expect(event.text).toBe(
      "Shopify was not updated: Tag refused; Fulfillment order is on hold. The status here is kept.",
    );
  });

  it("says what did land when the fulfillment is refused after the tag", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const shop = store({ tags: [], refuse: { fulfillmentCreate: "Fulfillment order is on hold" } });
    const [event] = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW });
    expect(event.text).toBe(
      "Shopify was only partly updated (tagged Ordering Desk: Shipped): Fulfillment order is on hold. The status here is kept.",
    );
    expect(event.meta).toMatchObject({ ok: false });
  });

  it("records Shopify being unreachable, or the order being gone", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
    const [down] = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: store({ status: 503 }).impl, now: () => NOW });
    expect(down.text).toBe("Shopify was not updated: Shopify responded with HTTP 503. The status here is kept.");
    const [gone] = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: store({ tags: null }).impl, now: () => NOW });
    expect(gone.text).toBe("Shopify was not updated: Shopify no longer has this order. The status here is kept.");
  });

  it("records unusable store credentials without contacting Shopify", async () => {
    const { db, raw } = await setup();
    raw.prepare("UPDATE store_connections SET encrypted_token = 'v1.bad.bad'").run();
    await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
    const shop = store();
    const [event] = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW });
    expect(shop.calls).toHaveLength(0);
    expect(event.text).toBe(
      "Shopify was not updated: the store credentials cannot be read; reconnect the store in Settings. The status here is kept.",
    );
  });

  it("does nothing for a workspace without a connected store", async () => {
    for (const connection of ["none", "disabled"] as const) {
      const { db } = await setup({ connection });
      await seedOrder(db, WS, { id: "o1", statusKey: "approved" });
      const shop = store();
      expect(await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: shop.impl, now: () => NOW })).toEqual([]);
      expect(shop.calls).toHaveLength(0);
      expect(await orderEvents(db)).toHaveLength(0);
    }
  });

  // Two quick changes push in parallel and may land out of order. A push
  // re-reads the status after writing and corrects the tag if it moved on.
  it("corrects the tag when the status changed while it was being written", async () => {
    const { db, raw } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    let tags = ["Ordering Desk: Approved"];
    let moved = false;
    const shop = store({
      onCall: (call) => {
        if (call.query.includes("tagsAdd(") && !moved) {
          moved = true;
          raw.prepare("UPDATE orders SET status_key = 'processing', status_set_at = ? WHERE id = 'o1'").run(NOW + 5);
        }
      },
    });
    // Serve the tags as they are after each write.
    const tracking = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as ShopCall;
      if (body.query.includes("order(id: $id) { id tags }")) {
        shop.calls.push({ query: body.query, variables: body.variables });
        return new Response(JSON.stringify({ data: { order: { id: ORDER_GID, tags } } }), { status: 200 });
      }
      const response = await shop.impl(input, init);
      const added = body.query.includes("tagsAdd(") ? (body.variables.tags as string[]) : [];
      const removed = body.query.includes("tagsRemove(") ? (body.variables.tags as string[]) : [];
      tags = [...tags.filter((tag) => !removed.includes(tag)), ...added];
      return response;
    }) as typeof fetch;

    const events = await pushOrderStatus(db, env, WS, "o1", { fulfill: true, fetchImpl: tracking, now: () => NOW });
    expect(tags).toEqual(["Ordering Desk: Processing"]);
    expect(events.map((event) => event.text)).toEqual([
      "Shopify updated: tagged Ordering Desk: Shipped, marked fulfilled without emailing the customer",
      "Shopify updated: tagged Ordering Desk: Processing",
    ]);
  });
});
