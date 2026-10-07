import { describe, it, expect } from "vitest";
import { shouldAskAi } from "./search-shortcut";

describe("shouldAskAi", () => {
  it("keeps order and request numbers and one or two words on keyword search", () => {
    for (const query of ["#1024", "1024", "#D19", "d19", "# D 19", "hard hat", "business cards", "stone", "", "   "]) {
      expect(shouldAskAi(query), query).toBe(false);
    }
  });

  it("sends questions of three words or more to the model", () => {
    for (const query of ["business cards for Stone", "requests from North Yard last month", "hard hats waiting since Monday"]) {
      expect(shouldAskAi(query), query).toBe(true);
    }
  });
});
