import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb } from "@/server/desk/test-helpers";
import { encodePng } from "@/server/pwa/icon";
import { sendPurchaseOrder, type SendResult } from "./send";
import { createPurchaseOrder, SEND_LEASE_MS } from "./service";
import {
  draftBody,
  fakeBucket,
  mailEnv,
  NORTH_RECIPIENTS,
  ORDER,
  OTHER_WS,
  seedPoWorkspace,
  WS,
  type FakeBucket,
  type SentEmail,
} from "./test-helpers";

// Sending a PO: nothing goes out without an explicit confirmation of the
// exact recipients; the same request never sends twice; a failure is never
// silent. The Email Service binding and R2 are stood in.

const NOW = Date.UTC(2026, 9, 4, 15);

let db: Db;
let raw: ReturnType<typeof openTestDb>["raw"];
let bucket: FakeBucket;
let env: CloudflareEnv;
let sent: SentEmail[];
let email: { send: { mockImplementationOnce: (fn: () => Promise<never>) => unknown } };
let clock: number;
let poId: string;

beforeEach(async () => {
  ({ db, raw } = openTestDb());
  await seedPoWorkspace(db);
  bucket = fakeBucket();
  ({ env, sent, email } = mailEnv(bucket) as unknown as { env: CloudflareEnv; sent: SentEmail[]; email: typeof email });
  clock = NOW;
  const created = await createPurchaseOrder(db, { workspaceId: WS, orderId: ORDER, userId: "u_manager", now: NOW }, draftBody());
  if (created.kind !== "created") {
    throw new Error("draft not created");
  }
  poId = created.po.id;
});

let counter = 0;
function confirmed(overrides: Record<string, unknown> = {}) {
  counter++;
  return { requestId: `request-${counter}-abcdef`, confirm: true, recipients: NORTH_RECIPIENTS, ...overrides };
}

function send(body: unknown, opts: { userId?: string; workspaceId?: string } = {}): Promise<SendResult> {
  return sendPurchaseOrder(
    db,
    { env, bucket, now: () => clock },
    { workspaceId: opts.workspaceId ?? WS, poId, userId: opts.userId ?? "u_manager" },
    body,
  );
}

async function row() {
  const rows = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  return rows[0];
}

async function poEvents() {
  return (await db.select().from(schema.events)).filter((event) => event.type === "po_sent" || event.type === "po_failed");
}

function attachmentBytes(message: SentEmail): Uint8Array {
  return Uint8Array.from(atob(message.attachments![0].content), (char) => char.charCodeAt(0));
}

describe("the confirmation rule", () => {
  it("sends nothing without confirm: true, answering who it would go to", async () => {
    for (const body of [
      { requestId: "request-noconfirm-1" },
      { requestId: "request-noconfirm-2", confirm: false, recipients: NORTH_RECIPIENTS },
      { requestId: "request-noconfirm-3", confirm: "yes", recipients: NORTH_RECIPIENTS },
      { requestId: "request-noconfirm-4", confirm: true },
    ]) {
      const result = await send(body);
      expect(result).toMatchObject({ kind: "confirm-required", recipients: NORTH_RECIPIENTS });
    }
    expect(sent).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
    expect(await row()).toMatchObject({ status: "draft", sendStartedAt: null, poNumber: `draft:${poId}` });
  });

  it("sends nothing when the confirmed recipients are not exactly who it would go to now", async () => {
    // Confirmed before a manager added a copy address to the vendor.
    await db.update(schema.vendors).set({ cc: ["rep@northline.example", "boss@northline.example"] }).where(eq(schema.vendors.id, "v_north"));
    const changed = await send(confirmed());
    expect(changed).toMatchObject({
      kind: "recipients-changed",
      recipients: { to: ["orders@northline.example"], cc: ["rep@northline.example", "boss@northline.example", "office@impact.example"] },
    });
    for (const recipients of [
      { to: ["someone@else.example"], cc: NORTH_RECIPIENTS.cc },
      { to: NORTH_RECIPIENTS.to, cc: [] },
      { to: NORTH_RECIPIENTS.to, cc: [...NORTH_RECIPIENTS.cc, "extra@x.example"] },
    ]) {
      expect((await send(confirmed({ recipients }))).kind).toBe("recipients-changed");
    }
    expect(sent).toHaveLength(0);
    expect((await row()).status).toBe("draft");
  });

  it("needs a request id", async () => {
    expect((await send({ confirm: true, recipients: NORTH_RECIPIENTS })).kind).toBe("invalid");
    expect((await send({ requestId: "short", confirm: true, recipients: NORTH_RECIPIENTS })).kind).toBe("invalid");
    expect(sent).toHaveLength(0);
  });
});

