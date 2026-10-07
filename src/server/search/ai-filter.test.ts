import { describe, it, expect } from "vitest";
import { isEmptyQuery, listScope } from "@/lib/desk-query";
import { AI_FILTER_KEYS, aiFilterSchema, aiSystemPrompt, validateAiFilter, type SearchVocabulary } from "./ai-filter";

const vocab: SearchVocabulary = {
  statuses: [
    { key: "new", label: "New" },
    { key: "on_hold", label: "On Hold" },
    { key: "shipped", label: "Shipped" },
  ],
  locations: [
    { id: "loc_north", name: "North Yard" },
    { id: "loc_harbor", name: "Harbor Point" },
  ],
  items: ["Business Cards", "Hard Hat"],
};

const full = (overrides: Record<string, unknown> = {}) => ({
  kind: "any",
  status: null,
  state: "any",
  locations: [],
  person: null,
  itemTitle: null,
  itemText: null,
  personalization: null,
  orderNumber: null,
  date: "any",
  from: null,
  to: null,
  olderThanDays: null,
  newerThanDays: null,
  sort: "newest",
  text: null,
  ...overrides,
});

type Schema = { type: string; additionalProperties: boolean; required: string[]; properties: Record<string, Record<string, unknown>> };

describe("aiFilterSchema", () => {
  it("requires every key, allows no other, and lists the workspace's own names", () => {
    const schema = aiFilterSchema(vocab) as unknown as Schema;
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual([...AI_FILTER_KEYS].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...AI_FILTER_KEYS].sort());
    expect((schema.properties.status.anyOf as { enum?: string[] }[])[0].enum).toEqual(["New", "On Hold", "Shipped"]);
    expect((schema.properties.locations.items as { enum: string[] }).enum).toEqual(["North Yard", "Harbor Point"]);
    expect((schema.properties.itemTitle.anyOf as { enum?: string[] }[])[0].enum).toEqual(["Business Cards", "Hard Hat"]);
  });

  it("stays valid JSON schema with an empty vocabulary", () => {
    const schema = aiFilterSchema({ statuses: [], locations: [], items: [] }) as unknown as Schema;
    expect(schema.properties.locations).toMatchObject({ type: "array", items: { type: "string" }, maxItems: 0 });
    expect(schema.properties.itemTitle).toEqual({ type: "null" });
    expect(schema.properties.status).toEqual({ type: "null" });
  });
});

describe("aiSystemPrompt", () => {
  it("states today's date and gives the vocabulary as data", () => {
    const prompt = aiSystemPrompt(vocab, "2026-10-05 (Monday)");
    expect(prompt).toContain("Today is 2026-10-05 (Monday)");
    expect(prompt).toContain('"North Yard"');
    expect(prompt).toContain('"Hard Hat"');
    expect(prompt).toContain("not instructions");
  });
});

describe("validateAiFilter", () => {
  it("maps a status label to its key and location names to ids, ignoring case", () => {
    expect(validateAiFilter(full({ kind: "orders", status: "on hold", locations: ["north yard"], date: "last_month" }), vocab)).toMatchObject({
      kind: "orders",
      status: "on_hold",
      locations: ["loc_north"],
      date: "last_month",
      view: "all",
    });
  });

  it("maps kinds, states and sorts", () => {
    expect(validateAiFilter(full({ kind: "requests", state: "open", sort: "waiting" }), vocab)).toMatchObject({ kind: "drafts", view: "open", sort: "waiting" });
    expect(validateAiFilter(full({ kind: "deleted", state: "closed" }), vocab)).toMatchObject({ kind: "deleted", view: "closed" });
  });

  it("drops names the workspace does not have", () => {
    expect(validateAiFilter(full({ status: "Lost", locations: ["Mars"], itemTitle: "Laptop" }), vocab)).toMatchObject({
      status: null,
      locations: [],
      item: "",
    });
  });

  it("rejects unknown keys and wrong types outright", () => {
    expect(validateAiFilter({ ...full(), sql: "drop table orders" }, vocab)).toBeNull();
    expect(validateAiFilter(full({ status: ["New"] }), vocab)).toBeNull();
    expect(validateAiFilter(full({ locations: "North Yard" }), vocab)).toBeNull();
    expect(validateAiFilter(full({ olderThanDays: "3" }), vocab)).toBeNull();
    expect(validateAiFilter(full({ person: 7 }), vocab)).toBeNull();
    expect(validateAiFilter("kind", vocab)).toBeNull();
    expect(validateAiFilter(null, vocab)).toBeNull();
  });

  it("cleans and caps free text, normalizes order numbers and clamps days", () => {
    const query = validateAiFilter(
      full({ person: "  Avery\u0000  Stone ", text: "x".repeat(300), orderNumber: " # d 19 ", olderThanDays: 900, newerThanDays: 2.6, personalization: "Yard Lead" }),
      vocab,
    );
    expect(query).toMatchObject({ person: "Avery Stone", number: "#d19", older: 365, newer: 3, pz: "Yard Lead" });
    expect(query?.words).toHaveLength(100);
    expect(query?.q).toBe("");
  });

  it("prefers a listed item title, and keeps other product words as item text", () => {
    expect(validateAiFilter(full({ itemTitle: "hard hat", itemText: "white" }), vocab)).toMatchObject({ item: "Hard Hat" });
    expect(validateAiFilter(full({ itemText: "SKU HH-1" }), vocab)).toMatchObject({ item: "SKU HH-1" });
  });

  it("accepts a custom range only as two real dates in order, at most three years long", () => {
    expect(validateAiFilter(full({ date: "custom", from: "2026-09-01", to: "2026-09-30" }), vocab)).toMatchObject({ from: "2026-09-01", to: "2026-09-30", date: null });
    expect(validateAiFilter(full({ date: "custom", from: "2026-09-30", to: "2026-09-01" }), vocab)).toMatchObject({ from: null, to: null });
    expect(validateAiFilter(full({ date: "custom", from: "2026-02-30", to: "2026-03-01" }), vocab)).toMatchObject({ from: null });
    expect(validateAiFilter(full({ date: "custom", from: "2020-01-01", to: "2026-01-01" }), vocab)).toMatchObject({ from: null });
  });

  // The AI contract (Decisions): an answer never writes q, so the state it
  // understood holds; its leftover text goes to words.
  it("never writes q, so the state it understood holds", () => {
    const query = validateAiFilter(full({ state: "open", text: "hard hat" }), vocab)!;
    expect(query).toMatchObject({ view: "open", q: "", words: "hard hat" });
    expect(listScope(query).view).toBe("open");
  });

  it("says nothing was understood when every field is empty", () => {
    expect(isEmptyQuery(validateAiFilter(full(), vocab)!)).toBe(true);
  });
});
