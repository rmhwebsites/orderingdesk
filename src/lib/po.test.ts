import { describe, it, expect } from "vitest";
import {
  centsToDecimal,
  costToCents,
  formatCents,
  lineTotalCents,
  linesFromOrderItems,
  normalizeCostInput,
  recipientsFor,
  sameRecipients,
  subtotalCents,
} from "./po";

describe("PO money", () => {
  it("reads unit costs as whole cents, refusing anything but plain decimals", () => {
    expect(costToCents("12")).toBe(1200);
    expect(costToCents("12.5")).toBe(1250);
    expect(costToCents("12.05")).toBe(1205);
    expect(costToCents("0")).toBe(0);
    expect(costToCents("9999999.99")).toBe(999999999);
    for (const bad of ["", "-1", "1.234", "abc", "1e3", "12.", ".5", "10000000", " 12", "1,200"]) {
      expect(costToCents(bad)).toBeNull();
    }
  });

  it("writes cents back as a two-decimal amount", () => {
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(123456)).toBe("1234.56");
  });

  it("tidies what a person types into a cost field", () => {
    expect(normalizeCostInput(" $1,234.5 ")).toBe("1234.50");
    expect(normalizeCostInput("12")).toBe("12.00");
    expect(normalizeCostInput("")).toBe("");
    expect(normalizeCostInput("   ")).toBe("");
    expect(normalizeCostInput("twelve")).toBeNull();
    expect(normalizeCostInput("-3")).toBeNull();
    expect(normalizeCostInput("1.999")).toBeNull();
  });

  it("totals lines in cents, and has no subtotal while any cost is missing", () => {
    const lines = [
      { description: "Hard hat", sku: "HH-1", quantity: 3, unitCost: "10.10" },
      { description: "Vest", sku: "", quantity: 2, unitCost: "0.05" },
    ];
    expect(lineTotalCents(lines[0])).toBe(3030);
    expect(subtotalCents(lines)).toBe(3040);
    expect(subtotalCents([...lines, { description: "Gloves", sku: "", quantity: 1, unitCost: null }])).toBeNull();
    expect(lineTotalCents({ description: "Gloves", sku: "", quantity: 1, unitCost: null })).toBeNull();
    expect(subtotalCents([])).toBe(0);
  });

  it("formats cents in the order's currency", () => {
    expect(formatCents(123450, "USD")).toBe("$1,234.50");
    expect(formatCents(500, "CAD")).toBe("CA$5.00");
  });
});

describe("linesFromOrderItems", () => {
  it("prefills description (with the variant), SKU and quantity, leaving the cost to the reviewer", () => {
    expect(
      linesFromOrderItems([
        { title: "Hard Hat", variant: "White", sku: "HH-1", qty: 2, price: "10.00" },
        { title: "", variant: "", sku: "", qty: 1, price: null },
      ]),
    ).toEqual([
      { description: "Hard Hat (White)", sku: "HH-1", quantity: 2, unitCost: null },
      { description: "Untitled item", sku: "", quantity: 1, unitCost: null },
    ]);
  });

  it("keeps prefilled text within the field limits", () => {
    const [line] = linesFromOrderItems([{ title: "x".repeat(400), variant: "", sku: "s".repeat(80), qty: 0, price: null }]);
    expect(line.description.length).toBe(300);
    expect(line.sku.length).toBe(64);
    expect(line.quantity).toBe(1);
  });
});

describe("recipientsFor", () => {
  it("sends to the vendor, copying the vendor's other addresses and the workspace list once each", () => {
    expect(
      recipientsFor(
        { email: "orders@vendor.example", cc: ["rep@vendor.example", "orders@vendor.example"] },
        ["office@impact.example", "rep@vendor.example"],
      ),
    ).toEqual({ to: ["orders@vendor.example"], cc: ["rep@vendor.example", "office@impact.example"] });
  });

  it("compares recipient lists without regard to order or case", () => {
    const a = { to: ["orders@vendor.example"], cc: ["b@x.example", "a@x.example"] };
    expect(sameRecipients(a, { to: ["ORDERS@vendor.example"], cc: ["a@x.example", "b@x.example"] })).toBe(true);
    expect(sameRecipients(a, { to: ["orders@vendor.example"], cc: ["a@x.example"] })).toBe(false);
    expect(sameRecipients(a, { to: ["other@vendor.example"], cc: ["a@x.example", "b@x.example"] })).toBe(false);
    expect(sameRecipients(a, { to: ["orders@vendor.example"], cc: ["a@x.example", "a@x.example"] })).toBe(false);
  });
});