describe("a confirmed send", () => {
  it("mints the number, stores the PDF under pos/<workspace>/<po>-<random>.pdf and emails it to the vendor with copies", async () => {
    const result = await send(confirmed());
    expect(result.kind).toBe("sent");
    if (result.kind !== "sent") {
      return;
    }
    expect(result.po).toMatchObject({
      number: "IMP-2026-0001",
      state: "sent",
      sentAt: NOW,
      sendCount: 1,
      sentTo: NORTH_RECIPIENTS,
      lastError: null,
      pdfUrl: `/api/pos/${poId}/pdf`,
    });
    expect(result.first).toBe(true);
    expect(result.emailed).toEqual(["orders@northline.example", "rep@northline.example", "office@impact.example"]);
    expect(result.notice).toEqual({
      poId,
      poNumber: "IMP-2026-0001",
      orderId: ORDER,
      orderName: "#1001",
      vendorName: "Northline Supply",
      actorId: "u_manager",
    });

    const stored = await row();
    expect(stored.pdfKey).toMatch(new RegExp(`^pos/${WS}/${poId}-[0-9a-f]{32}\\.pdf$`));
    expect(bucket.objects.get(stored.pdfKey!)?.contentType).toBe("application/pdf");
    expect([...bucket.objects.keys()]).toEqual([stored.pdfKey]);
    expect(stored.sendStartedAt).toBeNull();
    expect(stored.sentBy).toBe("u_manager");

    expect(sent).toHaveLength(1);
    const [message] = sent;
    expect(message.to).toEqual(["orders@northline.example"]);
    expect(message.cc).toEqual(["rep@northline.example", "office@impact.example"]);
    expect(message.replyTo).toBe("office@impact.example");
    expect(message.from).toEqual({ name: "IMPACT Rentals", email: "orders@orderingdesk.com" });
    expect(message.subject).toBe("Purchase order IMP-2026-0001 from IMPACT Rentals");
    expect(message.html).toContain("Northline Supply");
    expect(message.html).toContain("CA$25.50");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments![0]).toMatchObject({ filename: "IMP-2026-0001.pdf", type: "application/pdf", disposition: "attachment" });
    const pdf = attachmentBytes(message);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf).toEqual(bucket.objects.get(stored.pdfKey!)?.bytes);

    expect(await poEvents()).toEqual([
      expect.objectContaining({ type: "po_sent", text: "Purchase order IMP-2026-0001 sent to Northline Supply", actorId: "u_manager" }),
    ]);
  });

  it("dates the PDF and the email in the sender's time zone, ignoring one that is not real", async () => {
    clock = Date.UTC(2026, 9, 5, 1, 30);
    await send(confirmed({ timeZone: "America/Toronto" }));
    expect(sent[0].html).toContain("Oct 4, 2026");
    await db.update(schema.purchaseOrders).set({ status: "draft" }).where(eq(schema.purchaseOrders.id, poId));
    await send(confirmed({ timeZone: "Mars/Olympus_Mons" }));
    expect(sent[1].html).toContain("Oct 5, 2026");
  });

  it("sends from the workspace's own verified address when it has one", async () => {
    await db
      .update(schema.workspaces)
      .set({ customDomain: "orders.impact.example", customDomainStatus: "active", sendingVerifiedAt: 1 })
      .where(eq(schema.workspaces.id, WS));
    await send(confirmed());
    expect(sent[0].from).toEqual({ name: "IMPACT Rentals", email: "accounts@orders.impact.example" });
  });

  it("puts the workspace logo's PNG copy in the PDF, never reading an SVG", async () => {
    const png = await encodePng(120, 40, new Uint8Array(120 * 40 * 4).fill(180));
    const pngKey = `branding/${WS}/logo-light-${"d".repeat(32)}.png`;
    const svgKey = `branding/${WS}/logo-light-${"e".repeat(32)}.svg`;
    bucket.objects.set(pngKey, { bytes: png, contentType: "image/png" });
    await db
      .update(schema.workspaces)
      .set({ branding: { logo: { light: { key: svgKey, contentType: "image/svg+xml", pngKey }, dark: null } } })
      .where(eq(schema.workspaces.id, WS));
    await send(confirmed());
    expect(bucket.gets).toContain(pngKey);
    expect(bucket.gets).not.toContain(svgKey);
    expect(new TextDecoder("latin1").decode(attachmentBytes(sent[0]))).toContain("/Subtype /Image");
  });

  it("refuses a PO with a line that has no cost, or whose vendor was removed, sending nothing", async () => {
    await db
      .update(schema.purchaseOrders)
      .set({ lineItems: [{ description: "Gloves", sku: "", quantity: 1, unitCost: null }] })
      .where(eq(schema.purchaseOrders.id, poId));
    expect(await send(confirmed())).toMatchObject({ kind: "invalid", error: expect.stringContaining("unit cost") });
    await db.update(schema.purchaseOrders).set({ lineItems: draftBody().lines }).where(eq(schema.purchaseOrders.id, poId));
    await db.update(schema.vendors).set({ archived: true }).where(eq(schema.vendors.id, "v_north"));
    expect(await send(confirmed())).toMatchObject({ kind: "invalid", error: expect.stringContaining("vendor was removed") });
    expect(sent).toHaveLength(0);
    expect(await row()).toMatchObject({ status: "draft", sendStartedAt: null, poNumber: `draft:${poId}` });
  });

  it("treats a PO of another workspace as missing", async () => {
    expect((await send(confirmed(), { workspaceId: OTHER_WS })).kind).toBe("not-found");
    expect(sent).toHaveLength(0);
  });
});

