import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/toasts";
import { PurchaseOrders } from "./po-history";
import { DraftActions, PoModalBody, PoModalFooter } from "./po-modal";
import { CONFIRM_ARM_MS, confirmArmed, confirmFocus, pendingFromPo, reconfirmPending, SendConfirm, type PendingSend } from "./po-send-confirm";
import type { PoView } from "@/server/po/service";

// Staff never see the create or send controls (the server refuses them
// anyway), and the confirmation step names every recipient before the
// explicit Send to vendor.

function history(canManage: boolean) {
  return renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PurchaseOrders, { orderId: "o1", canManage, refreshKey: 0, onCreate: () => {}, onEdit: () => {} }),
    ),
  );
}

describe("PurchaseOrders", () => {
  it("shows managers the Create purchase order control", () => {
    const html = history(true);
    expect(html).toContain("Purchase orders");
    expect(html).toContain("Create purchase order");
  });

  it("shows staff the history only, without create or send controls", () => {
    const html = history(false);
    expect(html).toContain("Purchase orders");
    expect(html).not.toContain("Create purchase order");
    expect(html).not.toContain("Send to vendor");
    expect(html).not.toContain("Retry");
  });
});

const NORTH = { to: ["orders@northline.example"], cc: ["rep@northline.example", "office@impact.example"] };

function poFixture(overrides: Partial<PoView> = {}): PoView {
  return {
    id: "po1",
    orderId: "o1",
    number: "IMP-2026-0042",
    state: "draft",
    interrupted: false,
    vendor: { id: "v_north", name: "Northline Supply", email: "orders@northline.example", cc: ["rep@northline.example"], archived: false },
    lines: [
      { description: "Hard Hat (White)", sku: "HH-1", quantity: 2, unitCost: "10.00" },
      { description: "Hi-vis vest", sku: "", quantity: 1, unitCost: "5.50" },
    ],
    shipTo: ["Riley Oakes", "12 Harbour St", "Halifax NS B3H 1A1"],
    notes: "Deliver before noon",
    currency: "CAD",
    subtotal: "25.50",
    lastError: null,
    sentAt: null,
    sentTo: null,
    sendCount: 0,
    createdAt: 1,
    createdBy: "u_manager",
    updatedAt: 1,
    pdfUrl: null,
    recipients: NORTH,
    contentVersion: "1.aaaa",
    ...overrides,
  };
}

function pendingOf(overrides: Partial<PendingSend> = {}, po: PoView = poFixture()): PendingSend {
  const pending = pendingFromPo(po, { label: "purchase order IMP-2026-0042", resend: false }, "request-1");
  if (!pending) {
    throw new Error("no pending send");
  }
  return { ...pending, ...overrides };
}

function confirmStep(pending: PendingSend, busy = false): string {
  return renderToStaticMarkup(createElement(SendConfirm, { pending, busy, onConfirm: () => {}, onCancel: () => {} }));
}

describe("pendingFromPo", () => {
  it("takes who it goes to, what it says and that content's version from the PO the step opens on", () => {
    expect(pendingFromPo(poFixture(), { label: "purchase order IMP-2026-0042", resend: false }, "request-1")).toEqual({
      poId: "po1",
      label: "purchase order IMP-2026-0042",
      vendorName: "Northline Supply",
      recipients: NORTH,
      content: {
        lines: poFixture().lines,
        shipTo: ["Riley Oakes", "12 Harbour St", "Halifax NS B3H 1A1"],
        notes: "Deliver before noon",
        currency: "CAD",
        subtotal: "25.50",
      },
      contentVersion: "1.aaaa",
      resend: false,
      requestId: "request-1",
      message: null,
    });
  });

  it("opens no step for a PO without a vendor to send to", () => {
    expect(pendingFromPo(poFixture({ recipients: null }), { label: "x", resend: false }, "r")).toBeNull();
    expect(pendingFromPo(poFixture({ vendor: null }), { label: "x", resend: false }, "r")).toBeNull();
  });
});

describe("reconfirmPending", () => {
  it("shows what would go out now, under a new request, after the PO changed since the review", () => {
    const fresh = poFixture({
      notes: "Leave at the side door",
      lines: [{ description: "Hard Hat (Orange)", sku: "HH-2", quantity: 40, unitCost: "12.00" }],
      subtotal: "480.00",
      contentVersion: "2.bbbb",
    });
    const next = reconfirmPending(pendingOf(), { recipients: NORTH, message: "This purchase order changed.", po: fresh }, "request-2");
    expect(next).toMatchObject({
      label: "purchase order IMP-2026-0042",
      resend: false,
      requestId: "request-2",
      contentVersion: "2.bbbb",
      message: "This purchase order changed.",
      content: { notes: "Leave at the side door", subtotal: "480.00", lines: fresh.lines },
    });
  });

  it("takes the fresh recipients and vendor name", () => {
    const fresh = poFixture({
      vendor: { id: "v_south", name: "Southline", email: "orders@southline.example", cc: [], archived: false },
      recipients: { to: ["orders@southline.example"], cc: [] },
      contentVersion: "3.cccc",
    });
    const next = reconfirmPending(pendingOf(), { recipients: fresh.recipients!, message: "Changed", po: fresh }, "request-3");
    expect(next).toMatchObject({ vendorName: "Southline", recipients: { to: ["orders@southline.example"], cc: [] }, contentVersion: "3.cccc" });
  });
});

