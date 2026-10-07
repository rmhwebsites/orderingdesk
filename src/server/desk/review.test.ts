import { describe, it, expect, vi, type Mock } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { NOTE_MAX } from "@/lib/limits";
import {
  approveRequest,
  followApproval,
  followRejection,
  rejectRequest,
  REVIEW_READY_TRIES,
  REVIEW_RETRY_MS,
  type ReviewDeps,
} from "./review";
import { openTestDb, seedDraft, seedDraftStatuses, seedOrder, seedUser, seedWorkspace, snapshotOf } from "./test-helpers";

// Approve and Reject (draft orders spec section 9), against the real
// migrations and a stubbed Shopify. The approve mutation is never sent to a
// real store.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_review_token_never_leak";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-05T15:00:00.000Z");
const MANAGER = "u_manager";
const DRAFT_GID = "gid://shopify/DraftOrder/12";

type DraftState = {
  status: "OPEN" | "INVOICE_SENT" | "COMPLETED";
  ready: boolean;
  total: string | null;
  order: { id: string; name: string } | null;
  tags: string[];
};

type Call = { op: string; variables: Record<string, unknown> };

function draftNode(draft: DraftState) {
  return {
    id: DRAFT_GID,
    legacyResourceId: "12",
    name: "#D12",
    status: draft.status,
    createdAt: new Date(NOW - 3600000).toISOString(),
    updatedAt: new Date(NOW - 60000).toISOString(),
    completedAt: draft.status === "COMPLETED" ? new Date(NOW - 1000).toISOString() : null,
    email: "jordan@example.com",
    tags: draft.tags,
    note2: null,
    customAttributes: [],
    order: draft.order
      ? { id: `gid://shopify/Order/${draft.order.id}`, legacyResourceId: draft.order.id, name: draft.order.name }
      : null,
    customer: { displayName: "Jordan Vale" },
    purchasingEntity: {
      __typename: "PurchasingCompany",
      company: { id: "gid://shopify/Company/1", name: "Impact Rentals" },
      location: { id: "gid://shopify/CompanyLocation/1", name: "Buford, GA" },
    },
    totalPriceSet: { shopMoney: { amount: draft.total ?? "0.0", currencyCode: "USD" } },
    lineItems: {
      nodes: [{ title: "Business cards", quantity: 1, customAttributes: [{ key: "Full Name", value: "Casey Lin" }] }],
      pageInfo: { hasNextPage: false },
    },
  };
}

function orderNode(id: string, name: string, tags: string[]) {
  return {
    id: `gid://shopify/Order/${id}`,
    legacyResourceId: id,
    name,
    createdAt: new Date(NOW - 1000).toISOString(),
    updatedAt: new Date(NOW - 1000).toISOString(),
    email: "jordan@example.com",
    sourceName: "shopify_draft_order",
    tags,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    customer: { displayName: "Jordan Vale" },
    currentTotalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
    fulfillments: [],
    lineItems: {
      nodes: [{ title: "Business cards", quantity: 1, customAttributes: [{ key: "Full Name", value: "Casey Lin" }] }],
      pageInfo: { hasNextPage: false },
    },
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// A store with one draft. Completing it makes order #1234 (id 9001). fail
// and handle answer an operation another way.
function fakeShop(
  initial: Partial<DraftState> | null = {},
  handle: Partial<Record<string, (call: Call, count: number) => Response | Promise<Response>>> = {},
) {
  const state: { draft: DraftState | null; orderTags: string[] } = {
    draft: initial === null ? null : { status: "OPEN", ready: true, total: "0.0", order: null, tags: [], ...initial },
    orderTags: [],
  };
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "unknown";
    const call = { op, variables: body.variables };
    calls.push(call);
    const count = (counts.get(op) ?? 0) + 1;
    counts.set(op, count);
    const custom = handle[op];
    if (custom) {
      return custom(call, count);
    }
    switch (op) {
      case "DraftBeforeApprove": {
        const draft = state.draft;
        return json({
          data: {
            draftOrder: draft
              ? {
                  id: DRAFT_GID,
                  name: "#D12",
                  status: draft.status,
                  ready: draft.ready,
                  completedAt: null,
                  order: draft.order
                    ? { id: `gid://shopify/Order/${draft.order.id}`, legacyResourceId: draft.order.id, name: draft.order.name }
                    : null,
                  totalPriceSet: { shopMoney: { amount: draft.total, currencyCode: "USD" } },
                }
              : null,
          },
        });
      }
      case "ApproveDraft": {
        const draft = state.draft!;
        draft.status = "COMPLETED";
        draft.order = { id: "9001", name: "#1234" };
        state.orderTags = [...draft.tags];
        return json({ data: { draftOrderComplete: { draftOrder: draftNode(draft), userErrors: [] } } });
      }
      case "DraftOrderById":
        return json({ data: { draftOrder: state.draft ? draftNode(state.draft) : null } });
      case "OrderById":
        return json({ data: { order: state.draft?.order ? orderNode("9001", "#1234", state.orderTags) : null } });
      case "StatusTags": {
        const isOrder = String(call.variables.id).includes("/Order/");
        const tags = isOrder ? state.orderTags : (state.draft?.tags ?? []);
        return json({ data: { node: { id: call.variables.id, tags } } });
      }
      case "StatusTagRemove":
      case "StatusTagAdd": {
        const isOrder = String(call.variables.id).includes("/Order/");
        const list = isOrder ? state.orderTags : state.draft!.tags;
        const tags = call.variables.tags as string[];
        const next = op === "StatusTagAdd" ? [...list, ...tags] : list.filter((tag) => !tags.includes(tag));
        if (isOrder) {
          state.orderTags = next;
        } else {
          state.draft!.tags = next;
        }
        const field = op === "StatusTagAdd" ? "tagsAdd" : "tagsRemove";
        return json({ data: { [field]: { userErrors: [] } } });
      }
      default:
        throw new Error("unexpected Shopify request: " + op);
    }
  }) as typeof fetch;
  return { impl, calls, state, ops: () => calls.map((call) => call.op) };
}

