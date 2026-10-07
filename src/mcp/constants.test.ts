import { describe, it, expect } from "vitest";
import { ACCESS_TOKEN_TTL_S, ACTION_TTL_MS, GRANT_TTL_MS, GRANT_TTL_S } from "./constants";

// Owner decision 1 (Oct 7, 2026): a connection lasts 90 days, fixed; access
// tokens stay short and a revoke stays instant (the D1 mirror).
describe("lifetimes", () => {
  it("keeps a connection 90 days, an access token 30 minutes and a confirmation 10 minutes", () => {
    expect(GRANT_TTL_S).toBe(90 * 24 * 60 * 60);
    expect(GRANT_TTL_MS).toBe(GRANT_TTL_S * 1000);
    expect(ACCESS_TOKEN_TTL_S).toBe(30 * 60);
    expect(ACTION_TTL_MS).toBe(10 * 60 * 1000);
  });
});
