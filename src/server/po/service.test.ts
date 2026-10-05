import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedDraft } from "@/server/desk/test-helpers";
import {
  createPurchaseOrder,
  listOrderPurchaseOrders,
  loadPoView,
  openPoPdf,
  parsePoDraft,
  SEND_LEASE_MS,
  updatePurchaseOrder,
} from "./service";
import { draftBody, fakeBucket, LINES, NORTH_RECIPIENTS, ORDER, OTHER_WS, seedPoWorkspace, WS } from "./test-helpers";

const NOW = Date.UTC(2026, 9, 4, 15);

let db: Db;

beforeEach(async () => {
  db = openTestDb().db;
  await seedPoWorkspace(db);
});

async function create(body: unknown = draftBody(), now = NOW) {
  const result = await createPurchaseOrder(db, { workspaceId: WS, orderId: ORDER, userId: "u_manager", now }, body);
  if (result.kind !== "created") {
    throw new Error(`not created: ${JSON.stringify(result)}`);
  }
  return result;
}

describe("parsePoDraft", () => {
  it("accepts a draft, tidying text and costs", () => {
    expect(
      parsePoDraft({
        vendorId: "v_north",
        lines: [{ description: "  Hard\that  ", sku: " HH-1 ", quantity: 2, unitCost: "10.5" }, { description: "Vest", quantity: 1, unitCost: null }],
        shipTo: ["Riley Oakes", "  ", "Halifax"],
        notes: "  Line one\r\nLine two  ",
      }),
    ).toEqual({
      vendorId: "v_north",
      lines: [
        { description: "Hard hat", sku: "HH-1", quantity: 2, unitCost: "10.50" },
        { description: "Vest", sku: "", quantity: 1, unitCost: null },
      ],
      shipTo: ["Riley Oakes", "Halifax"],
      notes: "Line one\nLine two",
    });
  });

  it("refuses what cannot go on a purchase order, saying which line", () => {
    const line = LINES[0];
    const cases: Array<[unknown, string]> = [
      [null, "JSON object"],
      [draftBody({ vendorId: "" }), "Pick a vendor"],
      [draftBody({ lines: [] }), "1 to 200 lines"],
      [draftBody({ lines: Array(201).fill(line) }), "1 to 200 lines"],
      [draftBody({ lines: [line, { ...line, description: " " }] }), "Line 2: add a description"],
      [draftBody({ lines: [{ ...line, description: "x".repeat(301) }] }), "Line 1: add a description"],
      [draftBody({ lines: [{ ...line, sku: "s".repeat(65) }] }), "Line 1: the SKU"],
      [draftBody({ lines: [{ ...line, quantity: 0 }] }), "Line 1: the quantity"],
      [draftBody({ lines: [{ ...line, quantity: 1.5 }] }), "Line 1: the quantity"],
      [draftBody({ lines: [{ ...line, quantity: "2" }] }), "Line 1: the quantity"],
      [draftBody({ lines: [{ ...line, unitCost: "-1" }] }), "Line 1: the unit cost"],
      [draftBody({ lines: [{ ...line, unitCost: 12 }] }), "Line 1: the unit cost"],
      [draftBody({ shipTo: Array(9).fill("line") }), "Ship to takes up to 8 lines"],
      [draftBody({ shipTo: ["x".repeat(121)] }), "Ship to takes up to 8 lines"],
      [draftBody({ shipTo: "Riley" }), "Ship to takes lines"],
      [draftBody({ notes: "n".repeat(2001) }), "Notes must be 2,000 characters"],
    ];
    for (const [body, error] of cases) {
      const result = parsePoDraft(body);
      expect(typeof result === "string" ? result : "accepted").toContain(error);
    }
  });
});

