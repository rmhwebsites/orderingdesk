import { describe, it, expect } from "vitest";
import { newId, randomHex, sixDigitCode } from "./ids";

describe("ids", () => {
  it("makes unguessable url-safe ids, hex markers and 6-digit codes", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    for (let i = 0; i < 200; i++) {
      expect(sixDigitCode()).toMatch(/^\d{6}$/);
    }
  });
});