async function setup(
  opts: { scopes?: string[] | null; statusKey?: string; deleted?: boolean; draftStatuses?: boolean } = {},
) {
  const { db, raw } = openTestDb();
  await seedWorkspace(db, WS);
  if (opts.draftStatuses !== false) {
    await seedDraftStatuses(db, WS);
  }
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes: opts.scopes === undefined ? ["read_orders", "write_orders", "read_customers", "write_draft_orders"] : opts.scopes,
  });
  await seedDraft(db, WS, {
    id: "d1",
    draftId: "12",
    name: "#D12",
    statusKey: opts.statusKey ?? "new",
    draftDeletedAt: opts.deleted ? NOW - 5000 : null,
    notifiedAt: NOW - 7200000,
  });
  return { db, raw };
}

const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;

type Sleep = Mock<(ms: number) => Promise<void>>;

function deps(shop: { impl: typeof fetch }, sleep: Sleep = vi.fn(async () => undefined)): ReviewDeps & { sleep: Sleep } {
  return { env, fetchImpl: shop.impl, now: () => NOW, sleep };
}

const ctx = (role: "staff" | "manager" | "platform" = "manager", orderId = "d1") => ({
  workspaceId: WS,
  orderId,
  userId: MANAGER,
  role,
});

async function row(db: Db, id = "d1") {
  return (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
}

async function eventsOf(db: Db, orderId = "d1") {
  return db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.workspaceId, WS), eq(schema.events.orderId, orderId)));
}

