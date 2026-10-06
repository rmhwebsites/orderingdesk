import { describe, it, expect } from "vitest";
import { deskSearch, parseDeskQuery } from "./desk-query";

describe("parseDeskQuery", () => {
  it("opens on Open, newest first, with nothing else filtered", () => {
    expect(parseDeskQuery(new URLSearchParams(""))).toEqual({ view: "open", status: null, kind: "all", q: "", sort: "newest" });
  });

  it("reads every parameter, from a URL or from a searchParams object", () => {
    expect(parseDeskQuery(new URLSearchParams("view=closed&status=on_hold&kind=drafts&q=vest&sort=oldest"))).toEqual({
      view: "closed",
      status: "on_hold",
      kind: "drafts",
      q: "vest",
      sort: "oldest",
    });
    expect(parseDeskQuery({ view: ["all", "closed"], q: "hard hat" })).toMatchObject({ view: "all", q: "hard hat" });
  });

  it("sorts the approval queue by waiting longest unless told otherwise", () => {
    expect(parseDeskQuery(new URLSearchParams("view=approval")).sort).toBe("waiting");
    expect(parseDeskQuery(new URLSearchParams("view=approval&sort=newest")).sort).toBe("newest");
  });

  it("falls back to the defaults for anything it does not know", () => {
    expect(parseDeskQuery(new URLSearchParams("view=everything&status=New Status!&kind=x&sort=total"))).toEqual({
      view: "open",
      status: null,
      kind: "all",
      q: "",
      sort: "newest",
    });
    expect(parseDeskQuery(new URLSearchParams(`q=${"a".repeat(300)}`)).q).toHaveLength(200);
  });
});

describe("deskSearch", () => {
  it("leaves the defaults out and keeps the open order", () => {
    expect(deskSearch(parseDeskQuery(new URLSearchParams("")))).toBe("");
    expect(deskSearch({ view: "approval", status: null, kind: "all", q: "", sort: "waiting" }, "d12")).toBe("?view=approval&order=d12");
    expect(deskSearch({ view: "open", status: "new", kind: "drafts", q: "hard hat", sort: "oldest" })).toBe(
      "?status=new&kind=drafts&q=hard+hat&sort=oldest",
    );
  });
});
