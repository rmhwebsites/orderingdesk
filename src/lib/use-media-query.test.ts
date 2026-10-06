import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DESK_MEDIA, useMediaQuery } from "./use-media-query";

function Probe({ serverValue }: { serverValue: boolean }) {
  return String(useMediaQuery(DESK_MEDIA, serverValue));
}

describe("useMediaQuery", () => {
  it("uses the server value when there is no window", () => {
    expect(renderToStaticMarkup(createElement(Probe, { serverValue: true }))).toBe("true");
    expect(renderToStaticMarkup(createElement(Probe, { serverValue: false }))).toBe("false");
    expect(DESK_MEDIA).toBe("(min-width: 55rem)");
  });
});
