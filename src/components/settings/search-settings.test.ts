import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchSection } from "./search-settings";

describe("SearchSection", () => {
  it("offers the time zone and the AI search switch, and says what the model sees", () => {
    const html = renderToStaticMarkup(
      createElement(SearchSection, { workspaceId: "ws_impact", initial: { timeZone: "America/Chicago", aiSearch: true } }),
    );
    expect(html).toContain('id="search"');
    expect(html).toContain('value="America/Chicago" selected=""');
    expect(html).toContain('role="switch"');
    expect(html).toContain("never order details");
  });
});
