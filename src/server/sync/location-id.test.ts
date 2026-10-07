import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { openTestDb, seedWorkspace } from "../desk/test-helpers";
import { normalizeDrafts, normalizeOrders } from "../shopify/normalize";
import { upsertFetchedDraft } from "./drafts";
import { upsertFetchedOrder } from "./run";

// Cards record their Shopify company location (comprehensive design section
// 2) from the B2B purchasing entity, in both snapshot writers. A snapshot
// without one keeps what the card already knew.

const WS = "ws_impact";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

const company = (locationId: string) => ({
  __typename: "PurchasingCompany",
  company: { id: "gid://shopify/Company/7", name: "Example Rentals" },
  location: { id: `gid://shopify/CompanyLocation/${locationId}`, name: "Buford HQ" },
});

const draftNode = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/DraftOrder/12",
  legacyResourceId: "12",
  name: "#D12",
  status: "OPEN",
  createdAt: "2026-10-05T10:00:00Z",
  purchasingEntity: company("101"),
  lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  ...overrides,
});

const orderNode = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/9001",
  legacyResourceId: "9001",
  name: "#1234",
  createdAt: "2026-10-05T11:00:00Z",
  purchasingEntity: { __typename: "PurchasingCompany", location: { id: "gid://shopify/CompanyLocation/102" } },
  lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  ...overrides,
});

async function locationOf(db: Db, id: string) {
  const rows = await db.select({ locationId: schema.orders.locationId }).from(schema.orders).where(eq(schema.orders.id, id));
  return rows[0]?.locationId;
}

describe("orders.location_id", () => {
  it("is written from a draft's company location on insert and on change, and kept when a snapshot has none", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    const [draft] = normalizeDrafts([draftNode()]);
    const added = await upsertFetchedDraft(db, WS, draft, NOW, { silent: true });
    expect(added.kind).toBe("added");
    if (added.kind !== "added") return;
    expect(await locationOf(db, added.orderId)).toBe("101");

    const [moved] = normalizeDrafts([draftNode({ purchasingEntity: company("102") })]);
    expect((await upsertFetchedDraft(db, WS, moved, NOW + 1000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("102");

    const [plain] = normalizeDrafts([draftNode({ purchasingEntity: { __typename: "Customer" }, note2: "changed" })]);
    expect((await upsertFetchedDraft(db, WS, plain, NOW + 2000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("102");
  });

  it("is written from an order's purchasing entity on insert and update, and kept when the order has none", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    const [order] = normalizeOrders([orderNode()]);
    const added = await upsertFetchedOrder(db, WS, order, NOW);
    expect(added.kind).toBe("added");
    if (added.kind !== "added") return;
    expect(await locationOf(db, added.orderId)).toBe("102");

    const [plain] = normalizeOrders([orderNode({ purchasingEntity: { __typename: "Customer" }, note: "changed" })]);
    expect((await upsertFetchedOrder(db, WS, plain, NOW + 1000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("102");

    const [other] = normalizeOrders([
      orderNode({ purchasingEntity: { __typename: "PurchasingCompany", location: { id: "gid://shopify/CompanyLocation/103" } } }),
    ]);
    expect((await upsertFetchedOrder(db, WS, other, NOW + 2000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("103");
  });
});
