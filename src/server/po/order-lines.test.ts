import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { openTestDb, seedDraft, snapshotOf } from "@/server/desk/test-helpers";
import { orderLinesForPo } from "./order-lines";
import { ORDER, seedPoWorkspace, WS } from "./test-helpers";

// The lines a new purchase order starts from. A snapshot that holds every
// line item is used as is; one marked itemsTruncated is never used: the
// full list comes from Shopify, or the prefill is refused with the reason.

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const env = { ENCRYPTION_KEY: KEY } as unknown as CloudflareEnv;

let db: Db;

beforeEach(async () => {
  db = openTestDb().db;
  await seedPoWorkspace(db);
});

async function connect() {
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: await encryptSecret("shpat_test", KEY, WS),
    authMode: "legacy_token",
  });
}

async function truncate(items: unknown[]) {
  await db
    .update(schema.orders)
    .set({ shopify: snapshotOf({ items, itemsTruncated: true }) })
    .where(eq(schema.orders.id, ORDER));
}

function shopifyPage(count: number) {
  return new Response(
    JSON.stringify({
      data: {
        order: {
          lineItems: {
            nodes: Array.from({ length: count }, (_, i) => ({
              title: `Item ${i + 1}`,
              quantity: 2,
              sku: `S-${i + 1}`,
              variantTitle: i === 0 ? "Large" : "",
              originalUnitPriceSet: { shopMoney: { amount: "1.00" } },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  );
}

describe("orderLinesForPo", () => {
  it("uses a complete stored snapshot without asking Shopify", async () => {
    await db.update(schema.orders).set({ shopify: snapshotOf({ itemsTruncated: false }) }).where(eq(schema.orders.id, ORDER));
    const fetchImpl = (async () => {
      throw new Error("no request expected");
    }) as unknown as typeof fetch;
    expect(await orderLinesForPo(db, env, { workspaceId: WS, orderId: ORDER }, { fetchImpl })).toEqual({
      kind: "ok",
      source: "stored",
      lines: [{ description: "Hard Hat (White)", sku: "HH-1", quantity: 2, unitCost: null }],
    });
  });

  it("fetches the full list from Shopify when the snapshot is partial", async () => {
    await connect();
    await truncate([{ title: "Only the first", qty: 1, price: "1.00", sku: "", variant: "" }]);
    const requests: string[] = [];
    const fetchImpl = (async (url: string) => {
      requests.push(url);
      return shopifyPage(60);
    }) as unknown as typeof fetch;
    const result = await orderLinesForPo(db, env, { workspaceId: WS, orderId: ORDER }, { fetchImpl });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.source).toBe("shopify");
      expect(result.lines).toHaveLength(60);
      expect(result.lines[0]).toEqual({ description: "Item 1 (Large)", sku: "S-1", quantity: 2, unitCost: null });
    }
    expect(requests).toEqual(["https://impact-rentals.myshopify.com/admin/api/2026-10/graphql.json"]);
  });

  it("treats a snapshot without the marker as partial", async () => {
    await db.update(schema.orders).set({ shopify: { ...snapshotOf(), itemsTruncated: undefined } }).where(eq(schema.orders.id, ORDER));
    const result = await orderLinesForPo(db, env, { workspaceId: WS, orderId: ORDER });
    expect(result).toMatchObject({ kind: "unavailable", error: expect.stringContaining("no Shopify store is connected") });
  });

  it("refuses the prefill, with the reason, when the full list cannot be read", async () => {
    await truncate([]);
    expect(await orderLinesForPo(db, env, { workspaceId: WS, orderId: ORDER })).toMatchObject({ kind: "unavailable" });

    await connect();
    const failing = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect(await orderLinesForPo(db, env, { workspaceId: WS, orderId: ORDER }, { fetchImpl: failing })).toMatchObject({
      kind: "unavailable",
      error: expect.stringContaining("HTTP 503"),
    });

    const tooMany = (async () => shopifyPage(201)) as unknown as typeof fetch;
    expect(await orderLinesForPo(db, env, { workspaceId: WS, orderId: ORDER }, { fetchImpl: tooMany })).toMatchObject({
      kind: "unavailable",
      error: expect.stringContaining("200 lines"),
    });
  });

  it("answers not-found for an order outside the workspace", async () => {
    expect((await orderLinesForPo(db, env, { workspaceId: WS, orderId: "o_other" })).kind).toBe("not-found");
  });

  it("offers no lines for a request that is still a draft", async () => {
    await seedDraft(db, WS, { id: "d1" });
    expect(await orderLinesForPo(db, env, { workspaceId: WS, orderId: "d1" })).toEqual({
      kind: "draft",
      error: "Approve the request first. A purchase order needs the Shopify order.",
    });
  });
});
