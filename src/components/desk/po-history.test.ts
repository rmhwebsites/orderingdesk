import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/toasts";
import { PurchaseOrders } from "./po-history";
import { DraftActions, PoModalBody, PoModalFooter } from "./po-modal";
import { CONFIRM_ARM_MS, confirmArmed, confirmFocus, SendConfirm } from "./po-send-confirm";

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

describe("SendConfirm", () => {
  it("names the vendor and every address before the explicit send", () => {
    const html = renderToStaticMarkup(
      createElement(SendConfirm, {
        pending: {
          poId: "po1",
          label: "purchase order IMP-2026-0042",
          vendorName: "Northline Supply",
          recipients: { to: ["orders@northline.example"], cc: ["rep@northline.example", "office@impact.example"] },
          resend: false,
          requestId: "request-1",
          message: null,
        },
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain("Send purchase order IMP-2026-0042 to Northline Supply?");
    expect(html).toContain("orders@northline.example");
    expect(html).toContain("rep@northline.example, office@impact.example");
    expect(html).toContain("Send to vendor");
    expect(html).toContain("Cancel");
  });

  it("says Send again for a resend", () => {
    const html = renderToStaticMarkup(
      createElement(SendConfirm, {
        pending: {
          poId: "po1",
          label: "purchase order IMP-2026-0042",
          vendorName: "Northline Supply",
          recipients: { to: ["orders@northline.example"], cc: [] },
          resend: true,
          requestId: "request-2",
          message: "Who it goes to changed.",
        },
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toContain("again to Northline Supply?");
    expect(html).toContain("No copies");
    expect(html).toContain("Send again");
    expect(html).toContain("Who it goes to changed.");
  });

  // The step opens on its question, not on the irreversible send: a double
  // Enter or a held Enter from the button that opened it must not send.
  it("can take focus on its question, which labels the step", () => {
    const html = renderToStaticMarkup(
      createElement(SendConfirm, {
        pending: {
          poId: "po1",
          label: "purchase order IMP-2026-0042",
          vendorName: "Northline Supply",
          recipients: { to: ["orders@northline.example"], cc: [] },
          resend: false,
          requestId: "request-3",
          message: null,
        },
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
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
