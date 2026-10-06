import { describe, it, expect } from "vitest";
import { cardAge } from "./age";

const NOW = Date.parse("2026-10-05T15:00:00.000Z");
const DAY = 86400000;
const rule = { amberDays: 2, redDays: 4, closed: false };

describe("cardAge", () => {
  it("reads minutes, hours and days from the status change, else the arrival", () => {
    expect(cardAge({ statusSetAt: NOW - 30000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "1m", long: "1 minute" });
    expect(cardAge({ statusSetAt: NOW - 59 * 60000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "59m" });
    expect(cardAge({ statusSetAt: NOW - 5 * 3600000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "5h", long: "5 hours" });
    expect(cardAge({ statusSetAt: null, createdAt: NOW - 26 * 3600000 }, NOW, rule)).toMatchObject({
      short: "1d",
      long: "1 day",
      since: NOW - 26 * 3600000,
    });
  });

  it("turns amber at the amber threshold and red at the red one", () => {
    expect(cardAge({ statusSetAt: NOW - 2 * DAY + 1000, createdAt: 0 }, NOW, rule).tone).toBe("none");
    expect(cardAge({ statusSetAt: NOW - 2 * DAY, createdAt: 0 }, NOW, rule).tone).toBe("amber");
    expect(cardAge({ statusSetAt: NOW - 4 * DAY, createdAt: 0 }, NOW, rule).tone).toBe("red");
  });

  it("never warns on a closed card, nor on a clock that runs behind", () => {
    expect(cardAge({ statusSetAt: NOW - 30 * DAY, createdAt: 0 }, NOW, { ...rule, closed: true }).tone).toBe("none");
    expect(cardAge({ statusSetAt: NOW + 60000, createdAt: 0 }, NOW, rule)).toMatchObject({ short: "1m", tone: "none" });
  });
});