describe("never twice by accident", () => {
  it("answers a repeated request with what it did, sending nothing more", async () => {
    const body = confirmed();
    expect((await send(body)).kind).toBe("sent");
    clock += 1000;
    expect(await send(body)).toMatchObject({ kind: "unchanged", reason: "replayed", po: { state: "sent", sendCount: 1 } });
    expect(sent).toHaveLength(1);
  });

  it("answers a new send of a sent PO with already-sent, sending nothing", async () => {
    await send(confirmed());
    expect(await send(confirmed())).toMatchObject({ kind: "unchanged", reason: "already-sent" });
    expect(sent).toHaveLength(1);
    expect(await poEvents()).toHaveLength(1);
  });

  it("sends once when two confirmed sends race", async () => {
    const results = await Promise.all([send(confirmed()), send(confirmed()), send(confirmed())]);
    expect(results.filter((result) => result.kind === "sent")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy" || result.kind === "unchanged")).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect((await row()).sendCount).toBe(1);
  });

  // Another request finished sending after this one read the PO as a draft
  // and before it claimed it: the claim must not match a sent PO.
  it("does not send a PO that another request sent after this one read it", async () => {
    let interfered = false;
    const racing = new Proxy(db as object, {
      get(target, prop) {
        if (prop === "update" && !interfered) {
          interfered = true;
          raw
            .prepare("UPDATE purchase_orders SET status = 'sent', po_number = 'IMP-2026-0001', send_started_at = NULL, send_count = 1 WHERE id = ?")
            .run(poId);
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as Db;
    const result = await sendPurchaseOrder(racing, { env, bucket, now: () => clock }, { workspaceId: WS, poId, userId: "u_manager" }, confirmed());
    expect(result).toMatchObject({ kind: "unchanged", reason: "already-sent" });
    expect(sent).toHaveLength(0);
  });

  it("refuses a send while another attempt holds the PO, and takes over an attempt that never finished", async () => {
    await db
      .update(schema.purchaseOrders)
      .set({ sendStartedAt: NOW - 1000, sendAttempt: "someone-else-attempt" })
      .where(eq(schema.purchaseOrders.id, poId));
    expect(await send(confirmed())).toMatchObject({ kind: "busy", po: { state: "sending" } });
    expect(sent).toHaveLength(0);

    clock = NOW + SEND_LEASE_MS;
    expect((await send(confirmed())).kind).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("resends a sent PO only when asked, with the same PDF, counting the send", async () => {
    const first = await send(confirmed());
    const key = (await row()).pdfKey;
    clock += 60000;
    expect(await send(confirmed({ resend: true }))).toMatchObject({
      kind: "sent",
      first: false,
      po: { state: "sent", sendCount: 2, sentAt: NOW, number: "IMP-2026-0001" },
    });
    expect((await row()).pdfKey).toBe(key);
    expect(sent).toHaveLength(2);
    expect(attachmentBytes(sent[1])).toEqual(attachmentBytes(sent[0]));
    expect((await poEvents()).map((event) => event.text)).toEqual([
      "Purchase order IMP-2026-0001 sent to Northline Supply",
      "Purchase order IMP-2026-0001 sent again to Northline Supply",
    ]);
    expect(first.kind).toBe("sent");
  });

  it("keeps the first send's date when sending again days later", async () => {
    await send(confirmed());
    clock = NOW + 3 * 24 * 60 * 60 * 1000;
    await send(confirmed({ resend: true }));
    expect(sent[1].html).toContain("Oct 4, 2026");
    expect(sent[1].html).not.toContain("Oct 7, 2026");
  });

  it("refuses a resend of a PO that was never sent", async () => {
    expect((await send(confirmed({ resend: true }))).kind).toBe("invalid");
    expect(sent).toHaveLength(0);
  });
});

describe("failures are never silent", () => {
  it("marks the PO failed with the reason when the email is refused, and a confirmed retry sends it once with the same number", async () => {
    email.send.mockImplementationOnce(async () => {
      throw new Error("destination address is not verified");
    });
    const failed = await send(confirmed());
    expect(failed).toMatchObject({
      kind: "failed",
      error: "The email was not sent: destination address is not verified",
      po: { state: "failed", number: "IMP-2026-0001", lastError: "The email was not sent: destination address is not verified", sendCount: 0 },
    });
    const failedRow = await row();
    expect(failedRow.sendStartedAt).toBeNull();
    const firstKey = failedRow.pdfKey;
    expect(firstKey).toMatch(/^pos\//);
    expect((await poEvents()).map((event) => [event.type, event.text])).toEqual([
      ["po_failed", "Purchase order IMP-2026-0001 was not sent: The email was not sent: destination address is not verified"],
    ]);

    clock += 5000;
    const retried = await send(confirmed());
    expect(retried).toMatchObject({ kind: "sent", po: { state: "sent", number: "IMP-2026-0001", lastError: null, sendCount: 1 } });
    expect(sent).toHaveLength(1);
    // The retry rendered a fresh PDF and dropped the failed attempt's one.
    const retriedKey = (await row()).pdfKey;
    expect(retriedKey).not.toBe(firstKey);
    expect([...bucket.objects.keys()]).toEqual([retriedKey]);
  });

  it("fails with a reason when the PDF cannot be stored, before any email", async () => {
    bucket.failPut = true;
    expect(await send(confirmed())).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("The PDF could not be stored"),
      po: { state: "failed" },
    });
    expect(sent).toHaveLength(0);
  });

  it("keeps a PO sent when a resend fails, with the reason", async () => {
    await send(confirmed());
    email.send.mockImplementationOnce(async () => {
      throw new Error("rate limited");
    });
    expect(await send(confirmed({ resend: true }))).toMatchObject({
      kind: "failed",
      po: { state: "sent", sendCount: 1, lastError: "The email was not sent: rate limited" },
    });
  });
});
