import { describe, it, expect } from "vitest";
import { DEFAULT_QUEUE_SETTINGS, isPriced, parseQueueSettings, pricesShown } from "./queue-settings";

describe("parseQueueSettings", () => {
  it("accepts whole days with red after amber, and a price display mode", () => {
    expect(parseQueueSettings({ ageAmberDays: 3, ageRedDays: 7, priceDisplay: "hide" })).toEqual({
      ageAmberDays: 3,
      ageRedDays: 7,
      priceDisplay: "hide",
    });
    expect(DEFAULT_QUEUE_SETTINGS).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });
  });

  it("says what is wrong in plain words", () => {
    expect(parseQueueSettings(null)).toBe("Send ageAmberDays, ageRedDays and priceDisplay");
    expect(parseQueueSettings({ ageAmberDays: 0, ageRedDays: 4, priceDisplay: "auto" })).toBe(
      "Amber after must be a whole number of days from 1 to 60",
    );
    expect(parseQueueSettings({ ageAmberDays: 2, ageRedDays: 2.5, priceDisplay: "auto" })).toBe(
      "Red after must be a whole number of days from 1 to 90",
    );
    expect(parseQueueSettings({ ageAmberDays: 4, ageRedDays: 4, priceDisplay: "auto" })).toBe(
      "Red must come after amber: pick more days for red",
    );
    expect(parseQueueSettings({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "always" })).toBe(
      "Show prices must be auto, show or hide",
    );
  });
});

describe("pricesShown", () => {
  it("follows show and hide, and in auto shows prices only when more than 5% of cards have one", () => {
    const free = Array.from({ length: 40 }, () => "0.00");
    expect(pricesShown("show", free)).toBe(true);
    expect(pricesShown("hide", ["48.00"])).toBe(false);
    expect(pricesShown("auto", free)).toBe(false);
    expect(pricesShown("auto", [...free.slice(0, 39), "48.00"])).toBe(false);
    expect(pricesShown("auto", [...free.slice(0, 18), "48.00", "12.00"])).toBe(true);
    expect(pricesShown("auto", [])).toBe(false);
  });

  it("counts a total as a price only when it is a number other than 0", () => {
    expect(isPriced("0.00")).toBe(false);
    expect(isPriced("")).toBe(false);
    expect(isPriced("n/a")).toBe(false);
    expect(isPriced("12.50")).toBe(true);
  });
});
