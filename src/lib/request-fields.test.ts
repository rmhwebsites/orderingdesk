import { describe, it, expect } from "vitest";
import { HEADLINE_ATTRIBUTES, publicAttributes, requestFieldsOf } from "./request-fields";

// The request fields a card shows (draft orders spec section 11.1 and
// section 18): IMPACT's cart attributes first when present, then any other
// public attribute in Shopify's order; the current snapshot first, then the
// draft snapshot an order card keeps.

const attr = (key: string, value: string) => ({ key, value });

describe("publicAttributes", () => {
  it("puts the four request keys first, keeps Shopify's order for the rest, and hides underscore keys and empty values", () => {
    expect(
      publicAttributes([
        attr("Cost center", "41"),
        attr("Internal Notes", "Rush"),
        attr("_pplr_config", "{}"),
        attr("Reason for Request", "New hire"),
        attr("Gift wrap", "  "),
        attr("for employee name", "Casey Lin"),
        attr("Ship to Branch", "Buford HQ"),
        attr("Color", "Blue"),
      ]),
    ).toEqual([
      attr("Ship to Branch", "Buford HQ"),
      attr("for employee name", "Casey Lin"),
      attr("Reason for Request", "New hire"),
      attr("Internal Notes", "Rush"),
      attr("Cost center", "41"),
      attr("Color", "Blue"),
    ]);
    expect(publicAttributes("junk")).toEqual([]);
    expect(publicAttributes([{ key: 4, value: "x" }, null, attr("", "x")])).toEqual([]);
  });
});

describe("requestFieldsOf", () => {
  const draft = {
    kind: "draft",
    company: "Impact Rentals",
    location: "Buford, GA",
    attributes: [attr("For Employee Name", "Casey Lin"), attr("Reason for Request", "New hire")],
  };

  it("reads a draft's company, location and headline attributes, with the location as the branch fallback", () => {
    expect(requestFieldsOf(draft, null)).toEqual({
      company: "Impact Rentals",
      location: "Buford, GA",
      requestFor: "Casey Lin",
      branch: "Buford, GA",
      attributes: [attr("For Employee Name", "Casey Lin"), attr("Reason for Request", "New hire")],
    });
    expect(
      requestFieldsOf({ ...draft, attributes: [attr("Ship to Branch", "Water Tower HQ")] }, null).branch,
    ).toBe("Water Tower HQ");
  });

  it("falls back to the draft snapshot for an order card whose order has no attributes", () => {
    const order = { kind: "order", attributes: [] };
    expect(requestFieldsOf(order, draft)).toMatchObject({
      company: "Impact Rentals",
      location: "Buford, GA",
      requestFor: "Casey Lin",
      attributes: draft.attributes,
    });
    // The order's own attributes come first when it has them.
    const carried = { kind: "order", attributes: [attr("For Employee Name", "Jo Park")] };
    expect(requestFieldsOf(carried, draft)).toMatchObject({ requestFor: "Jo Park", attributes: carried.attributes });
  });

  it("degrades to empty fields for an order that never was a draft, or a malformed snapshot", () => {
    const empty = { company: "", location: "", requestFor: "", branch: "", attributes: [] };
    expect(requestFieldsOf({ kind: "order", name: "#1001" }, null)).toEqual(empty);
    expect(requestFieldsOf(null, "junk")).toEqual(empty);
  });

  it("names the headline fields in one place", () => {
    expect(HEADLINE_ATTRIBUTES.map((entry) => entry.field)).toEqual(["requestFor", "branch"]);
  });
});
