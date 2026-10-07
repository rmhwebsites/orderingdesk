import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { loadVocabulary, topTitles, VOCAB_ITEMS_MAX } from "./vocabulary";
import { openTestDb, seedLocation, seedOrder, seedWorkspace, snapshotOf, TEST_STATUSES } from "@/server/desk/test-helpers";

const WS = "ws_impact";

describe("topTitles", () => {
  it("orders titles by how often they were ordered, without custom lines, blanks or duplicates", () => {
    const snapshot = (titles: { title: string; custom?: boolean }[]) => ({ items: titles.map((entry) => ({ ...entry, qty: 1 })) });
    expect(
      topTitles([
        snapshot([{ title: "Hard Hat" }, { title: "Safety Vest" }]),
        snapshot([{ title: "hard  hat" }, { title: "Rush fee", custom: true }, { title: "  " }]),
        snapshot([{ title: "Business Cards" }]),
        null,
      ]),
    ).toEqual(["Hard Hat", "Business Cards", "Safety Vest"]);
  });

  it("caps the list", () => {
    const many = [{ items: Array.from({ length: VOCAB_ITEMS_MAX + 20 }, (_, i) => ({ title: `Item ${String(i).padStart(3, "0")}`, qty: 1 })) }];
    expect(topTitles(many)).toHaveLength(VOCAB_ITEMS_MAX);
  });
});

describe("loadVocabulary", () => {
  it("holds the status labels, active location names, recent item titles, time zone and switch", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    await seedLocation(db, WS, { shopifyLocationId: "loc_north", name: "North Yard" });
    await seedLocation(db, WS, { shopifyLocationId: "loc_old", name: "Old Yard", active: false });
    await seedOrder(db, WS, { id: "o1", shopify: snapshotOf({ items: [{ title: "Hard Hat", qty: 1, sku: "HH-1", variant: "", props: [] }] }) });
    await db.update(schema.workspaceSettings).set({ timeZone: "America/Chicago", aiSearch: false }).where(eq(schema.workspaceSettings.workspaceId, WS));
    const loaded = await loadVocabulary(db, WS);
    expect(loaded.vocab.statuses.map((status) => status.label)).toEqual(TEST_STATUSES.map((status) => status.label));
    expect(loaded.vocab.locations).toEqual([{ id: "loc_north", name: "North Yard" }]);
    expect(loaded.vocab.items).toEqual(["Hard Hat"]);
    expect(loaded.timeZone).toBe("America/Chicago");
    expect(loaded.aiSearch).toBe(false);
  });
});
