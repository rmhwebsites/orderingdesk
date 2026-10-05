import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb } from "@/server/desk/test-helpers";
import { encodePng } from "@/server/pwa/icon";
import { sendPurchaseOrder, type SendResult } from "./send";
import { createPurchaseOrder, loadPoView, SEND_LEASE_MS, updatePurchaseOrder } from "./service";
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
let email: { send: { mockImplementationOnce: (fn: (message: SentEmail) => Promise<unknown>) => unknown } };
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
// The PO as a reviewer sees it now (the review step opening).
async function review() {
  return (await loadPoView(db, WS, poId, clock))!;
}

// A confirmation of exactly what the PO says now and who it goes to.
async function confirmed(overrides: Record<string, unknown> = {}) {
  counter++;
  const { contentVersion } = await review();
  return { requestId: `request-${counter}-abcdef`, confirm: true, recipients: NORTH_RECIPIENTS, contentVersion, ...overrides };
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
      // Recipients without the version of the content they reviewed.
      { requestId: "request-noconfirm-5", confirm: true, recipients: NORTH_RECIPIENTS },
    ]) {
      const result = await send(body);
      expect(result).toMatchObject({
        kind: "confirm-required",
        recipients: NORTH_RECIPIENTS,
        po: { recipients: NORTH_RECIPIENTS, contentVersion: (await review()).contentVersion },
      });
    }
    expect(sent).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
    expect(await row()).toMatchObject({ status: "draft", sendStartedAt: null, poNumber: `draft:${poId}` });
  });

  it("sends nothing when the confirmed recipients are not exactly who it would go to now", async () => {
    // Confirmed before a manager added a copy address to the vendor.
    await db.update(schema.vendors).set({ cc: ["rep@northline.example", "boss@northline.example"] }).where(eq(schema.vendors.id, "v_north"));
    const changed = await send(await confirmed());
    expect(changed).toMatchObject({
      kind: "recipients-changed",
      recipients: { to: ["orders@northline.example"], cc: ["rep@northline.example", "boss@northline.example", "office@impact.example"] },
    });
    for (const recipients of [
      { to: ["someone@else.example"], cc: NORTH_RECIPIENTS.cc },
      { to: NORTH_RECIPIENTS.to, cc: [] },
      { to: NORTH_RECIPIENTS.to, cc: [...NORTH_RECIPIENTS.cc, "extra@x.example"] },
    ]) {
      expect((await send(await confirmed({ recipients }))).kind).toBe("recipients-changed");
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

// The confirmation covers what the PO says, not only who it goes to: a
// second manager's save after the first opened the review step must never
// go out under the first manager's Send to vendor.
describe("the confirmation covers the reviewed content", () => {
  const CHANGED_LINES = [{ description: "Hard Hat (Orange)", sku: "HH-2", quantity: 40, unitCost: "12.00" }];

  function confirmationOf(view: { contentVersion: string }, overrides: Record<string, unknown> = {}) {
    counter++;
    return { requestId: `request-${counter}-content`, confirm: true, recipients: NORTH_RECIPIENTS, contentVersion: view.contentVersion, ...overrides };
  }

  async function expectNothingSent() {
    expect(sent).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
    expect(await poEvents()).toEqual([]);
    expect(await row()).toMatchObject({ status: "draft", sendStartedAt: null, sendAttempt: null, poNumber: `draft:${poId}` });
  }

  it("refuses a send of content saved after the review, with 409 and what would go out now, then sends that once confirmed", async () => {
    const reviewed = await review();
    clock += 1000;
    const saved = await updatePurchaseOrder(
      db,
      { workspaceId: WS, poId, now: clock },
      draftBody({ lines: CHANGED_LINES, notes: "Leave at the side door", shipTo: ["Yard 2", "Halifax NS"] }),
    );
    expect(saved.kind).toBe("updated");

    const refused = await send(confirmationOf(reviewed));
    expect(refused).toMatchObject({
      kind: "content-changed",
      error: expect.stringContaining("changed since you reviewed it"),
      recipients: NORTH_RECIPIENTS,
      po: { lines: CHANGED_LINES, notes: "Leave at the side door", shipTo: ["Yard 2", "Halifax NS"], subtotal: "480.00", recipients: NORTH_RECIPIENTS },
    });
    if (refused.kind !== "content-changed") {
      return;
    }
    expect(refused.po.contentVersion).not.toBe(reviewed.contentVersion);
    await expectNothingSent();

    // A new confirmation of what the step now shows sends exactly that.
    const result = await send(confirmationOf(refused.po));
    expect(result).toMatchObject({ kind: "sent", po: { state: "sent", notes: "Leave at the side door" } });
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("1 line, 40 units");
    expect(sent[0].html).toContain("CA$480.00");
    expect(sent[0].html).toContain("Yard 2");
    expect(sent[0].html).toContain("Leave at the side door");
    expect(sent[0].html).not.toContain("Deliver before noon");
  });

  it("catches a change saved in the same millisecond as the review", async () => {
    const reviewed = await review();
    expect((await updatePurchaseOrder(db, { workspaceId: WS, poId, now: NOW }, draftBody({ notes: "Same instant" }))).kind).toBe("updated");
    expect(await send(confirmationOf(reviewed))).toMatchObject({ kind: "content-changed", po: { notes: "Same instant" } });
    await expectNothingSent();
  });

  it("catches a vendor renamed or a PO moved to another vendor since the review", async () => {
    const reviewed = await review();
    await db.update(schema.vendors).set({ name: "Northline Supply (old account)" }).where(eq(schema.vendors.id, "v_north"));
    expect(await send(confirmationOf(reviewed))).toMatchObject({
      kind: "content-changed",
      po: { vendor: { name: "Northline Supply (old account)" } },
    });

    await db.insert(schema.vendors).values({ id: "v_south", workspaceId: WS, name: "Southline", email: "orders@southline.example" });
    const renamed = await review();
    clock += 1000;
    await updatePurchaseOrder(db, { workspaceId: WS, poId, now: clock }, draftBody({ vendorId: "v_south" }));
    expect(await send(confirmationOf(renamed))).toMatchObject({
      kind: "recipients-changed",
      recipients: { to: ["orders@southline.example"], cc: ["office@impact.example"] },
      po: { vendor: { id: "v_south" } },
    });
    await expectNothingSent();
  });

  it("sends a resend of an unchanged PO, and refuses one confirmed from before the PO last changed", async () => {
    clock += 1000;
    const beforeFirst = await review();
    expect((await send(confirmationOf(beforeFirst))).kind).toBe("sent");
    clock += 60000;
    // The send itself moved the PO on: a confirmation from before it is stale.
    expect(await send(confirmationOf(beforeFirst, { resend: true }))).toMatchObject({ kind: "content-changed", po: { state: "sent" } });
    expect(sent).toHaveLength(1);

    const afterFirst = await review();
    expect(await send(confirmationOf(afterFirst, { resend: true }))).toMatchObject({ kind: "sent", first: false, po: { sendCount: 2 } });
    expect(sent).toHaveLength(2);
  });

  // A save that lands after the send checked the confirmation and before it
  // claimed the PO: the send reads the PO again under its claim and goes
  // out only if that is still what was confirmed.
  it("refuses a save that lands just before the send claims the PO, releasing the claim and sending nothing", async () => {
    const reviewed = await review();
    let interfered = false;
    const racing = new Proxy(db as object, {
      get(target, prop) {
        if (prop === "update" && !interfered) {
          interfered = true;
          raw
            .prepare("UPDATE purchase_orders SET notes = 'Swapped in at the last moment', updated_at = ? WHERE id = ?")
            .run(NOW + 5, poId);
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as Db;
    const result = await sendPurchaseOrder(racing, { env, bucket, now: () => clock }, { workspaceId: WS, poId, userId: "u_manager" }, confirmationOf(reviewed));
    expect(result).toMatchObject({ kind: "content-changed", po: { notes: "Swapped in at the last moment", state: "draft", interrupted: false } });
    await expectNothingSent();
  });

  it("holds off any save while the send runs, so the PDF and email carry what was confirmed", async () => {
    const reviewed = await review();
    let midSend: string | null = null;
    email.send.mockImplementationOnce(async (message: SentEmail) => {
      midSend = (await updatePurchaseOrder(db, { workspaceId: WS, poId, now: clock + 10 }, draftBody({ notes: "Changed mid-send" }))).kind;
      sent.push(message);
      return { messageId: "m-mid" };
    });
    expect((await send(confirmationOf(reviewed))).kind).toBe("sent");
    expect(midSend).toBe("conflict");
    expect(sent[0].html).toContain("Deliver before noon");
    expect(sent[0].html).not.toContain("Changed mid-send");
    expect(new TextDecoder("latin1").decode(attachmentBytes(sent[0]))).not.toContain("Changed mid-send");
    expect((await row()).notes).toBe("Deliver before noon");
  });
});

describe("a confirmed send", () => {
  it("mints the number, stores the PDF under pos/<workspace>/<po>-<random>.pdf and emails it to the vendor with copies", async () => {
    const result = await send(await confirmed());
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
    await send(await confirmed({ timeZone: "America/Toronto" }));
    expect(sent[0].html).toContain("Oct 4, 2026");
    await db.update(schema.purchaseOrders).set({ status: "draft" }).where(eq(schema.purchaseOrders.id, poId));
    await send(await confirmed({ timeZone: "Mars/Olympus_Mons" }));
    expect(sent[1].html).toContain("Oct 5, 2026");
  });

  // Settings > Workspace email > From name is "the sender name for purchase
  // order email".
  it("uses the workspace's From name as the sender name when one is set", async () => {
    await db.update(schema.workspaceSettings).set({ fromName: "IMPACT Purchasing" }).where(eq(schema.workspaceSettings.workspaceId, WS));
    await send(await confirmed());
    expect(sent[0].from).toEqual({ name: "IMPACT Purchasing", email: "orders@orderingdesk.com" });
  });

  it("sends from the workspace's own verified address when it has one", async () => {
    await db
      .update(schema.workspaces)
      .set({ customDomain: "orders.impact.example", customDomainStatus: "active", sendingVerifiedAt: 1 })
      .where(eq(schema.workspaces.id, WS));
    await send(await confirmed());
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
    await send(await confirmed());
    expect(bucket.gets).toContain(pngKey);
    expect(bucket.gets).not.toContain(svgKey);
    expect(new TextDecoder("latin1").decode(attachmentBytes(sent[0]))).toContain("/Subtype /Image");
  });

  it("refuses a PO with a line that has no cost, or whose vendor was removed, sending nothing", async () => {
    await db
      .update(schema.purchaseOrders)
      .set({ lineItems: [{ description: "Gloves", sku: "", quantity: 1, unitCost: null }] })
      .where(eq(schema.purchaseOrders.id, poId));
    expect(await send(await confirmed())).toMatchObject({ kind: "invalid", error: expect.stringContaining("unit cost") });
    await db.update(schema.purchaseOrders).set({ lineItems: draftBody().lines }).where(eq(schema.purchaseOrders.id, poId));
    await db.update(schema.vendors).set({ archived: true }).where(eq(schema.vendors.id, "v_north"));
    expect(await send(await confirmed())).toMatchObject({ kind: "invalid", error: expect.stringContaining("vendor was removed") });
    expect(sent).toHaveLength(0);
    expect(await row()).toMatchObject({ status: "draft", sendStartedAt: null, poNumber: `draft:${poId}` });
  });

  it("treats a PO of another workspace as missing", async () => {
    expect((await send(await confirmed(), { workspaceId: OTHER_WS })).kind).toBe("not-found");
    expect(sent).toHaveLength(0);
  });
});

describe("never twice by accident", () => {
  it("answers a repeated request with what it did, sending nothing more", async () => {
    const body = await confirmed();
    expect((await send(body)).kind).toBe("sent");
    clock += 1000;
    expect(await send(body)).toMatchObject({ kind: "unchanged", reason: "replayed", po: { state: "sent", sendCount: 1 } });
    expect(sent).toHaveLength(1);
  });

  it("answers a new send of a sent PO with already-sent, sending nothing", async () => {
    await send(await confirmed());
    expect(await send(await confirmed())).toMatchObject({ kind: "unchanged", reason: "already-sent" });
    expect(sent).toHaveLength(1);
    expect(await poEvents()).toHaveLength(1);
  });

  it("sends once when two confirmed sends race", async () => {
    const bodies = await Promise.all([confirmed(), confirmed(), confirmed()]);
    const results = await Promise.all(bodies.map((body) => send(body)));
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
    const result = await sendPurchaseOrder(racing, { env, bucket, now: () => clock }, { workspaceId: WS, poId, userId: "u_manager" }, await confirmed());
    expect(result).toMatchObject({ kind: "unchanged", reason: "already-sent" });
    expect(sent).toHaveLength(0);
  });

  it("refuses a send while another attempt holds the PO, and takes over an attempt that never finished", async () => {
    await db
      .update(schema.purchaseOrders)
      .set({ sendStartedAt: NOW - 1000, sendAttempt: "someone-else-attempt" })
      .where(eq(schema.purchaseOrders.id, poId));
    expect(await send(await confirmed())).toMatchObject({ kind: "busy", po: { state: "sending" } });
    expect(sent).toHaveLength(0);

    clock = NOW + SEND_LEASE_MS;
    expect((await send(await confirmed())).kind).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("resends a sent PO only when asked, with the same PDF, counting the send", async () => {
    const first = await send(await confirmed());
    const key = (await row()).pdfKey;
    clock += 60000;
    expect(await send(await confirmed({ resend: true }))).toMatchObject({
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
    await send(await confirmed());
    clock = NOW + 3 * 24 * 60 * 60 * 1000;
    await send(await confirmed({ resend: true }));
    expect(sent[1].html).toContain("Oct 4, 2026");
    expect(sent[1].html).not.toContain("Oct 7, 2026");
  });

  it("refuses a resend of a PO that was never sent", async () => {
    expect((await send(await confirmed({ resend: true }))).kind).toBe("invalid");
    expect(sent).toHaveLength(0);
  });
});

describe("failures are never silent", () => {
  it("marks the PO failed with the reason when the email is refused, and a confirmed retry sends it once with the same number", async () => {
    email.send.mockImplementationOnce(async () => {
      throw new Error("destination address is not verified");
    });
    const failed = await send(await confirmed());
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
    const retried = await send(await confirmed());
    expect(retried).toMatchObject({ kind: "sent", po: { state: "sent", number: "IMP-2026-0001", lastError: null, sendCount: 1 } });
    expect(sent).toHaveLength(1);
    // The retry rendered a fresh PDF and dropped the failed attempt's one.
    const retriedKey = (await row()).pdfKey;
    expect(retriedKey).not.toBe(firstKey);
    expect([...bucket.objects.keys()]).toEqual([retriedKey]);
  });

  it("fails with a reason when the PDF cannot be stored, before any email", async () => {
    bucket.failPut = true;
    expect(await send(await confirmed())).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("The PDF could not be stored"),
      po: { state: "failed" },
    });
    expect(sent).toHaveLength(0);
  });

  it("keeps a PO sent when a resend fails, with the reason", async () => {
    await send(await confirmed());
    email.send.mockImplementationOnce(async () => {
      throw new Error("rate limited");
    });
    expect(await send(await confirmed({ resend: true }))).toMatchObject({
      kind: "failed",
      po: { state: "sent", sendCount: 1, lastError: "The email was not sent: rate limited" },
    });
  });
});