describe("approveRequest", () => {
  it("completes a $0 draft in Shopify with only its id, and the card becomes the order", async () => {
    const { db } = await setup();
    const shop = fakeShop();
    const result = await approveRequest(db, ctx(), deps(shop));

    expect(shop.ops()).toEqual(["DraftBeforeApprove", "ApproveDraft"]);
    expect(shop.calls[1].variables).toEqual({ id: DRAFT_GID });
    expect(result).toMatchObject({
      kind: "approved",
      orderName: "#1234",
      shopifyOrderId: "9001",
      triggersPo: true,
      order: { id: "d1", statusKey: "approved", statusSetBy: MANAGER, statusSetAt: NOW },
    });
    const card = await row(db);
    expect(card).toMatchObject({
      id: "d1",
      shopifyOrderId: "9001",
      name: "#1234",
      draftName: "#D12",
      statusKey: "approved",
      statusSetBy: MANAGER,
      notifiedAt: NOW - 7200000,
    });
    expect((card.draftSnapshot as { status: string }).status).toBe("completed");
    expect((card.shopify as { kind: string; status: string })).toMatchObject({ kind: "draft", status: "completed" });

    const events = await eventsOf(db);
    expect(events.map((event) => [event.type, event.text, event.source, event.actorId])).toEqual(
      expect.arrayContaining([
        ["status", "Approved the request. Status set to Approved", "app", MANAGER],
        ["draft_completed", "Order #1234 created from draft #D12", "app", MANAGER],
      ]),
    );
    expect(events).toHaveLength(2);
    expect(events.find((event) => event.type === "status")!.meta).toEqual({
      from: "new",
      to: "approved",
      action: "approve",
      orderName: "#1234",
    });
    if (result.kind === "approved") {
      expect(result.events.map((event) => event.type).sort()).toEqual(["draft_completed", "status"]);
    }
  });

  it("approves from Rejected and Issue too: approval is decisive", async () => {
    for (const statusKey of ["rejected", "issue"]) {
      const { db } = await setup({ statusKey });
      const result = await approveRequest(db, ctx("platform"), deps(fakeShop()));
      expect(result.kind).toBe("approved");
      expect((await row(db)).statusKey).toBe("approved");
    }
  });

  it("names the platform admin who approves or rejects, though not a member, on the entries it returns", async () => {
    // These entries are shown at once and broadcast to open desks, whose
    // member lists do not include a platform admin from outside the
    // workspace (spec section 11.6: "Approved by X").
    const approve = await setup();
    await seedUser(approve.db, MANAGER, "ryan@example.com", "Ryan Hale");
    const approved = await approveRequest(approve.db, ctx("platform"), deps(fakeShop()));
    expect(approved.kind).toBe("approved");
    if (approved.kind === "approved") {
      expect(approved.events.map((event) => [event.type, event.actorName])).toEqual(
        expect.arrayContaining([
          ["status", "Ryan Hale"],
          ["draft_completed", "Ryan Hale"],
        ]),
      );
      expect(approved.follow.statusEvent?.actorName).toBe("Ryan Hale");
      expect(approved.follow.completedEvent?.actorName).toBe("Ryan Hale");
    }

    const reject = await setup();
    await seedUser(reject.db, MANAGER, "ryan@example.com");
    const rejected = await rejectRequest(reject.db, ctx("platform"), { reason: "Duplicate request" }, deps(fakeShop()));
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind === "rejected") {
      expect(rejected.events.map((event) => event.actorName)).toEqual(["ryan@example.com", "ryan@example.com"]);
      expect(rejected.statusEvent.actorName).toBe("ryan@example.com");
      expect(rejected.noteEvent.actorName).toBe("ryan@example.com");
    }
  });

  it("answers already-approved to a second press without asking Shopify again", async () => {
    const { db } = await setup();
    const shop = fakeShop();
    await approveRequest(db, ctx(), deps(shop));
    const again = await approveRequest(db, ctx(), deps(shop));
    expect(again).toMatchObject({ kind: "already-approved", orderName: "#1234", order: { statusKey: "approved" } });
    expect(shop.ops()).toEqual(["DraftBeforeApprove", "ApproveDraft"]);
    expect(await eventsOf(db)).toHaveLength(2);
  });

  it("is forbidden to staff, and asks Shopify nothing", async () => {
    const { db } = await setup();
    const shop = fakeShop();
    expect(await approveRequest(db, ctx("staff"), deps(shop))).toEqual({
      kind: "forbidden",
      error: "Only a manager can approve or reject requests.",
    });
    expect(shop.calls).toEqual([]);
  });

  it("is not-found for a card in another workspace", async () => {
    const { db } = await setup();
    await seedWorkspace(db, "ws_other");
    expect(await approveRequest(db, { ...ctx(), workspaceId: "ws_other" }, deps(fakeShop()))).toEqual({
      kind: "not-found",
    });
  });

  it("refuses a draft Shopify deleted, with no status for Draft approved, or without the draft scopes", async () => {
    const deleted = await setup({ deleted: true });
    const shop = fakeShop();
    expect(await approveRequest(deleted.db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify no longer has this draft. It may have been deleted there, so it cannot be approved.",
    });

    const unlinked = await setup({ draftStatuses: false });
    expect(await approveRequest(unlinked.db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 409,
      error: "No status follows Draft approved. A manager can set one in Settings > Statuses.",
    });

    const noScopes = await setup({ scopes: ["read_orders", "write_orders", "read_customers"] });
    expect(await approveRequest(noScopes.db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 409,
      error:
        "Draft orders are not enabled for this store's Shopify app. A platform admin can grant read_draft_orders and write_draft_orders, then refresh the connection.",
    });
    expect(shop.calls).toEqual([]);
  });

  it("marks the card deleted when Shopify no longer has the draft", async () => {
    const { db } = await setup();
    const shop = fakeShop(null);
    const result = await approveRequest(db, ctx(), deps(shop));
    expect(result).toMatchObject({
      kind: "refused",
      status: 409,
      error: "Shopify no longer has this draft. It may have been deleted there, so it cannot be approved.",
      deleted: { orderId: "d1", event: { type: "draft_deleted" } },
    });
    expect((await row(db)).draftDeletedAt).toBe(NOW);
    expect(shop.ops()).toEqual(["DraftBeforeApprove"]);
  });

  it("follows a draft already completed in Shopify instead of completing it again", async () => {
    const { db } = await setup({ statusKey: "rejected" });
    const shop = fakeShop({ status: "COMPLETED", order: { id: "9001", name: "#1234" } });
    const result = await approveRequest(db, ctx(), deps(shop));
    expect(shop.ops()).toEqual(["DraftBeforeApprove", "DraftOrderById"]);
    expect(result).toMatchObject({
      kind: "completed-in-shopify",
      orderName: "#1234",
      message: "This draft was already completed in Shopify as order #1234. The card now follows that order.",
      order: { id: "d1", statusKey: "approved", statusSetBy: null },
    });
    const events = await eventsOf(db);
    expect(events.map((event) => [event.type, event.source])).toEqual(
      expect.arrayContaining([
        ["draft_completed", "shopify"],
        ["status", "shopify"],
      ]),
    );
    expect(events.find((event) => event.type === "status")!.text).toBe(
      "Status set to Approved: the draft was completed in Shopify as order #1234",
    );
  });

  it("never completes a draft whose total is not exactly zero", async () => {
    const { db } = await setup();
    const shop = fakeShop({ total: "12.50" });
    expect(await approveRequest(db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 409,
      error:
        "This draft totals $12.50. Ordering Desk only approves drafts that total $0.00, so no payment is recorded by mistake. Complete it in Shopify instead.",
    });
    expect(shop.ops()).toEqual(["DraftBeforeApprove"]);
    expect((await row(db)).shopifyOrderId).toBeNull();
  });

  it("asks again while Shopify is still calculating, then gives up", async () => {
    const { db } = await setup();
    const shop = fakeShop({ ready: false });
    const d = deps(shop);
    expect(await approveRequest(db, ctx(), d)).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify is still calculating this draft. Try again in a few seconds.",
    });
    expect(REVIEW_READY_TRIES).toBe(3);
    expect(REVIEW_RETRY_MS).toBe(500);
    expect(shop.ops()).toEqual(Array(1 + REVIEW_READY_TRIES).fill("DraftBeforeApprove"));
    expect(d.sleep.mock.calls).toEqual(Array(REVIEW_READY_TRIES).fill([REVIEW_RETRY_MS]));

    const later = fakeShop({ ready: false });
    const sleepThenReady: Sleep = vi.fn(async () => {
      later.state.draft!.ready = true;
    });
    expect((await approveRequest(db, ctx(), deps(later, sleepThenReady))).kind).toBe("approved");
    expect(later.ops()).toEqual(["DraftBeforeApprove", "DraftBeforeApprove", "ApproveDraft"]);
  });

  it("tries once more when Shopify says the draft is not finished calculating", async () => {
    const { db } = await setup();
    let first = true;
    const shop = fakeShop(
      {},
      {
        ApproveDraft: (call, count) => {
          if (count === 1 && first) {
            first = false;
            return json({
              data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: "Draft order is not finished calculating" }] } },
            });
          }
          shop.state.draft!.status = "COMPLETED";
          shop.state.draft!.order = { id: "9001", name: "#1234" };
          return json({ data: { draftOrderComplete: { draftOrder: draftNode(shop.state.draft!), userErrors: [] } } });
        },
      },
    );
    const d = deps(shop);
    expect((await approveRequest(db, ctx(), d)).kind).toBe("approved");
    expect(shop.ops()).toEqual(["DraftBeforeApprove", "ApproveDraft", "DraftBeforeApprove", "ApproveDraft"]);
    expect(d.sleep).toHaveBeenCalledWith(REVIEW_RETRY_MS);
  });

  it("never sends the retry when the draft gained a price while Shopify was calculating it", async () => {
    // Someone in Shopify admin adds or reprices a line while the manager
    // presses Approve: the first read is $0 and ready, Shopify refuses the
    // first completion mid-calculation, and the read before the retry is
    // ready at 48.00. Completing it would record a $48 payment that never
    // happened.
    const { db } = await setup();
    const shop = fakeShop(
      {},
      {
        ApproveDraft: () => {
          shop.state.draft!.total = "48.00";
          return json({
            data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: "Draft order is not finished calculating" }] } },
          });
        },
      },
    );
    expect(await approveRequest(db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 409,
      error:
        "This draft totals $48.00. Ordering Desk only approves drafts that total $0.00, so no payment is recorded by mistake. Complete it in Shopify instead.",
    });
    expect(shop.ops()).toEqual(["DraftBeforeApprove", "ApproveDraft", "DraftBeforeApprove"]);
    expect(shop.ops().filter((op) => op === "ApproveDraft")).toHaveLength(1);
    const card = await row(db);
    expect(card.shopifyOrderId).toBeNull();
    expect(card.statusKey).toBe("new");
    expect(await eventsOf(db)).toHaveLength(0);
  });

  it("never sends the retry when the draft's total is missing or its state is not open on the second read", async () => {
    for (const change of [
      (draft: DraftState) => {
        draft.total = null;
      },
      (draft: DraftState) => {
        (draft as { status: string }).status = "SOMETHING_NEW";
      },
    ]) {
      const { db } = await setup();
      const shop = fakeShop(
        {},
        {
          ApproveDraft: () => {
            change(shop.state.draft!);
            return json({
              data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: "Draft order is not finished calculating" }] } },
            });
          },
        },
      );
      const result = await approveRequest(db, ctx(), deps(shop));
      expect(result).toMatchObject({ kind: "refused", status: 409 });
      expect(shop.ops().filter((op) => op === "ApproveDraft")).toHaveLength(1);
      expect((await row(db)).shopifyOrderId).toBeNull();
    }
  });

  it("logs the order's ids when Shopify reports a completed total that is not zero", async () => {
    // Only possible if the draft changed between the last read and the
    // mutation; the completion cannot be undone, so it is recorded and
    // flagged rather than hidden.
    const { db } = await setup();
    const shop = fakeShop(
      {},
      {
        ApproveDraft: () => {
          const draft = shop.state.draft!;
          draft.status = "COMPLETED";
          draft.order = { id: "9001", name: "#1234" };
          draft.total = "48.00";
          return json({ data: { draftOrderComplete: { draftOrder: draftNode(draft), userErrors: [] } } });
        },
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await approveRequest(db, ctx(), deps(shop))).kind).toBe("approved");
      const logged = warn.mock.calls.map((call) => String(call[0]));
      expect(logged).toEqual([
        "[review] " + JSON.stringify({ workspaceId: WS, orderRowId: "d1", shopifyOrderId: "9001", completedTotal: "not zero" }),
      ]);
      expect(logged.join(" ")).not.toContain("jordan@example.com");
    } finally {
      warn.mockRestore();
    }
  });

  it("never completes a draft whose state is not open or invoice sent on the first read", async () => {
    const { db } = await setup();
    const shop = fakeShop({ status: "SOMETHING_NEW" as DraftState["status"] });
    expect(await approveRequest(db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify reports this draft in a state Ordering Desk cannot approve. Check the draft in Shopify.",
    });
    expect(shop.ops()).toEqual(["DraftBeforeApprove"]);

    const sent = await setup();
    const invoiced = fakeShop({ status: "INVOICE_SENT" });
    expect((await approveRequest(sent.db, ctx(), deps(invoiced))).kind).toBe("approved");
  });

  it("reads the draft again after a refusal: completed counts as done, open shows Shopify's words", async () => {
    const won = await setup();
    const raced = fakeShop(
      {},
      {
        ApproveDraft: () => {
          // Another approval (or a person in Shopify) completed it first.
          raced.state.draft!.status = "COMPLETED";
          raced.state.draft!.order = { id: "9001", name: "#1234" };
          return json({ data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: ["id"], message: "Draft order has been completed" }] } } });
        },
      },
    );
    const result = await approveRequest(won.db, ctx(), deps(raced));
    expect(result).toMatchObject({ kind: "approved", orderName: "#1234" });
    expect(raced.ops()).toEqual(["DraftBeforeApprove", "ApproveDraft", "DraftBeforeApprove", "DraftOrderById"]);
    expect((await row(won.db)).statusKey).toBe("approved");

    const refused = await setup();
    const shop = fakeShop(
      {},
      {
        ApproveDraft: () =>
          json({ data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: "Customer is blocked" }] } } }),
      },
    );
    expect(await approveRequest(refused.db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify did not complete the draft: Customer is blocked.",
    });
    expect(shop.ops().filter((op) => op === "ApproveDraft")).toHaveLength(1);
    expect((await row(refused.db)).shopifyOrderId).toBeNull();
  });

  it("never sends the approval twice when Shopify does not answer it", async () => {
    // Completed despite the timeout.
    const a = await setup();
    const landed = fakeShop(
      {},
      {
        ApproveDraft: () => {
          landed.state.draft!.status = "COMPLETED";
          landed.state.draft!.order = { id: "9001", name: "#1234" };
          return new Response("{}", { status: 504 });
        },
      },
    );
    expect((await approveRequest(a.db, ctx(), deps(landed))).kind).toBe("approved");
    expect(landed.ops().filter((op) => op === "ApproveDraft")).toHaveLength(1);

    // Still open: nothing changed.
    const b = await setup();
    const open = fakeShop({}, { ApproveDraft: () => new Response("{}", { status: 504 }) });
    expect(await approveRequest(b.db, ctx(), deps(open))).toEqual({
      kind: "refused",
      status: 502,
      error: "Shopify did not confirm the approval. Nothing changed. Try again.",
    });
    expect(open.ops()).toEqual(["DraftBeforeApprove", "ApproveDraft", "DraftBeforeApprove"]);

    // The read after it failed too.
    const c = await setup();
    const silent = fakeShop(
      {},
      {
        ApproveDraft: () => new Response("{}", { status: 504 }),
        DraftBeforeApprove: (_call, count) =>
          count === 1
            ? json({
                data: {
                  draftOrder: {
                    id: DRAFT_GID,
                    name: "#D12",
                    status: "OPEN",
                    ready: true,
                    completedAt: null,
                    order: null,
                    totalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
                  },
                },
              })
            : new Response("{}", { status: 503 }),
      },
    );
    expect(await approveRequest(c.db, ctx(), deps(silent))).toEqual({
      kind: "refused",
      status: 502,
      error: "Shopify did not answer. Check the draft in Shopify before trying again. The card updates on the next sync.",
    });
    expect(silent.ops().filter((op) => op === "ApproveDraft")).toHaveLength(1);
    expect((await row(c.db)).shopifyOrderId).toBeNull();
  });

  it("answers 502 when the draft cannot be read before approving", async () => {
    const { db } = await setup();
    const shop = fakeShop({}, { DraftBeforeApprove: () => new Response("{}", { status: 503 }) });
    expect(await approveRequest(db, ctx(), deps(shop))).toEqual({
      kind: "refused",
      status: 502,
      error: "Could not check the draft in Shopify (Shopify responded with HTTP 503). Nothing changed. Try again.",
    });
    expect(shop.ops()).toEqual(["DraftBeforeApprove"]);
  });

  it("folds in an order card that landed first, then sets the approved status once", async () => {
    const { db } = await setup();
    // The order arrived (webhook) before the approval was recorded.
    await seedOrder(db, WS, { id: "orphan", name: "#1234", shopify: snapshotOf({ name: "#1234", shopifyOrderId: "9001" }) });
    await db.update(schema.orders).set({ shopifyOrderId: "9001" }).where(eq(schema.orders.id, "orphan"));
    await db.insert(schema.events).values({
      id: "orphan-note",
      workspaceId: WS,
      orderId: "orphan",
      type: "note",
      text: "Seen in Shopify",
      createdAt: NOW - 500,
      source: "app",
    });
    const result = await approveRequest(db, ctx(), deps(fakeShop()));
    expect(result).toMatchObject({ kind: "approved", merged: { fromId: "orphan", toId: "d1" } });
    expect(await row(db, "orphan")).toBeUndefined();
    expect(await row(db)).toMatchObject({ shopifyOrderId: "9001", statusKey: "approved" });
    const events = await eventsOf(db);
    expect(events.map((event) => event.type).sort()).toEqual(["draft_completed", "note", "status"]);
  });

  it("writes nothing twice when two managers approve at once", async () => {
    const { db } = await setup();
    let second: Promise<unknown> | null = null;
    const shop = fakeShop(
      {},
      {
        DraftBeforeApprove: async (_call, count) => {
          if (count === 1) {
            // The other manager's approval runs to the end meanwhile.
            second = approveRequest(db, { ...ctx(), userId: "u_other" }, deps(fakeShop()));
            await second;
          }
          return json({
            data: {
              draftOrder: {
                id: DRAFT_GID,
                name: "#D12",
                status: count === 1 ? "OPEN" : "COMPLETED",
                ready: true,
                completedAt: null,
                order: count === 1 ? null : { id: "gid://shopify/Order/9001", legacyResourceId: "9001", name: "#1234" },
                totalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
              },
            },
          });
        },
        ApproveDraft: () =>
          json({ data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: ["id"], message: "Draft order has been completed" }] } } }),
        DraftOrderById: () =>
          json({ data: { draftOrder: draftNode({ status: "COMPLETED", ready: true, total: "0.0", order: { id: "9001", name: "#1234" }, tags: [] }) } }),
      },
    );
    const result = await approveRequest(db, ctx(), deps(shop));
    expect(result.kind).toBe("approved");
    const events = await eventsOf(db);
    expect(events.filter((event) => event.type === "status")).toHaveLength(1);
    expect(events.filter((event) => event.type === "draft_completed")).toHaveLength(1);
    expect((await row(db)).statusSetBy).toBe("u_other");
  });

  it("leaves the search row showing the order the request became", async () => {
    const { db } = await setup();
    await approveRequest(db, ctx(), deps(fakeShop()));
    const [row] = await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, "d1"));
    expect(row).toMatchObject({ kind: "order", statusKey: "approved", statusSetAt: NOW });
    expect(row.haystack).toContain("#1234");
    expect(row.haystack).toContain("#d12");
  });
});

