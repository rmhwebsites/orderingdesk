import { describe, it, expect } from "vitest";
import { DEFAULT_QUEUE_SETTINGS, parseQueueSettings } from "./queue-settings";

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
