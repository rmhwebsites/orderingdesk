import { describe, it, expect } from "vitest";
import { readSnapshot } from "./order-snapshot";
import { emptyLine, formFromOrder, formFromPo, formTotals, readForm, sameForm, type PoForm } from "./po-form";

// The review modal's form: prefill, what the reviewer typed read back into
// a draft body (with a message per field), totals and the unsaved check.

const snapshot = readSnapshot({
  currency: "CAD",
  items: [
    { title: "Hard Hat", variant: "White", sku: "HH-1", qty: 2, price: "10.00" },
    { title: "Vest", variant: "", sku: "", qty: 1, price: "5.00" },
  ],
  shipping: { name: "Riley Oakes", a1: "12 Harbour St", a2: "", city: "Halifax", prov: "NS", zip: "B3H 1A1", country: "Canada" },
});

function form(overrides: Partial<PoForm> = {}): PoForm {
  return { ...formFromOrder(snapshot), vendorId: "v_north", ...overrides };
}

describe("formFromOrder", () => {
  it("prefills lines (no cost) and the ship-to from the order", () => {
    const prefilled = formFromOrder(snapshot);
    expect(prefilled.vendorId).toBe("");
    expect(prefilled.lines.map(({ description, sku, quantity, unitCost }) => ({ description, sku, quantity, unitCost }))).toEqual([
      { description: "Hard Hat (White)", sku: "HH-1", quantity: "2", unitCost: "" },
      { description: "Vest", sku: "", quantity: "1", unitCost: "" },
    ]);
    expect(prefilled.shipTo).toBe("Riley Oakes\n12 Harbour St\nHalifax NS B3H 1A1\nCanada");
    expect(prefilled.notes).toBe("");
    expect(new Set(prefilled.lines.map((line) => line.key)).size).toBe(2);
  });

  it("starts with one empty line for an order without items", () => {
    const prefilled = formFromOrder(readSnapshot({ items: [] }));
    expect(prefilled.lines).toHaveLength(1);
    expect(prefilled.lines[0]).toMatchObject({ description: "", quantity: "1", unitCost: "" });
    expect(prefilled.shipTo).toBe("");
  });
});

describe("readForm", () => {
  it("reads a reviewed form into a draft body, tidying costs", () => {
    const filled = form();
    filled.lines[0].unitCost = "$1,210.5";
    filled.lines[1].unitCost = "4";
    const result = readForm({ ...filled, shipTo: " Riley Oakes \n\n Halifax ", notes: "  Before noon " }, { requireCosts: true });
    expect(result).toEqual({
      ok: true,
      body: {
        vendorId: "v_north",
        lines: [
          { description: "Hard Hat (White)", sku: "HH-1", quantity: 2, unitCost: "1210.50" },
          { description: "Vest", sku: "", quantity: 1, unitCost: "4.00" },
        ],
        shipTo: ["Riley Oakes", "Halifax"],
        notes: "Before noon",
      },
    });
  });

  it("lets a draft leave costs blank, but not a send", () => {
    expect(readForm(form(), { requireCosts: false }).ok).toBe(true);
    const result = readForm(form(), { requireCosts: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.values(result.errors.lines).map((line) => line.unitCost)).toEqual([
        "Enter the unit cost",
        "Enter the unit cost",
      ]);
    }
  });

  it("names each problem next to its field", () => {
    const bad = form({ vendorId: "", shipTo: Array(9).fill("line").join("\n"), notes: "n".repeat(2001) });
    bad.lines[0] = { ...bad.lines[0], description: "  ", quantity: "0", unitCost: "abc" };
    bad.lines[1] = { ...bad.lines[1], quantity: "1.5" };
    const result = readForm(bad, { requireCosts: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.vendor).toBe("Pick a vendor");
      expect(result.errors.lines[bad.lines[0].key]).toEqual({
        description: "Add a description",
        quantity: "Enter a whole number from 1 to 99,999",
        unitCost: "Enter an amount like 12.50",
      });
      expect(result.errors.lines[bad.lines[1].key]).toEqual({ quantity: "Enter a whole number from 1 to 99,999" });
      expect(result.errors.shipTo).toBe("Use up to 8 lines of up to 120 characters");
      expect(result.errors.notes).toBe("Keep notes to 2,000 characters");
    }
  });

  it("needs at least one line", () => {
    const result = readForm(form({ lines: [] }), { requireCosts: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.form).toBe("Add at least one line");
    }
  });
});

describe("formTotals", () => {
  it("totals what can be totaled, in cents", () => {
    const filled = form();
    filled.lines[0].unitCost = "10.10";
    const partial = formTotals(filled);
    expect(partial.lineTotals[filled.lines[0].key]).toBe(2020);
    expect(partial.lineTotals[filled.lines[1].key]).toBeNull();
    expect(partial.subtotalCents).toBeNull();
    filled.lines[1].unitCost = "0.05";
    expect(formTotals(filled).subtotalCents).toBe(2025);
  });
});

describe("sameForm and formFromPo", () => {
  it("tells unsaved edits from a form as it was saved, ignoring line keys", () => {
    const saved = form();
    const copy: PoForm = { ...saved, lines: saved.lines.map((line) => ({ ...line, key: line.key + "x" })) };
    expect(sameForm(saved, copy)).toBe(true);
    expect(sameForm(saved, { ...copy, notes: "changed" })).toBe(false);
    expect(sameForm(saved, { ...copy, lines: [...copy.lines, emptyLine()] })).toBe(false);
  });

  it("loads a saved PO back into the form", () => {
    const loaded = formFromPo({
      vendor: { id: "v_north", name: "Northline", email: "o@n.example", cc: [], archived: false },
      lines: [{ description: "Gloves", sku: "G-1", quantity: 3, unitCost: "2.50" }, { description: "Tape", sku: "", quantity: 1, unitCost: null }],
      shipTo: ["Riley Oakes", "Halifax"],
      notes: null,
    });
    expect(loaded).toMatchObject({ vendorId: "v_north", shipTo: "Riley Oakes\nHalifax", notes: "" });
    expect(loaded.lines.map(({ quantity, unitCost }) => [quantity, unitCost])).toEqual([
      ["3", "2.50"],
      ["1", ""],
    ]);
    expect(formFromPo({ vendor: { id: "v_gone", name: "", email: "", cc: [], archived: true }, lines: [], shipTo: [], notes: null }).vendorId).toBe("");
  });
});