describe("createPurchaseOrder", () => {
  it("creates a draft with no number yet, in the order's currency, with a po_draft event", async () => {
    const { po, event } = await create();
    expect(po).toMatchObject({
      orderId: ORDER,
      number: null,
      state: "draft",
      interrupted: false,
      currency: "CAD",
      subtotal: "25.50",
      lines: LINES,
      shipTo: ["Riley Oakes", "12 Harbour St", "Halifax NS B3H 1A1", "Canada"],
      notes: "Deliver before noon",
      sendCount: 0,
      sentAt: null,
      pdfUrl: null,
      lastError: null,
      createdBy: "u_manager",
      recipients: NORTH_RECIPIENTS,
    });
    expect(po.vendor).toMatchObject({ id: "v_north", name: "Northline Supply", archived: false });
    expect(event).toMatchObject({ type: "po_draft", orderId: ORDER, actorId: "u_manager", meta: { poId: po.id } });
    const stored = await db.select().from(schema.events).where(eq(schema.events.type, "po_draft"));
    expect(stored).toHaveLength(1);
  });

  it("refuses an archived vendor or another workspace's vendor, and another workspace's order", async () => {
    for (const vendorId of ["v_gone", "v_other", "v_missing"]) {
      const result = await createPurchaseOrder(db, { workspaceId: WS, orderId: ORDER, userId: "u_manager", now: NOW }, draftBody({ vendorId }));
      expect(result.kind).toBe("invalid");
    }
    const elsewhere = await createPurchaseOrder(db, { workspaceId: WS, orderId: "o_other", userId: "u_manager", now: NOW }, draftBody());
    expect(elsewhere.kind).toBe("not-found");
    expect(await db.select().from(schema.purchaseOrders)).toHaveLength(0);
  });

  // Draft orders spec section 13 (decision D11).
  it("refuses a request that is still a draft: a purchase order needs the Shopify order", async () => {
    await seedDraft(db, WS, { id: "d1" });
    const result = await createPurchaseOrder(db, { workspaceId: WS, orderId: "d1", userId: "u_manager", now: NOW }, draftBody());
    expect(result).toEqual({ kind: "draft", error: "Approve the request first. A purchase order needs the Shopify order." });
    expect(await db.select().from(schema.purchaseOrders)).toHaveLength(0);
    expect(await db.select().from(schema.events).where(eq(schema.events.type, "po_draft"))).toHaveLength(0);
  });
});

describe("updatePurchaseOrder", () => {
  it("saves a draft's vendor, lines, ship-to and notes", async () => {
    const { po } = await create();
    await db.insert(schema.vendors).values({ id: "v_south", workspaceId: WS, name: "Southside", email: "po@south.example" });
    const result = await updatePurchaseOrder(
      db,
      { workspaceId: WS, poId: po.id, now: NOW + 1000 },
      draftBody({ vendorId: "v_south", lines: [{ description: "Gloves", sku: "G-1", quantity: 4, unitCost: null }], notes: null }),
    );
    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.po).toMatchObject({
        vendor: { id: "v_south" },
        lines: [{ description: "Gloves", sku: "G-1", quantity: 4, unitCost: null }],
        notes: null,
        subtotal: null,
        updatedAt: NOW + 1000,
        recipients: { to: ["po@south.example"], cc: ["office@impact.example"] },
      });
    }
  });

  it("keeps a failed PO editable, but not a sent one or one a send holds", async () => {
    const { po } = await create();
    await db.update(schema.purchaseOrders).set({ status: "failed" }).where(eq(schema.purchaseOrders.id, po.id));
    expect((await updatePurchaseOrder(db, { workspaceId: WS, poId: po.id, now: NOW }, draftBody())).kind).toBe("updated");

    await db.update(schema.purchaseOrders).set({ status: "draft", sendStartedAt: NOW - 1000 }).where(eq(schema.purchaseOrders.id, po.id));
    const sending = await updatePurchaseOrder(db, { workspaceId: WS, poId: po.id, now: NOW }, draftBody({ notes: "changed" }));
    expect(sending).toMatchObject({ kind: "conflict", error: expect.stringContaining("being sent") });

    await db.update(schema.purchaseOrders).set({ status: "sent", sendStartedAt: null }).where(eq(schema.purchaseOrders.id, po.id));
    const sent = await updatePurchaseOrder(db, { workspaceId: WS, poId: po.id, now: NOW }, draftBody({ notes: "changed" }));
    expect(sent).toMatchObject({ kind: "conflict", error: expect.stringContaining("was sent") });
    expect((await loadPoView(db, WS, po.id, NOW))?.notes).toBe("Deliver before noon");
  });

  it("treats another workspace's PO as missing", async () => {
    const { po } = await create();
    expect((await updatePurchaseOrder(db, { workspaceId: OTHER_WS, poId: po.id, now: NOW }, draftBody({ vendorId: "v_other" }))).kind).toBe(
      "not-found",
    );
  });
});

