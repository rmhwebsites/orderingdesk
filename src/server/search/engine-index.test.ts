import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { normalizeDrafts, normalizeOrders } from "@/server/shopify/normalize";
import { upsertFetchedDraft } from "@/server/sync/drafts";
import { upsertFetchedOrder } from "@/server/sync/run";
import { openTestDb, seedWorkspace } from "@/server/desk/test-helpers";
import { syncedOrderIds } from "./index-orders";

const WS = "ws_impact";
const NOW = Date.parse("2026-10-05T14:00:00.000Z");

describe("syncedOrderIds", () => {
  it("lists every card a pass touched once, both sides of a merge included", () => {
    expect(
      syncedOrderIds({
        addedOrderIds: ["a"],
        updatedOrderIds: ["b", "a"],
        statusChanges: [{ order: { id: "c" } }, { order: { id: "b" } }],
        mergedOrders: [{ fromId: "gone", toId: "d" }],
      }),
    ).toEqual(["a", "b", "c", "gone", "d"]);
    expect(syncedOrderIds({ addedOrderIds: [], updatedOrderIds: [] })).toEqual([]);
  });
});

describe("the webhook entry points", () => {
  it("index an order the moment it lands, with its requester", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    const [order] = normalizeOrders([
      {
        id: "gid://shopify/Order/5001",
        legacyResourceId: "5001",
        name: "#1001",
        createdAt: "2026-10-05T13:00:00Z",
        email: "riley@example.com",
        customer: { id: "gid://shopify/Customer/77", displayName: "Riley Oakes" },
        lineItems: { nodes: [{ title: "Hard Hat", quantity: 1, sku: "HH-1", variantTitle: "White" }], pageInfo: { hasNextPage: false } },
      },
    ]);
    const outcome = await upsertFetchedOrder(db, WS, order, NOW);
    expect(outcome.kind).toBe("added");
    const rows = await db.select().from(schema.orderSearch);
    expect(rows).toHaveLength(1);
    expect(rows[0].haystack).toContain("hard hat");
    expect(rows[0].kind).toBe("order");
    const [person] = await db.select().from(schema.people);
    expect(person).toMatchObject({ shopifyCustomerId: "77", name: "Riley Oakes" });
    expect(rows[0].requesterId).toBe(person.id);
  });

  it("index a request the moment its draft lands", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    const [draft] = normalizeDrafts([
      {
        id: "gid://shopify/DraftOrder/12",
        legacyResourceId: "12",
        name: "#D12",
        status: "OPEN",
        createdAt: "2026-10-05T13:00:00Z",
        customer: { id: "gid://shopify/Customer/78", displayName: "Jordan Vale" },
        lineItems: { nodes: [{ title: "Business Cards", quantity: 1, sku: "BC-1" }], pageInfo: { hasNextPage: false } },
      },
    ]);
    const outcome = await upsertFetchedDraft(db, WS, draft, NOW);
    expect(outcome.kind).toBe("added");
    const [row] = await db.select().from(schema.orderSearch);
    expect(row).toMatchObject({ kind: "draft" });
    expect(row.haystack).toContain("#d12");
    const card = await db.select().from(schema.orders).where(eq(schema.orders.id, row.orderId));
    expect(card).toHaveLength(1);
  });
});
