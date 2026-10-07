import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddressBlock } from "./address-block";

// The one address component (comprehensive design section 2).
describe("AddressBlock", () => {
  it("shows the location name in bold, then the lines, then the phone", () => {
    const html = renderToStaticMarkup(
      createElement(AddressBlock, {
        block: { heading: "Buford HQ", lines: ["100 Example Way", "Buford GA 30518"], phone: "+15555550100" },
        empty: "No shipping address.",
      }),
    );
    expect(html.startsWith("<address")).toBe(true);
    expect(html).toContain('<span class="block font-semibold">Buford HQ</span>');
    expect(html).toContain('<span class="block break-words">100 Example Way</span>');
    expect(html).toContain("+15555550100");
  });

  it("shows the address alone without a heading, and the empty text without any address", () => {
    const plain = renderToStaticMarkup(
      createElement(AddressBlock, { block: { heading: null, lines: ["Casey Lin"], phone: null }, empty: "None" }),
    );
    expect(plain).not.toContain("font-semibold");
    expect(plain).toContain(">Casey Lin<");
    const none = renderToStaticMarkup(createElement(AddressBlock, { block: null, empty: "No shipping address." }));
    expect(none).toContain(">No shipping address.</p>");
  });
});
