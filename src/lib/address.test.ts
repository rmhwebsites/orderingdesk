import { describe, it, expect } from "vitest";
import {
  addressBlock,
  addressBlockFromLines,
  addressBlockLines,
  locationAddressLines,
  oneLineAddress,
  placeLabel,
  readLocationAddress,
  shippingAddressLines,
  type LocationAddress,
} from "./address";

// One formatter for every address the desk shows (comprehensive design
// section 2): a company location reads as its name, then the address; with
// no location, the address alone.

const BUFORD: LocationAddress = {
  address1: "100 Example Way",
  address2: "Suite 4",
  city: "Buford",
  province: "Georgia",
  provinceCode: "GA",
  zip: "30518",
  country: "United States",
  countryCode: "US",
  phone: "+15555550100",
  company: "Example Rentals",
};

const SHIPPING = {
  name: "Casey Lin",
  company: "Example Rentals, Buford HQ",
  phone: "+15555550111",
  a1: "100 Example Way",
  a2: "",
  city: "Buford",
  prov: "GA",
  zip: "30518",
  country: "US",
};

describe("readLocationAddress", () => {
  it("reads a stored address defensively, and nothing without any address line", () => {
    expect(readLocationAddress(BUFORD)).toEqual(BUFORD);
    expect(readLocationAddress({ address1: " 1 Main St ", countryCode: "US", phone: 7 })).toEqual({
      address1: "1 Main St",
      address2: "",
      city: "",
      province: "",
      provinceCode: "",
      zip: "",
      country: "",
      countryCode: "US",
      phone: "",
      company: "",
    });
    expect(readLocationAddress({ countryCode: "US" })).toBeNull();
    expect(readLocationAddress(null)).toBeNull();
    expect(readLocationAddress("junk")).toBeNull();
  });
});

describe("address lines", () => {
  it("writes a location's street, locality and country, skipping empty parts", () => {
    expect(locationAddressLines(BUFORD)).toEqual(["100 Example Way", "Suite 4", "Buford GA 30518", "US"]);
  });

  it("writes a shipping address with or without its recipient lines", () => {
    expect(shippingAddressLines(SHIPPING, { withRecipient: true })).toEqual([
      "Casey Lin",
      "Example Rentals, Buford HQ",
      "100 Example Way",
      "Buford GA 30518",
      "US",
    ]);
    expect(shippingAddressLines(SHIPPING, { withRecipient: false })).toEqual(["100 Example Way", "Buford GA 30518", "US"]);
  });
});

describe("addressBlock", () => {
  it("puts the location name first, then the order's own street lines and phone", () => {
    expect(addressBlock({ locationName: "Buford HQ", locationAddress: BUFORD, shipping: SHIPPING })).toEqual({
      heading: "Buford HQ",
      lines: ["100 Example Way", "Buford GA 30518", "US"],
      phone: "+15555550111",
    });
  });

  it("falls back to the location's synced address when the order has none", () => {
    expect(addressBlock({ locationName: "Buford HQ", locationAddress: BUFORD, shipping: null })).toEqual({
      heading: "Buford HQ",
      lines: ["100 Example Way", "Suite 4", "Buford GA 30518", "US"],
      phone: "+15555550100",
    });
    expect(addressBlock({ locationName: "Buford HQ" })).toEqual({ heading: "Buford HQ", lines: [], phone: null });
  });

  it("shows the address alone, recipient first, without a location", () => {
    expect(addressBlock({ locationName: "  ", shipping: SHIPPING })).toEqual({
      heading: null,
      lines: ["Casey Lin", "Example Rentals, Buford HQ", "100 Example Way", "Buford GA 30518", "US"],
      phone: "+15555550111",
    });
    expect(addressBlock({})).toBeNull();
  });
});

describe("stored ship-to lines (purchase orders)", () => {
  it("reads the first line as the heading", () => {
    expect(addressBlockFromLines(["Buford HQ", " 100 Example Way ", "", "Buford GA 30518"])).toEqual({
      heading: "Buford HQ",
      lines: ["100 Example Way", "Buford GA 30518"],
      phone: null,
    });
    expect(addressBlockFromLines(["", "  "])).toBeNull();
  });

  it("writes a block back as lines, heading first, for the ship-to field", () => {
    expect(addressBlockLines(addressBlock({ locationName: "Buford HQ", shipping: SHIPPING }))).toEqual([
      "Buford HQ",
      "100 Example Way",
      "Buford GA 30518",
      "US",
    ]);
    expect(addressBlockLines(null)).toEqual([]);
  });

  it("joins the address lines on one line for compact lists", () => {
    expect(oneLineAddress(addressBlock({ locationName: "Buford HQ", locationAddress: BUFORD }))).toBe(
      "100 Example Way, Suite 4, Buford GA 30518, US",
    );
    expect(oneLineAddress(null)).toBe("");
  });
});

describe("placeLabel", () => {
  it("names the place by the synced location, else the request's own branch field", () => {
    expect(placeLabel("Mableton", "Buford HQ")).toBe("Mableton");
    expect(placeLabel("", " Buford HQ ")).toBe("Buford HQ");
    expect(placeLabel(null, "")).toBe("");
  });
});