describe("listOrderPurchaseOrders and the PO view", () => {
  it("lists an order's POs newest first, and nothing for an order outside the workspace", async () => {
    const first = await create(draftBody(), NOW);
    const second = await create(draftBody({ notes: "second" }), NOW + 5000);
    const list = await listOrderPurchaseOrders(db, { workspaceId: WS, orderId: ORDER, now: NOW + 6000 });
    expect(list?.map((po) => po.id)).toEqual([second.po.id, first.po.id]);
    expect(await listOrderPurchaseOrders(db, { workspaceId: WS, orderId: "o_other", now: NOW })).toBeNull();
  });

  it("reads a fresh send claim as sending and an expired one as interrupted", async () => {
    const { po } = await create();
    await db.update(schema.purchaseOrders).set({ sendStartedAt: NOW }).where(eq(schema.purchaseOrders.id, po.id));
    expect(await loadPoView(db, WS, po.id, NOW + 1000)).toMatchObject({ state: "sending", interrupted: false });
    expect(await loadPoView(db, WS, po.id, NOW + SEND_LEASE_MS + 1)).toMatchObject({ state: "draft", interrupted: true });
  });

  it("shows no recipients once the vendor is archived", async () => {
    const { po } = await create();
    await db.update(schema.vendors).set({ archived: true }).where(eq(schema.vendors.id, "v_north"));
    expect(await loadPoView(db, WS, po.id, NOW)).toMatchObject({ recipients: null, vendor: { archived: true } });
  });
});

describe("openPoPdf", () => {
  it("reads only a key under the PO's own pos/ prefix", async () => {
    const { po } = await create();
    const bucket = fakeBucket();
    const own = `pos/${WS}/${po.id}-${"a".repeat(32)}.pdf`;
    bucket.objects.set(own, { bytes: new TextEncoder().encode("%PDF-1.7"), contentType: "application/pdf" });
    bucket.objects.set("branding/ws_impact/logo-light-" + "b".repeat(32) + ".png", { bytes: new Uint8Array([1]), contentType: "image/png" });
    bucket.objects.set(`pos/${OTHER_WS}/${po.id}-${"c".repeat(32)}.pdf`, { bytes: new Uint8Array([1]), contentType: "application/pdf" });

    expect(await openPoPdf(db, bucket, WS, po.id)).toBeNull();
    await db.update(schema.purchaseOrders).set({ pdfKey: own, poNumber: "IMP-2026-0001" }).where(eq(schema.purchaseOrders.id, po.id));
    const pdf = await openPoPdf(db, bucket, WS, po.id);
    expect(pdf).toMatchObject({ size: 8, filename: "IMP-2026-0001.pdf" });

    for (const key of ["branding/ws_impact/logo-light-" + "b".repeat(32) + ".png", `pos/${OTHER_WS}/${po.id}-${"c".repeat(32)}.pdf`, `pos/${WS}/other-${"a".repeat(32)}.pdf`]) {
      bucket.gets.length = 0;
      await db.update(schema.purchaseOrders).set({ pdfKey: key }).where(eq(schema.purchaseOrders.id, po.id));
      expect(await openPoPdf(db, bucket, WS, po.id)).toBeNull();
      expect(bucket.gets).toEqual([]);
    }
    expect(await openPoPdf(db, bucket, OTHER_WS, po.id)).toBeNull();
  });
});
