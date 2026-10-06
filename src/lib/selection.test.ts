import { describe, it, expect } from "vitest";
import { selectAll, toggleSelection } from "./selection";

const ids = ["a", "b", "c", "d", "e"];
const none = { selected: new Set<string>(), anchor: null };

describe("toggleSelection", () => {
  it("toggles one card and remembers it as the anchor", () => {
    const one = toggleSelection(none, ids, "b", { range: false, max: 25 });
    expect([...one.selected]).toEqual(["b"]);
    expect(one.anchor).toBe("b");
    expect([...toggleSelection(one, ids, "b", { range: false, max: 25 }).selected]).toEqual([]);
  });

  it("selects or clears every card between the anchor and a shift-clicked one, in list order", () => {
    const anchored = toggleSelection(none, ids, "b", { range: false, max: 25 });
    const range = toggleSelection(anchored, ids, "d", { range: true, max: 25 });
    expect([...range.selected].sort()).toEqual(["b", "c", "d"]);
    const cleared = toggleSelection(range, ids, "c", { range: true, max: 25 });
    expect([...cleared.selected].sort()).toEqual(["b"]);
  });

  it("stops at the cap and says so", () => {
    const capped = toggleSelection({ selected: new Set(["a"]), anchor: "a" }, ids, "e", { range: true, max: 3 });
    expect(capped.selected.size).toBe(3);
    expect(capped.capped).toBe(true);
  });
});

describe("selectAll", () => {
  it("selects every card shown up to the cap", () => {
    expect(selectAll(ids, 25)).toEqual({ selected: new Set(ids), capped: false });
    expect(selectAll(ids, 2)).toEqual({ selected: new Set(["a", "b"]), capped: true });
  });
});
