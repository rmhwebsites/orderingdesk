import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/toasts";
import { PurchaseOrders } from "./po-history";
import { SendConfirm } from "./po-send-confirm";

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
});