describe("rejectRequest", () => {
  it("needs a reason of 1 to 4000 characters", async () => {
    const { db } = await setup();
    for (const body of [{ reason: "" }, { reason: "   " }, { reason: "a".repeat(NOTE_MAX + 1) }, { reason: 4 }, {}, null]) {
      expect(await rejectRequest(db, ctx(), body, deps(fakeShop())), JSON.stringify(body)?.slice(0, 30)).toEqual({
        kind: "invalid",
        error: "Give a reason (up to 4000 characters). It is saved as a note.",
      });
    }
    expect(await eventsOf(db)).toEqual([]);
  });

  it("moves the request to Rejected and saves the reason as a note, asking Shopify nothing", async () => {
    const { db } = await setup({ statusKey: "processing" });
    const shop = fakeShop();
    const result = await rejectRequest(db, ctx(), { reason: "  Not in the budget.\nAsk again in Q1.  " }, deps(shop));
    expect(shop.calls).toEqual([]);
    expect(result).toMatchObject({
      kind: "rejected",
      order: { id: "d1", statusKey: "rejected", statusSetBy: MANAGER, statusSetAt: NOW },
    });
    const events = await eventsOf(db);
    expect(events.map((event) => [event.type, event.text, event.meta, event.actorId, event.source])).toEqual(
      expect.arrayContaining([
        ["status", "Rejected the request. Status set to Rejected", { from: "processing", to: "rejected", action: "reject" }, MANAGER, "app"],
        ["note", "Not in the budget.\nAsk again in Q1.", { rejectReason: true }, MANAGER, "app"],
      ]),
    );
    expect(events).toHaveLength(2);
    expect((await row(db)).shopifyOrderId).toBeNull();
  });

  it("answers unchanged to a second rejection, with no second note", async () => {
    const { db } = await setup();
    await rejectRequest(db, ctx(), { reason: "No" }, deps(fakeShop()));
    expect(await rejectRequest(db, ctx(), { reason: "Still no" }, deps(fakeShop()))).toEqual({ kind: "unchanged" });
    expect(await eventsOf(db)).toHaveLength(2);
  });

  it("refuses an order, staff, a workspace with no Rejected status, and a store without the draft scopes", async () => {
    const attached = await setup();
    await attached.db.update(schema.orders).set({ shopifyOrderId: "9001", name: "#1234" }).where(eq(schema.orders.id, "d1"));
    expect(await rejectRequest(attached.db, ctx(), { reason: "No" }, deps(fakeShop()))).toEqual({
      kind: "refused",
      status: 409,
      error: "This request is already order #1234, so it cannot be rejected.",
    });

    const staff = await setup();
    expect(await rejectRequest(staff.db, ctx("staff"), { reason: "No" }, deps(fakeShop()))).toEqual({
      kind: "forbidden",
      error: "Only a manager can approve or reject requests.",
    });

    const unlinked = await setup({ draftStatuses: false });
    expect(await rejectRequest(unlinked.db, ctx(), { reason: "No" }, deps(fakeShop()))).toEqual({
      kind: "refused",
      status: 409,
      error: "No status follows Draft rejected. A manager can set one in Settings > Statuses.",
    });

    const noScopes = await setup({ scopes: ["read_orders"] });
    expect((await rejectRequest(noScopes.db, ctx(), { reason: "No" }, deps(fakeShop()))).kind).toBe("refused");
  });

  it("records the team's decision on a draft Shopify already deleted", async () => {
    const { db } = await setup({ deleted: true });
    expect((await rejectRequest(db, ctx(), { reason: "Gone anyway" }, deps(fakeShop()))).kind).toBe("rejected");
  });

  it("leaves the search row in Rejected", async () => {
    const { db } = await setup();
    await rejectRequest(db, ctx(), { reason: "Not in the budget." }, deps(fakeShop()));
    const [row] = await db.select().from(schema.orderSearch).where(eq(schema.orderSearch.orderId, "d1"));
    expect(row).toMatchObject({ kind: "draft", statusKey: "rejected" });
  });
});