describe("SendConfirm", () => {
  it("names the vendor and every address before the explicit send", () => {
    const html = confirmStep(pendingOf());
    expect(html).toContain("Send purchase order IMP-2026-0042 to Northline Supply?");
    expect(html).toContain("orders@northline.example");
    expect(html).toContain("rep@northline.example, office@impact.example");
    expect(html).toContain("Send to vendor");
    expect(html).toContain("Cancel");
  });

  it("says Send again for a resend", () => {
    const html = confirmStep(
      pendingOf({ recipients: { to: ["orders@northline.example"], cc: [] }, resend: true, requestId: "request-2", message: "Who it goes to changed." }),
    );
    expect(html).toContain("again to Northline Supply?");
    expect(html).toContain("No copies");
    expect(html).toContain("Send again");
    expect(html).toContain("Who it goes to changed.");
  });

  // What the reviewer confirms is what goes out: every line, the total, the
  // ship-to and the notes, as the server last described them.
  it("shows what goes out: each line, the total, the ship-to and the notes", () => {
    const html = confirmStep(pendingOf());
    expect(html).toContain("Hard Hat (White)");
    expect(html).toContain("HH-1");
    expect(html).toContain("2 × CA$10.00");
    expect(html).toContain("CA$20.00");
    expect(html).toContain("Hi-vis vest");
    expect(html).toContain("CA$25.50");
    expect(html).toContain("2 lines");
    expect(html).toContain("Riley Oakes");
    expect(html).toContain("Halifax NS B3H 1A1");
    expect(html).toContain("Deliver before noon");
  });

  it("re-renders with the content that will actually go out after a change", () => {
    const fresh = poFixture({
      notes: "Leave at the side door",
      lines: [{ description: "Hard Hat (Orange)", sku: "HH-2", quantity: 40, unitCost: "12.00" }],
      subtotal: "480.00",
      contentVersion: "2.bbbb",
    });
    const html = confirmStep(reconfirmPending(pendingOf(), { recipients: NORTH, message: "This purchase order changed since you reviewed it.", po: fresh }, "request-9"));
    expect(html).toContain("Hard Hat (Orange)");
    expect(html).toContain("40 × CA$12.00");
    expect(html).toContain("CA$480.00");
    expect(html).toContain("Leave at the side door");
    expect(html).not.toContain("Hard Hat (White)");
    expect(html).not.toContain("Deliver before noon");
    expect(html).toContain("This purchase order changed since you reviewed it.");
  });

  it("will not send content with a line that has no cost", () => {
    const unpriced = poFixture({ lines: [{ description: "Gloves", sku: "", quantity: 3, unitCost: null }], subtotal: null });
    const html = confirmStep(pendingOf({}, unpriced));
    expect(html).toContain("Not priced");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="[^"]*"[^>]*>.*Send to vendor/);
  });

  // The step opens on its question, not on the irreversible send: a double
  // Enter or a held Enter from the button that opened it must not send.
  it("can take focus on its question, which labels the step", () => {
    const html = confirmStep(pendingOf({ recipients: { to: ["orders@northline.example"], cc: [] }, requestId: "request-3" }));
    const labelledBy = html.match(/role="group" aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    const question = html.match(new RegExp(`<p id="${labelledBy}"[^>]*>`))?.[0] ?? "";
    expect(question).toContain('tabindex="-1"');
  });
});

describe("confirmFocus", () => {
  const step = (busy: boolean, requestId = "r1") => ({ busy, requestId });

  it("puts focus on the question when the step opens", () => {
    expect(confirmFocus(null, step(false))).toBe("question");
  });

  it("puts focus on the question again for a new confirmation (who it goes to changed)", () => {
    expect(confirmFocus(step(true, "r1"), step(false, "r2"))).toBe("question");
  });

  it("gives focus back to the send button when the same send settles and the step stays open", () => {
    expect(confirmFocus(step(true), step(false))).toBe("send");
  });

  it("leaves focus alone otherwise", () => {
    expect(confirmFocus(step(false), step(true))).toBeNull();
    expect(confirmFocus(step(false), step(false))).toBeNull();
  });
});

describe("confirmArmed", () => {
  it("ignores a send pressed in the first moment after the step opens", () => {
    expect(confirmArmed(null, 10_000)).toBe(false);
    expect(confirmArmed(10_000, 10_000 + CONFIRM_ARM_MS - 1)).toBe(false);
    expect(confirmArmed(10_000, 10_000 + CONFIRM_ARM_MS)).toBe(true);
    expect(CONFIRM_ARM_MS).toBeGreaterThanOrEqual(300);
  });
});

describe("PO modal footer", () => {
  // "Send to vendor" only ever means the final, irreversible send in the
  // confirmation step; the form's own button opens that step.
  it("offers Save draft and Review and send, never Send to vendor", () => {
    const html = renderToStaticMarkup(
      createElement(DraftActions, {
        saved: null,
        saving: false,
        locked: false,
        sendBlocked: false,
        onSaveDraft: () => {},
        onReview: () => {},
      }),
    );
    expect(html).toContain("Save draft");
    expect(html).toContain("Review and send");
    expect(html).not.toContain("Send to vendor");
    expect(html).toMatch(/<button id="po-save-draft"/);
    expect(html).toMatch(/<button id="po-send"/);
  });

  // Header and footer must never push the footer's buttons out of a short
  // window (a phone held sideways, or 200% zoom): the footer scrolls itself.
  it("is its own scroll area, capped below the window height, and the body gives up room first", () => {
    const html = renderToStaticMarkup(createElement(PoModalFooter, null, "Buttons"));
    const classes = (html.match(/<footer[^>]*class="([^"]*)"/)?.[1] ?? "").split(" ");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).toContain("overscroll-contain");
    expect(classes).toContain("max-h-[60dvh]");
    expect(classes).not.toContain("shrink-0");
    const body = renderToStaticMarkup(createElement(PoModalBody, null, "Form")).match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
    expect(body).toContain("overflow-y-auto");
    expect(body).toContain("shrink-[1000]");
  });
});
