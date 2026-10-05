import { describe, it, expect } from "vitest";
import type { MailWorkspace } from "@/server/email/workspace";
import { vendorPoEmail, type VendorPoEmailInput } from "./email";
import { isPoPdfKeyFor, loadLogoBytes, poPdfKey, toBase64 } from "./storage";
import { fakeBucket } from "./test-helpers";

const env = { APP_URL: "https://orderingdesk.test" } as unknown as CloudflareEnv;

function workspace(overrides: Partial<MailWorkspace> = {}): MailWorkspace {
  return {
    id: "ws_impact",
    name: "IMPACT Rentals",
    slug: "impact",
    accentColor: "#91d500",
    branding: null,
    customDomain: null,
    customDomainStatus: null,
    sendingAddress: null,
    sendingVerifiedAt: null,
    replyTo: "office@impact.example",
    ...overrides,
  };
}

function po(overrides: Partial<VendorPoEmailInput> = {}): VendorPoEmailInput {
  return {
    poNumber: "IMP-2026-0041",
    orderName: "#1001",
    vendorName: "Northline Supply",
    lines: [
      { description: "Hard hat", sku: "HH-1", quantity: 2, unitCost: "10.00" },
      { description: "Vest", sku: "", quantity: 3, unitCost: "5.00" },
    ],
    currency: "CAD",
    subtotalCents: 3500,
    shipTo: ["Riley Oakes", "12 Harbour St"],
    notes: "Deliver before noon",
    date: Date.UTC(2026, 9, 4, 15),
    ...overrides,
  };
}

describe("vendorPoEmail", () => {
  it("summarizes the PO in the workspace's branded layout, with no button", () => {
    const email = vendorPoEmail(env, workspace(), po());
    expect(email.subject).toBe("Purchase order IMP-2026-0041 from IMPACT Rentals");
    for (const expected of ["Hello Northline Supply,", "IMP-2026-0041", "Oct 4, 2026", "Order #1001", "2 lines, 5 units", "CA$35.00", "Riley Oakes<br>12 Harbour St", "Deliver before noon", "Reply to this email"]) {
      expect(email.html).toContain(expected);
    }
    expect(email.html).not.toContain("<a href");
    expect(email.text).toContain("The PDF is attached");
  });

  it("escapes every value in the body and keeps the subject on one line", () => {
    const email = vendorPoEmail(
      env,
      workspace({ name: "Bad <b>Co</b>\r\nBcc: x@y.z", replyTo: null }),
      po({ vendorName: "<script>alert(1)</script>", notes: "<img src=x onerror=alert(1)>", shipTo: ["<b>Riley</b>"] }),
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<b>Riley</b>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
    // Without a reply-to, it does not invite replies to the sending address.
    expect(email.html).not.toContain("Reply to this email");
  });

  it("shortens very long notes, pointing to the PDF", () => {
    const email = vendorPoEmail(env, workspace(), po({ notes: "n".repeat(2000) }));
    expect(email.html).toContain("(the PDF has the full notes)");
    expect(email.html).not.toContain("n".repeat(700));
  });
});

describe("PO storage", () => {
  it("keys PDFs under pos/<workspace>/<po>-<32 random hex>.pdf, and recognizes only those", () => {
    const key = poPdfKey("ws_impact", "po1");
    expect(key).toMatch(/^pos\/ws_impact\/po1-[0-9a-f]{32}\.pdf$/);
    expect(poPdfKey("ws_impact", "po1")).not.toBe(key);
    expect(isPoPdfKeyFor(key, "ws_impact", "po1")).toBe(true);
    expect(isPoPdfKeyFor(key, "ws_other", "po1")).toBe(false);
    expect(isPoPdfKeyFor(key, "ws_impact", "po")).toBe(false);
    expect(isPoPdfKeyFor(`pos/ws_impact/po1-${"a".repeat(32)}.pdf/../x`, "ws_impact", "po1")).toBe(false);
  });

  it("reads the logo's PNG copy from the workspace's branding prefix only, never an SVG", async () => {
    const bucket = fakeBucket();
    const png = `branding/ws_impact/logo-light-${"a".repeat(32)}.png`;
    bucket.objects.set(png, { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" });
    const svg = `branding/ws_impact/logo-light-${"b".repeat(32)}.svg`;
    bucket.objects.set(svg, { bytes: new Uint8Array([1]), contentType: "image/svg+xml" });

    expect(await loadLogoBytes(bucket, "ws_impact", { logo: { light: { key: svg, contentType: "image/svg+xml", pngKey: png }, dark: null } })).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(await loadLogoBytes(bucket, "ws_impact", { logo: { light: { key: svg, contentType: "image/svg+xml", pngKey: null }, dark: null } })).toBeNull();
    expect(await loadLogoBytes(bucket, "ws_other", { logo: { light: { key: png, contentType: "image/png", pngKey: null }, dark: null } })).toBeNull();
    expect(await loadLogoBytes(bucket, "ws_impact", null)).toBeNull();
    expect(bucket.gets).toEqual([png]);
  });

  it("encodes large PDFs to base64 without overflowing", () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(toBase64(bytes)), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});
