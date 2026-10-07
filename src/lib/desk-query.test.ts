import { describe, it, expect } from "vitest";
import {
  DESK_PAGE_MAX,
  DESK_PAGE_SIZE,
  EMPTY_QUERY,
  FILTER_TEXT_MAX,
  SEARCH_DEFAULTS,
  deskParams,
  deskSearch,
  filterChips,
  isEmptyQuery,
  listScope,
  mergeDeskSearch,
  normalizeOrderNumber,
  parseDeskQuery,
  reloadLimit,
  searchBoxText,
  type DeskQuery,
} from "./desk-query";

describe("parseDeskQuery", () => {
  it("opens on Open, newest first, with nothing else filtered", () => {
    expect(parseDeskQuery(new URLSearchParams(""))).toEqual({ ...SEARCH_DEFAULTS, view: "open", status: null, kind: "all", q: "", sort: "newest" });
  });

  it("reads every parameter, from a URL or from a searchParams object", () => {
    expect(parseDeskQuery(new URLSearchParams("view=closed&status=on_hold&kind=drafts&q=vest&sort=oldest"))).toEqual({
      ...SEARCH_DEFAULTS,
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
      ...SEARCH_DEFAULTS,
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
    expect(deskSearch({ ...SEARCH_DEFAULTS, view: "approval", status: null, kind: "all", q: "", sort: "waiting" }, "d12")).toBe("?view=approval&order=d12");
    expect(deskSearch({ ...SEARCH_DEFAULTS, view: "open", status: "new", kind: "drafts", q: "hard hat", sort: "oldest" })).toBe(
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

describe("search filters in the URL", () => {
  const parse = (search: string) => parseDeskQuery(new URLSearchParams(search));

  it("reads every search filter param next to Wave 1a's five", () => {
    expect(
      parse(
        "view=closed&status=on_hold&kind=orders&q=hard%20hat&sort=waiting&location=101,102&requester=p1&person=Avery&item=Hard%20Hat&pz=Yard%20Lead&number=%23D19&date=last_month&older=3&newer=10",
      ),
    ).toEqual({
      view: "closed",
      status: "on_hold",
      kind: "orders",
      q: "hard hat",
      sort: "waiting",
      locations: ["101", "102"],
      requester: "p1",
      person: "Avery",
      item: "Hard Hat",
      pz: "Yard Lead",
      number: "#d19",
      date: "last_month",
      from: null,
      to: null,
      older: 3,
      newer: 10,
    });
  });

  it("ignores values it does not know and caps the free text", () => {
    const query = parse(`location=${encodeURIComponent("101,'; drop")}&older=999&newer=-1&number=abc&date=someday&person=${"x".repeat(100)}`);
    expect(query).toMatchObject({ locations: ["101"], older: null, newer: null, number: "", date: null });
    expect(query.person).toHaveLength(FILTER_TEXT_MAX);
  });

  it("takes a custom range only as two real dates in order, and it wins over a preset", () => {
    expect(parse("from=2026-09-01&to=2026-09-30&date=today")).toMatchObject({ from: "2026-09-01", to: "2026-09-30", date: null });
    expect(parse("from=2026-09-30&to=2026-09-01")).toMatchObject({ from: null, to: null });
    expect(parse("from=2026-02-30&to=2026-03-01")).toMatchObject({ from: null, to: null });
  });

  it("round-trips through deskSearch, keeps the open order, and writes nothing for defaults", () => {
    const search = "view=all&status=new&kind=drafts&q=hat&location=101&number=%231024&date=today&older=2";
    expect(parseDeskQuery(new URLSearchParams(deskSearch(parse(search)).slice(1)))).toEqual(parse(search));
    expect(deskSearch(EMPTY_QUERY)).toBe("");
    expect(deskParams(EMPTY_QUERY).toString()).toBe("");
    expect(mergeDeskSearch("?order=o1&q=hat", { locations: ["101"] })).toBe("?q=hat&location=101&order=o1");
  });

  it("knows when a query holds no filter beyond its view and sort", () => {
    expect(isEmptyQuery({ ...EMPTY_QUERY, view: "all", sort: "oldest" })).toBe(true);
    expect(isEmptyQuery({ ...EMPTY_QUERY, kind: "orders" })).toBe(false);
    expect(isEmptyQuery({ ...EMPTY_QUERY, locations: ["101"] })).toBe(false);
  });
});

// Owner decision (Wave 1c): plain words search every card, open and closed,
// whatever view is picked; clearing them goes back to that view.
describe("listScope", () => {
  it("searches every card for plain words, and the picked view again once they are cleared", () => {
    for (const view of ["open", "approval", "all", "closed"] as const) {
      expect(listScope({ ...EMPTY_QUERY, view, q: "hard hat" }).view, view).toBe("all");
      expect(listScope({ ...EMPTY_QUERY, view, q: "   " }).view, view).toBe(view);
      expect(listScope({ ...EMPTY_QUERY, view }).view, view).toBe(view);
    }
    // The filters AI search fills in keep the view it chose.
    expect(listScope({ ...EMPTY_QUERY, view: "closed", person: "Avery", item: "Hard Hat" }).view).toBe("closed");
  });

  it("keeps the kind filter, except in the approval queue, which shows every kind", () => {
    expect(listScope({ ...EMPTY_QUERY, view: "closed", kind: "orders", q: "hat" }).kind).toBe("orders");
    expect(listScope({ ...EMPTY_QUERY, view: "open", kind: "deleted" }).kind).toBe("deleted");
    expect(listScope({ ...EMPTY_QUERY, view: "approval", kind: "orders" }).kind).toBe("all");
    expect(listScope({ ...EMPTY_QUERY, view: "approval", kind: "orders", q: "hat" })).toEqual({ view: "all", kind: "all" });
  });
});

describe("normalizeOrderNumber and reloadLimit", () => {
  it("accepts order and request numbers only", () => {
    expect(normalizeOrderNumber(" # 1024 ")).toBe("#1024");
    expect(normalizeOrderNumber("D19")).toBe("#d19");
    expect(normalizeOrderNumber("hat")).toBe("");
  });

  it("reloads as deep as the desk has loaded, within one page and the cap", () => {
    expect(reloadLimit(0)).toBe(DESK_PAGE_SIZE);
    expect(reloadLimit(450)).toBe(450);
    expect(reloadLimit(5000)).toBe(DESK_PAGE_MAX);
  });
});

describe("filterChips", () => {
  const vocab = { locations: [{ id: "101", name: "North Yard" }], requesterName: "Riley Oakes" };

  it("names each filter that has no control of its own, and each chip removes only itself", () => {
    const query: DeskQuery = {
      ...EMPTY_QUERY,
      status: "new",
      locations: ["101", "999"],
      requester: "p1",
      person: "Avery",
      item: "Hard Hat",
      pz: "Yard Lead",
      number: "#d19",
      date: "last_month",
      older: 1,
    };
    const chips = filterChips(query, vocab);
    expect(chips.map((chip) => chip.label)).toEqual([
      "North Yard",
      "Unknown location",
      "Riley Oakes",
      "Person: Avery",
      "Item: Hard Hat",
      "Printed: Yard Lead",
      "#D19",
      "Last month",
      "Waiting over 1 day",
    ]);
    expect(chips[0].patch).toEqual({ locations: ["999"] });
    expect(chips[2].patch).toEqual({ requester: null });
    expect(chips[8].patch).toEqual({ older: null });
  });

  it("labels a custom range", () => {
    expect(filterChips({ ...EMPTY_QUERY, from: "2026-09-01", to: "2026-09-30" }, vocab).map((chip) => chip.label)).toEqual([
      "Sep 1, 2026 to Sep 30, 2026",
    ]);
  });
});
