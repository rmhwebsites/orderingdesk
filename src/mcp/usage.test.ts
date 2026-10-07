import { describe, it, expect } from "vitest";
import { claimChange, claimRead, mcpUsageToday } from "./usage";
import { NOW, principalFor, setupMcp } from "./test-helpers";

describe("MCP daily limits", () => {
  it("counts lookups and changes per person per UTC day, separately, up to each limit", async () => {
    const db = await setupMcp();
    const p = principalFor("staff", { limits: { reads: 2, changes: 1 } });
    expect(await claimRead(db, p, NOW)).toBe(true);
    expect(await claimRead(db, p, NOW)).toBe(true);
    expect(await claimRead(db, p, NOW)).toBe(false);
    expect(await claimChange(db, p, NOW)).toBe(true);
    expect(await claimChange(db, p, NOW)).toBe(false);
    expect(await mcpUsageToday(db, p, NOW)).toEqual({ reads: 2, changes: 1 });
    const tomorrow = NOW + 24 * 60 * 60 * 1000;
    expect(await claimRead(db, p, tomorrow)).toBe(true);
    expect(await mcpUsageToday(db, p, tomorrow)).toEqual({ reads: 1, changes: 0 });
  });

  it("keeps each person's count apart", async () => {
    const db = await setupMcp();
    const staff = principalFor("staff", { limits: { reads: 1, changes: 1 } });
    const manager = principalFor("manager", { limits: { reads: 1, changes: 1 } });
    expect(await claimRead(db, staff, NOW)).toBe(true);
    expect(await claimRead(db, manager, NOW)).toBe(true);
    expect(await claimRead(db, staff, NOW)).toBe(false);
  });
});
