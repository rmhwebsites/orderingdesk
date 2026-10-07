import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { seedCancelledStatus } from "@/server/desk/test-helpers";

vi.mock("@/server/desk/edit-request", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/desk/edit-request")>();
  return { ...real, loadRequestEditor: vi.fn(), editRequest: vi.fn(), followEdit: vi.fn(async () => undefined) };
});

import { editRequest, loadRequestEditor } from "@/server/desk/edit-request";
import { WS, call, fakeShop, principalFor, setupMcp, toolDeps } from "../test-helpers";
import { confirmCancel, confirmEditRequest, prepareCancel, prepareEditRequest } from "./cancel-edit";

function cancelShop(total = "0.0") {
  let cancelled = false;
  return fakeShop({
    OrderCancelState: () => ({
      order: {
        id: "gid://shopify/Order/shop-o1",
        name: "#1001",
        cancelledAt: cancelled ? "2026-10-07T15:00:02Z" : null,
        displayFulfillmentStatus: "UNFULFILLED",
        currentTotalPriceSet: { shopMoney: { amount: total, currencyCode: "USD" } },
      },
    }),
    CancelOrder: () => {
      cancelled = true;
      return { orderCancel: { job: { id: "gid://shopify/Job/1", done: false }, orderCancelUserErrors: [] } };
    },
  });
}

describe("cancel through an AI app", () => {
  it("previews no email, no restock and no refund, then cancels once on a confirm that repeats the reason", async () => {
    const db = await setupMcp();
    await seedCancelledStatus(db, WS);
    const shop = cancelShop();
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl, sleep: async () => undefined });
    const prepared = (await call(prepareCancel, { order: "#1001", reason: "Duplicate order" }, deps)).data;
    expect(prepared.preview.summary).toBe("Cancel order #1001 in Shopify: no email to the customer, no restock, no refund. Status becomes Cancelled.");
    expect(prepared.confirm_with).toMatchObject({ tool: "confirm_cancel", order: "#1001", reason: "Duplicate order" });
    const done = await call(confirmCancel, { confirmation_id: prepared.confirmation_id, order: "#1001", reason: "Duplicate order" }, deps);
    expect(done.data).toMatchObject({ done: true, order: "#1001", status: "Cancelled", confirmed_by_shopify: true });
    expect(shop.ops().filter((op) => op === "CancelOrder")).toHaveLength(1);
    const entries = await db.select().from(schema.events).where(eq(schema.events.orderId, "o1"));
    expect(new Set(entries.map((entry) => entry.source))).toEqual(new Set(["ai"]));
  });

  it("refuses a request, an order that is not $0.00, and staff", async () => {
    const db = await setupMcp();
    await seedCancelledStatus(db, WS);
    expect((await call(prepareCancel, { order: "#D12", reason: "x" }, toolDeps(db))).data.error).toMatchObject({ code: "invalid_input" });
    const priced = await call(prepareCancel, { order: "#1001", reason: "x" }, toolDeps(db, principalFor(), { fetchImpl: cancelShop("12.00").impl }));
    expect(priced.data.error.message).toContain("$12.00");
    expect((await call(prepareCancel, { order: "#1001", reason: "x" }, toolDeps(db, principalFor("staff")))).data.error).toMatchObject({ code: "forbidden" });
  });
});

const EDITOR = {
  updatedAt: "2026-10-07T14:00:00Z",
  lines: [
    { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 0 },
    { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
  ],
  locationId: "101",
  locationName: "North Yard",
  locations: [
    { shopifyLocationId: "101", name: "North Yard" },
    { shopifyLocationId: "102", name: "Harbor Point" },
  ],
};

describe("edit a request through an AI app", () => {
  it("previews the changes from line numbers and a location name, then saves exactly that body via AI", async () => {
    const db = await setupMcp();
    vi.mocked(loadRequestEditor).mockResolvedValue({ kind: "editor", editor: EDITOR } as never);
    vi.mocked(editRequest).mockResolvedValue({ kind: "edited", event: { id: "e1" }, warning: null, statusChanges: [] } as never);
    const deps = toolDeps(db);
    const prepared = (await call(prepareEditRequest, { order: "#D12", changes: [{ line: 1, quantity: 1 }, { line: 2, quantity: 0 }], ship_to: "harbor point" }, deps)).data;
    expect(prepared.preview.summary).toBe(
      "Edit request #D12: Hard Hat (White): quantity 2 to 1; Removed Safety Vest (L); Ship to Harbor Point instead of North Yard",
    );
    const done = await call(confirmEditRequest, { confirmation_id: prepared.confirmation_id, order: "#D12" }, deps);
    expect(done.data).toMatchObject({ done: true, order: "#D12" });
    const [ctx, body] = vi.mocked(editRequest).mock.calls[0].slice(1, 3) as [Record<string, unknown>, Record<string, unknown>];
    expect(ctx).toMatchObject({ workspaceId: WS, orderId: "d1", role: "manager", via: { client: "claude" } });
    expect(body).toEqual({ updatedAt: EDITOR.updatedAt, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" });
  });

  it("refuses lines that do not exist, unknown locations and edits that change nothing", async () => {
    const db = await setupMcp();
    vi.mocked(loadRequestEditor).mockResolvedValue({ kind: "editor", editor: EDITOR } as never);
    const deps = toolDeps(db);
    expect((await call(prepareEditRequest, { order: "#D12", changes: [{ line: 3, quantity: 1 }] }, deps)).data.error.message).toContain("this request has 2 lines");
    expect((await call(prepareEditRequest, { order: "#D12", changes: [], ship_to: "Nowhere" }, deps)).data.error.message).toContain("North Yard, Harbor Point");
    expect((await call(prepareEditRequest, { order: "#D12", changes: [{ line: 1, quantity: 2 }] }, deps)).data.error.message).toBe("Nothing would change.");
  });

  it("reports a request edited in Shopify since the preview as changed", async () => {
    const db = await setupMcp();
    vi.mocked(loadRequestEditor).mockResolvedValue({ kind: "editor", editor: EDITOR } as never);
    vi.mocked(editRequest).mockResolvedValue({ kind: "refused", status: 409, error: "This request changed in Shopify. Review it again.", editor: EDITOR } as never);
    const deps = toolDeps(db);
    const prepared = (await call(prepareEditRequest, { order: "#D12", changes: [{ line: 1, quantity: 1 }] }, deps)).data;
    const result = await call(confirmEditRequest, { confirmation_id: prepared.confirmation_id, order: "#D12" }, deps);
    expect(result.data.error).toMatchObject({ code: "changed" });
    const action = (await db.select().from(schema.aiActions).where(and(eq(schema.aiActions.tool, "edit"))))[0];
    expect(action).toMatchObject({ status: "failed", outcome: "changed" });
  });
});