describe("after the response", () => {
  it("writes the order onto the card without announcing it and moves the status tag to the order", async () => {
    const { db } = await setup();
    const shop = fakeShop({ tags: ["Ordering Desk: New", "vip"] });
    const result = await approveRequest(db, ctx(), deps(shop));
    if (result.kind !== "approved") {
      throw new Error("expected approved");
    }
    await followApproval(db, env, WS, "d1", result.follow, deps(shop));
    const card = await row(db);
    expect((card.shopify as { kind: string }).kind).toBe("order");
    expect(card.notifiedAt).toBe(NOW - 7200000);
    expect((await eventsOf(db)).filter((event) => event.type === "order_new")).toEqual([]);
    expect(shop.state.orderTags.sort()).toEqual(["Ordering Desk: Approved", "vip"]);
    const tagWrites = shop.calls.filter((call) => call.op === "StatusTagAdd" || call.op === "StatusTagRemove");
    expect(tagWrites.every((call) => call.variables.id === "gid://shopify/Order/9001")).toBe(true);
  });

  it("tags the DraftOrder Rejected and emails nobody", async () => {
    const { db } = await setup();
    const shop = fakeShop({ tags: ["Ordering Desk: New"] });
    const send = vi.fn();
    const mailEnv = { ...env, EMAIL: { send } } as unknown as CloudflareEnv;
    const rejected = await rejectRequest(db, ctx(), { reason: "No" }, deps(shop));
    if (rejected.kind !== "rejected") {
      throw new Error("expected rejected");
    }
    await followRejection(db, mailEnv, WS, "d1", rejected, deps(shop));
    expect(shop.state.draft!.tags).toEqual(["Ordering Desk: Rejected"]);
    expect(shop.calls.filter((call) => call.op === "StatusTagAdd").map((call) => call.variables.id)).toEqual([DRAFT_GID]);
    expect(send).not.toHaveBeenCalled();
  });

  it("writes no tag for a draft Shopify already deleted", async () => {
    const { db } = await setup({ deleted: true });
    const shop = fakeShop();
    const rejected = await rejectRequest(db, ctx(), { reason: "No" }, deps(shop));
    if (rejected.kind !== "rejected") {
      throw new Error("expected rejected");
    }
    await followRejection(db, env, WS, "d1", rejected, deps(shop));
    expect(shop.calls).toEqual([]);
  });
});
