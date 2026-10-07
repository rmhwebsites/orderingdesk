import { describe, it, expect } from "vitest";
import { itemTotals } from "./items";

describe("itemTotals", () => {
  it("adds quantities per item and size, most ordered first", () => {
    const snapshot = (items: { title: string; variant?: string; qty?: number }[]) => ({ items });
    expect(
      itemTotals(
        [
          snapshot([{ title: "Hard Hat", variant: "White", qty: 2 }, { title: "Safety Vest", variant: "L" }]),
          snapshot([{ title: "hard hat", variant: "white", qty: 3 }, { title: "Hard Hat", variant: "Yellow" }, { title: "" }]),
          null,
        ],
        10,
      ),
    ).toEqual([
      { title: "Hard Hat", variant: "White", quantity: 5 },
      { title: "Hard Hat", variant: "Yellow", quantity: 1 },
      { title: "Safety Vest", variant: "L", quantity: 1 },
    ]);
  });

  it("keeps the top entries only", () => {
    const many = [{ items: Array.from({ length: 30 }, (_, i) => ({ title: `Item ${i}`, qty: 1 })) }];
    expect(itemTotals(many, 10)).toHaveLength(10);
  });
});
