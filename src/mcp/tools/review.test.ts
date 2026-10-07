import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { draftSnapshotOf } from "@/server/desk/test-helpers";
import { beforeApprove, call, draftNode, fakeShop, principalFor, setupMcp, toolDeps } from "../test-helpers";
import { confirmApprove, confirmReject, prepareApprove, prepareReject } from "./review";

const completed = () => ({
  draftOrderComplete: {
    draftOrder: draftNode({
      status: "COMPLETED",
      completedAt: "2026-10-07T15:00:01Z",
      order: { id: "gid://shopify/Order/9001", legacyResourceId: "9001", name: "#1234" },
    }),
    userErrors: [],
  },
});

describe("approve through an AI app", () => {
  // Owner decision 4 (Oct 7): Approve never warns about proofs, even for a
  // personalized request placed through AI.
  it("previews the $0 draft with no proof warning, then completes it once on confirm", async () => {
    const db = await setupMcp();
    await db
      .update(schema.orders)
      .set({
        shopify: draftSnapshotOf({
          shopifyDraftId: "12",
          name: "#D12",
          tags: "via AI",
          items: [{ title: "Business cards", qty: 1, price: "0.00", sku: "BC-1", variant: "", custom: false, props: [{ key: "Full Name", value: "Jordan Vale" }] }],
        }),
      })
      .where(eq(schema.orders.id, "d1"));
    const shop = fakeShop({ DraftBeforeApprove: () => beforeApprove(), ApproveDraft: () => completed() });
    const afterWork: (() => Promise<unknown>)[] = [];
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl, sleep: async () => undefined, after: (work) => afterWork.push(work) });
    const prepared = (await call(prepareApprove, { order: "#D12" }, deps)).data;
    expect(prepared.preview.summary).toContain("Approve request #D12");
    expect(JSON.stringify([prepared.preview, prepared.warnings]).toLowerCase()).not.toContain("proof");
    expect(prepared.confirm_with).toEqual({ tool: "confirm_approve", confirmation_id: prepared.confirmation_id, order: "#D12" });
    const done = await call(confirmApprove, { confirmation_id: prepared.confirmation_id, order: "#D12" }, deps);
    expect(done.data).toMatchObject({ done: true, order: "#1234", from_request: "#D12" });
    expect(shop.ops()).toEqual(["DraftBeforeApprove", "DraftBeforeApprove", "ApproveDraft"]);
    const row = (await db.select().from(schema.orders).where(eq(schema.orders.id, "d1")))[0];
    expect(row).toMatchObject({ shopifyOrderId: "9001", statusKey: "approved" });
    const status = (await db.select().from(schema.events).where(and(eq(schema.events.orderId, "d1"), eq(schema.events.type, "status"))))[0];
    expect(status).toMatchObject({ source: "ai" });
    expect(afterWork).toHaveLength(1);
  });

  it("refuses a draft that does not total $0.00 at preview time, sending nothing", async () => {
    const db = await setupMcp();
    const shop = fakeShop({ DraftBeforeApprove: () => beforeApprove("48.00") });
    const { data } = await call(prepareApprove, { order: "#D12" }, toolDeps(db, principalFor(), { fetchImpl: shop.impl }));
    expect(data.error).toMatchObject({ code: "refused" });
    expect(data.error.message).toContain("$48.00");
    expect(shop.ops()).toEqual(["DraftBeforeApprove"]);
  });

  it("refuses to approve a request that changed since the preview", async () => {
    const db = await setupMcp();
    const shop = fakeShop({ DraftBeforeApprove: () => beforeApprove(), ApproveDraft: () => completed() });
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl });
    const prepared = (await call(prepareApprove, { order: "#D12" }, deps)).data;
    await db.update(schema.orders).set({ shopify: draftSnapshotOf({ shopifyDraftId: "12", name: "#D12", total: "12.00" }) }).where(eq(schema.orders.id, "d1"));
    const changed = await call(confirmApprove, { confirmation_id: prepared.confirmation_id, order: "#D12" }, deps);
    expect(changed.data.error).toMatchObject({ code: "changed" });
    expect(shop.ops()).not.toContain("ApproveDraft");
  });

  it("is for managers, even when called directly", async () => {
    const db = await setupMcp();
    const { data } = await call(prepareApprove, { order: "#D12" }, toolDeps(db, principalFor("staff")));
    expect(data.error).toMatchObject({ code: "forbidden" });
  });
});

describe("reject through an AI app", () => {
  it("previews the reason, then rejects on a confirm that repeats it", async () => {
    const db = await setupMcp();
    const deps = toolDeps(db);
    const prepared = (await call(prepareReject, { order: "#D12", reason: "Not in this quarter's budget." }, deps)).data;
    expect(prepared.preview).toMatchObject({ reason: { untrusted: "Not in this quarter's budget." } });
    const wrong = await call(confirmReject, { confirmation_id: prepared.confirmation_id, order: "#D12", reason: "No." }, deps);
    expect(wrong.data.error).toMatchObject({ code: "mismatch" });
    const done = await call(confirmReject, { confirmation_id: prepared.confirmation_id, order: "#D12", reason: "Not in this quarter's budget." }, deps);
    expect(done.data).toMatchObject({ done: true, order: "#D12", status: "Rejected" });
    const notes = await db.select().from(schema.events).where(and(eq(schema.events.orderId, "d1"), eq(schema.events.type, "note")));
    expect(notes.map((note) => [note.text, note.source])).toEqual([["Not in this quarter's budget.", "ai"]]);
  });

  it("refuses an order, and a request already rejected", async () => {
    const db = await setupMcp();
    expect((await call(prepareReject, { order: "#1001", reason: "x" }, toolDeps(db))).data.error).toMatchObject({ code: "invalid_input" });
    await db.update(schema.orders).set({ statusKey: "rejected" }).where(eq(schema.orders.id, "d1"));
    expect((await call(prepareReject, { order: "#D12", reason: "x" }, toolDeps(db))).data.error).toMatchObject({ code: "invalid_input" });
  });
});
