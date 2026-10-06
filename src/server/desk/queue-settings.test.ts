import { describe, it, expect } from "vitest";
import { getQueueSettings, updateQueueSettings } from "./queue-settings";
import { openTestDb, seedWorkspace } from "./test-helpers";

const WS = "ws_impact";

describe("queue settings", () => {
  it("reads the defaults, saves a valid change and refuses an invalid one without writing", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    await seedWorkspace(db, "ws_other");
    expect(await getQueueSettings(db, WS)).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });

    expect(await updateQueueSettings(db, WS, { ageAmberDays: 3, ageRedDays: 6, priceDisplay: "show" })).toEqual({
      kind: "ok",
      queue: { ageAmberDays: 3, ageRedDays: 6, priceDisplay: "show" },
    });
    expect(await getQueueSettings(db, WS)).toEqual({ ageAmberDays: 3, ageRedDays: 6, priceDisplay: "show" });
    expect(await getQueueSettings(db, "ws_other")).toEqual({ ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" });

    expect(await updateQueueSettings(db, WS, { ageAmberDays: 5, ageRedDays: 1, priceDisplay: "show" })).toEqual({
      kind: "invalid",
      error: "Red must come after amber: pick more days for red",
    });
    expect((await getQueueSettings(db, WS)).ageAmberDays).toBe(3);
  });
});
