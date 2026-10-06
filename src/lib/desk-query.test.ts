import { describe, it, expect } from "vitest";
import { deskSearch, mergeDeskSearch, parseDeskQuery, searchBoxText } from "./desk-query";

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

describe("mergeDeskSearch", () => {
  it("applies a change and keeps everything else, the open order included", () => {
    expect(mergeDeskSearch("?status=new&order=d12", { q: "vest" })).toBe("?status=new&q=vest&order=d12");
    expect(mergeDeskSearch("?q=vest", { q: "" })).toBe("");
  });

  it("moves a default sort along with the view, and keeps a chosen one", () => {
    expect(mergeDeskSearch("", { view: "approval", status: null })).toBe("?view=approval");
    expect(mergeDeskSearch("?view=approval", { view: "open" })).toBe("");
    expect(mergeDeskSearch("?sort=oldest", { view: "approval" })).toBe("?view=approval&sort=oldest");
  });
});

describe("searchBoxText", () => {
  it("keeps what the box typed while the address holds it, whatever React was last handed", () => {
    // Typing "ab" fast: useSearchParams may still say q=a, the address
    // already says ab, so the box keeps ab.
    expect(searchBoxText("ab", "?q=ab&order=d12")).toBe("ab");
    // The address drops a blank search, so a leading space stays typed.
    expect(searchBoxText(" ", "")).toBe(" ");
    expect(searchBoxText(" v", "?q=+v")).toBe(" v");
    // The address reads back 200 characters at most.
    expect(searchBoxText("a".repeat(250), `?q=${"a".repeat(250)}`)).toBe("a".repeat(250));
  });

  it("takes the address's search when it changed outside the box (Back, a link, Clear filters)", () => {
    expect(searchBoxText("vest", "?view=closed")).toBe("");
    expect(searchBoxText("vest", "?q=hard+hat&order=d12")).toBe("hard hat");
  });
});
