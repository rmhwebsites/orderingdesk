import { describe, it, expect } from "vitest";
import {
  EDIT_COPY,
  EDIT_LINES_MAX,
  EDIT_QUANTITY_MAX,
  bodyFromForm,
  editLanded,
  lineLabel,
  parseEditBody,
  requestContentKey,
  summarizeEdit,
  type RequestEditor,
} from "./request-edit";

// Editing a request before approval (comprehensive design section 2): what
// the server and the drawer share.

const EDITOR: RequestEditor = {
  updatedAt: "2026-10-06T14:00:00Z",
  lines: [
    { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 2 },
    { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
  ],
  locationId: "101",
  locationName: "Buford HQ",
  locations: [
    { shopifyLocationId: "101", name: "Buford HQ", address: "100 Example Way, Buford GA 30518, US" },
    { shopifyLocationId: "102", name: "Mableton", address: "5 Example Rd, Mableton GA 30126, US" },
  ],
};
const AT = EDITOR.updatedAt;

describe("parseEditBody", () => {
  it("reads lines, quantities and an optional location", () => {
    expect(parseEditBody({ updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" })).toEqual({
      updatedAt: AT,
      lines: [{ uuid: "u-1", quantity: 1 }],
      locationId: "102",
    });
    expect(parseEditBody({ updatedAt: AT, lines: [{ uuid: "u-1", quantity: 3 }] })).toMatchObject({ locationId: null });
  });

  it("refuses an empty list, a bad quantity and anything malformed", () => {
    expect(parseEditBody({ updatedAt: AT, lines: [] })).toEqual({ error: EDIT_COPY.keepOne });
    for (const quantity of [0, 1.5, EDIT_QUANTITY_MAX + 1, "2"]) {
      expect(parseEditBody({ updatedAt: AT, lines: [{ uuid: "u-1", quantity }] })).toEqual({ error: EDIT_COPY.quantity });
    }
    for (const body of [
      null,
      { lines: [{ uuid: "u-1", quantity: 1 }] },
      { updatedAt: "yesterday", lines: [{ uuid: "u-1", quantity: 1 }] },
      { updatedAt: AT, lines: [{ uuid: "u 1", quantity: 1 }] },
      { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }, { uuid: "u-1", quantity: 2 }] },
      { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "gid://shopify/CompanyLocation/102" },
      { updatedAt: AT, lines: Array.from({ length: EDIT_LINES_MAX + 1 }, (_, i) => ({ uuid: `u-${i}`, quantity: 1 })) },
    ]) {
      expect(parseEditBody(body)).toEqual({ error: EDIT_COPY.invalid });
    }
  });
});

describe("summarizeEdit", () => {
  it("names every change in plain words, with the before and after", () => {
    expect(summarizeEdit(EDITOR, { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" })).toEqual({
      changes: ["Hard Hat (White): quantity 2 to 1", "Removed Safety Vest (L)", "Ship to Mableton instead of Buford HQ"],
      before: { lines: ["2 x Hard Hat (White)", "1 x Safety Vest (L)"], shipTo: "Buford HQ" },
      after: { lines: ["1 x Hard Hat (White)"], shipTo: "Mableton" },
    });
  });

  it("finds nothing to change when nothing changed", () => {
    const same = [
      { uuid: "u-1", quantity: 2 },
      { uuid: "u-2", quantity: 1 },
    ];
    expect(summarizeEdit(EDITOR, { updatedAt: AT, lines: same, locationId: null }).changes).toEqual([]);
    expect(summarizeEdit(EDITOR, { updatedAt: AT, lines: same, locationId: "101" }).changes).toEqual([]);
  });

  it("labels a line by its title and variant, skipping Shopify's default variant", () => {
    expect(lineLabel({ title: "Hard Hat", variantTitle: "White" })).toBe("Hard Hat (White)");
    expect(lineLabel({ title: "Gloves", variantTitle: "Default Title" })).toBe("Gloves");
    expect(lineLabel({ title: " ", variantTitle: "" })).toBe("Untitled item");
  });
});

describe("bodyFromForm", () => {
  it("reads the editor's form into a body, sending the location only when it changed", () => {
    expect(bodyFromForm(EDITOR, { quantities: { "u-1": " 3 ", "u-2": "1" }, removed: new Set(["u-2"]), locationId: "101" })).toEqual({
      updatedAt: AT,
      lines: [{ uuid: "u-1", quantity: 3 }],
      locationId: null,
    });
    expect(bodyFromForm(EDITOR, { quantities: {}, removed: new Set(), locationId: "102" })).toEqual({
      updatedAt: AT,
      lines: [
        { uuid: "u-1", quantity: 2 },
        { uuid: "u-2", quantity: 1 },
      ],
      locationId: "102",
    });
  });

  it("refuses a bad quantity or no line left", () => {
    expect(bodyFromForm(EDITOR, { quantities: { "u-1": "0" }, removed: new Set(), locationId: null })).toEqual({ error: EDIT_COPY.quantity });
    expect(bodyFromForm(EDITOR, { quantities: { "u-1": "two" }, removed: new Set(), locationId: null })).toEqual({ error: EDIT_COPY.quantity });
    expect(bodyFromForm(EDITOR, { quantities: {}, removed: new Set(["u-1", "u-2"]), locationId: null })).toEqual({ error: EDIT_COPY.keepOne });
  });
});

describe("editLanded", () => {
  it("says whether Shopify's draft now holds exactly the edit", () => {
    const body = { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" };
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" }, body)).toBe(true);
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 1 }], locationId: "101" }, body)).toBe(false);
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 2 }, { uuid: "u-2", quantity: 1 }], locationId: "102" }, body)).toBe(false);
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 1 }], locationId: "101" }, { ...body, locationId: null })).toBe(true);
  });
});

describe("requestContentKey", () => {
  it("changes with the items, quantities, location or total, and is empty without a card", () => {
    const card = { itemTitles: ["Hard Hat"], itemCount: 2, locationId: "101", total: "0.00" };
    expect(requestContentKey(card)).toBe(requestContentKey({ ...card }));
    expect(requestContentKey({ ...card, itemCount: 1 })).not.toBe(requestContentKey(card));
    expect(requestContentKey({ ...card, locationId: "102" })).not.toBe(requestContentKey(card));
    expect(requestContentKey({ ...card, total: "12.00" })).not.toBe(requestContentKey(card));
    expect(requestContentKey(undefined)).toBe("");
  });
});
