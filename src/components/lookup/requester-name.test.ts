import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RequesterName, requesterHref } from "./requester-name";

describe("RequesterName", () => {
  it("links a known requester to their page, above a row's own link", () => {
    expect(requesterHref("/w/impact", "p1")).toBe("/w/impact/people/p1");
    expect(requesterHref("", "p1")).toBe("/people/p1");
    const html = renderToStaticMarkup(createElement(RequesterName, { name: "Riley Oakes", requesterId: "p1", basePath: "" }));
    expect(html).toContain('href="/people/p1"');
    expect(html).toContain("Riley Oakes");
    expect(html).toContain("relative z-10");
  });

  it("is plain text without a requester, with a fallback for no name", () => {
    expect(renderToStaticMarkup(createElement(RequesterName, { name: "Riley Oakes", requesterId: null, basePath: "" }))).toBe("<span>Riley Oakes</span>");
    expect(renderToStaticMarkup(createElement(RequesterName, { name: "", requesterId: null, basePath: "", fallback: "No requester name" }))).toContain(
      "No requester name",
    );
  });
});
