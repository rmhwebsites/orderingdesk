import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { contrastRatio } from "@/lib/accent";
import { encodePng } from "@/server/pwa/icon";
import { pdfHeadingColor, renderPoPdf, type PoPdfInput } from "./pdf";

// The branded purchase order PDF. Text is checked by inflating the page
// content streams and decoding the strings drawn with Tj (pdf-lib writes
// standard-font text as Windows-1252 hex strings).

// Windows-1252 bytes 0x80 to 0x9f (Node decodes the label as Latin-1).
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeCp1252(bytes: Buffer): string {
  return [...bytes].map((byte) => String.fromCodePoint(CP1252_HIGH[byte] ?? byte)).join("");
}

function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const stream of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(stream[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const shown of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      out.push(decodeCp1252(Buffer.from(shown[1], "hex")));
    }
  }
  return out.join("\n");
}

function input(overrides: Partial<PoPdfInput> = {}): PoPdfInput {
  return {
    workspaceName: "Impact Rentals",
    primaryColor: "#91d500",
    replyTo: "office@impactrentals.example",
    logo: null,
    poNumber: "IMP-2026-0041",
    date: Date.UTC(2026, 9, 4, 15),
    orderName: "#1001",
    vendor: { name: "Northline Safety Supply", email: "orders@northline.example" },
    shipTo: ["Riley Oakes", "12 Harbour St", "Halifax NS B3H 1A1", "Canada"],
    lines: [
      { description: "Hard Hat (White)", sku: "HH-1", quantity: 3, unitCost: "10.10" },
      { description: "Hi-vis vest", sku: "", quantity: 2, unitCost: "0.05" },
    ],
    currency: "USD",
    notes: "Deliver to the loading dock before noon.",
    ...overrides,
  };
}

async function pagesOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => page.getSize());
}

describe("renderPoPdf", () => {
  it("renders a one-page US Letter PDF with the PO, the vendor, ship-to, lines, totals and footer", async () => {
    const bytes = await renderPoPdf(input());
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1024);
    expect(await pagesOf(bytes)).toEqual([{ width: 612, height: 792 }]);
    const text = pdfText(bytes);
    for (const expected of [
      "Impact Rentals",
      "office@impactrentals.example",
      "Purchase order",
      "IMP-2026-0041",
      "Oct 4, 2026",
      "#1001",
      "Northline Safety Supply",
      "orders@northline.example",
      "12 Harbour St",
      "Hard Hat (White)",
      "HH-1",
      "$10.10",
      "$30.30",
      "$30.40",
      "Subtotal",
      "Total",
      "Deliver to the loading dock before noon.",
      "Page 1 of 1",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("paginates many lines without splitting or repeating a row, repeating the table header", async () => {
    const lines = Array.from({ length: 90 }, (_, i) => ({
      description: `Item number ${i + 1} with a description long enough to wrap onto a second line in the table`,
      sku: `SKU-${i + 1}`,
      quantity: i + 1,
      unitCost: "1.00",
    }));
    const bytes = await renderPoPdf(input({ lines }));
    const pages = await pagesOf(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const text = pdfText(bytes);
    for (let i = 1; i <= pages.length; i++) {
      expect(text).toContain(`Page ${i} of ${pages.length}`);
    }
    for (let i = 1; i <= 90; i++) {
      expect(text.split("\n").filter((line) => line === `SKU-${i}`)).toHaveLength(1);
    }
    // Every page with rows starts with the table header (the totals may
    // end up alone on the last page).
    expect(text.split("\n").filter((line) => line === "Description").length).toBeGreaterThanOrEqual(pages.length - 1);
    expect(text).toContain("(continued)");
  });

  it("does not crash on long, unbroken or non-Latin text, and keeps it on the page", async () => {
    const bytes = await renderPoPdf(
      input({
        workspaceName: "W".repeat(80),
        vendor: { name: "Vendor ".repeat(17).trim(), email: "a".repeat(60) + "@vendor.example" },
        shipTo: Array.from({ length: 8 }, () => "Z".repeat(120)),
        lines: [
          { description: "X".repeat(300), sku: "S".repeat(64), quantity: 99999, unitCost: "9999999.99" },
          { description: "Curly \u201cquotes\u201d, emoji \u{1F600}, CJK \u6f22\u5b57, em dash \u2014 done", sku: "", quantity: 1, unitCost: "1.00" },
          { description: "Tabs\tand\nnewlines", sku: "", quantity: 1, unitCost: null },
        ],
        notes: "Note ".repeat(400),
      }),
    );
    expect((await pagesOf(bytes)).length).toBeGreaterThanOrEqual(1);
    const text = pdfText(bytes);
    expect(text).toContain("\u201cquotes\u201d");
    expect(text).not.toContain("\u6f22");
    expect(text).toContain("Not priced");
  });

  it("falls back to the workspace name when the logo is missing or unreadable, and embeds a PNG logo", async () => {
    const missing = pdfText(await renderPoPdf(input({ logo: null })));
    expect(missing).toContain("Impact Rentals");

    const garbage = await renderPoPdf(input({ logo: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }));
    expect(pdfText(garbage)).toContain("Impact Rentals");

    const png = await encodePng(120, 40, new Uint8Array(120 * 40 * 4).fill(200));
    const withLogo = await renderPoPdf(input({ logo: png }));
    expect(Buffer.from(withLogo).toString("latin1")).toContain("/Subtype /Image");
  });

  it("works without a primary color, reply-to, ship-to, notes or a minted date in the far future", async () => {
    const bytes = await renderPoPdf(input({ primaryColor: null, replyTo: null, shipTo: [], notes: null }));
    const text = pdfText(bytes);
    expect(text).toContain("No ship-to address");
    expect(text).not.toContain("Notes");
  });
});

describe("pdfHeadingColor", () => {
  it("keeps headings readable on white whatever the primary color", () => {
    for (const primary of ["#91d500", "#ffff00", "#ffffff", "#101820", "#1b4c9a"]) {
      expect(contrastRatio(pdfHeadingColor(primary), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
    expect(pdfHeadingColor("#1b4c9a")).toBe("#1b4c9a");
  });
});
