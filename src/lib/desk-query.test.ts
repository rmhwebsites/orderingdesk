import { describe, it, expect } from "vitest";
import {
  DESK_PAGE_MAX,
  DESK_PAGE_SIZE,
  DESK_QUERY_MAX,
  EMPTY_QUERY,
  FILTER_TEXT_MAX,
  SEARCH_DEFAULTS,
  clearAllPatch,
  deskParams,
  deskSearch,
  filterChips,
  listScope,
  mergeDeskSearch,
  normalizeOrderNumber,
  parseDeskQuery,
  querySortDefault,
  reloadLimit,
  sameDeskQuery,
  searchBoxText,
  understoodChips,
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

  // Review fix (Tasks 9 to 13): words search all history (listScope), so a
  // search started from the approval queue lists the newest cards first,
  // not the oldest card of all history.
  it("sorts a search newest first, whatever view it started from, unless told otherwise", () => {
    expect(parseDeskQuery(new URLSearchParams("view=approval&q=hat")).sort).toBe("newest");
    expect(parseDeskQuery(new URLSearchParams("view=approval&q=hat&sort=waiting")).sort).toBe("waiting");
    // Blank words search nothing, so the queue keeps its own sort.
    expect(parseDeskQuery(new URLSearchParams("view=approval&q=%20%20")).sort).toBe("waiting");
    expect(querySortDefault({ ...EMPTY_QUERY, view: "approval", q: "hat" })).toBe("newest");
    expect(querySortDefault({ ...EMPTY_QUERY, view: "approval" })).toBe("waiting");
    // An AI answer's leftover words keep the view, and so its sort.
    const answer: DeskQuery = { ...EMPTY_QUERY, view: "approval", words: "blue logo" };
    expect(querySortDefault(answer)).toBe("waiting");
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

  it("writes a search's sort only when it is not the search's default", () => {
    const parse = (search: string) => parseDeskQuery(new URLSearchParams(search));
    expect(deskSearch(parse("view=approval&q=hat"))).toBe("?view=approval&q=hat");
    expect(deskSearch(parse("view=approval&q=hat&sort=waiting"))).toBe("?view=approval&q=hat&sort=waiting");
    expect(parse(deskSearch(parse("view=approval&q=hat&sort=waiting")).slice(1))).toEqual(parse("view=approval&q=hat&sort=waiting"));
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

  it("lists a search newest first, and gives the queue its own sort back once the words are cleared", () => {
    const sortOf = (search: string) => parseDeskQuery(new URLSearchParams(search)).sort;
    expect(mergeDeskSearch("?view=approval", { q: "hat" })).toBe("?view=approval&q=hat");
    expect(sortOf(mergeDeskSearch("?view=approval", { q: "hat" }))).toBe("newest");
    expect(mergeDeskSearch("?view=approval&q=hat", { q: "" })).toBe("?view=approval");
    expect(sortOf(mergeDeskSearch("?view=approval&q=hat", { q: "" }))).toBe("waiting");
    // A sort picked while searching stays.
    expect(mergeDeskSearch("?view=approval&q=hat&sort=oldest", { q: "" })).toBe("?view=approval&sort=oldest");
    // A view picked while searching keeps the search's sort.
    expect(sortOf(mergeDeskSearch("?q=hat", { view: "approval" }))).toBe("newest");
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
        "view=closed&status=on_hold&kind=orders&q=hard%20hat&sort=waiting&location=101,102&requester=p1&person=Avery&item=Hard%20Hat&pz=Yard%20Lead&words=blue%20logo&number=%23D19&date=last_month&older=3&newer=10",
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
      words: "blue logo",
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
    expect(parse(`words=${encodeURIComponent(" blue\u0000  logo ")}`).words).toBe("blue logo");
    expect(parse(`words=${"w".repeat(300)}`).words).toHaveLength(DESK_QUERY_MAX);
  });

  it("takes a custom range only as two real dates in order, and it wins over a preset", () => {
    expect(parse("from=2026-09-01&to=2026-09-30&date=today")).toMatchObject({ from: "2026-09-01", to: "2026-09-30", date: null });
    expect(parse("from=2026-09-30&to=2026-09-01")).toMatchObject({ from: null, to: null });
    expect(parse("from=2026-02-30&to=2026-03-01")).toMatchObject({ from: null, to: null });
  });

  it("round-trips through deskSearch, keeps the open order, and writes nothing for defaults", () => {
    const search = "view=all&status=new&kind=drafts&q=hat&location=101&words=blue+logo&number=%231024&date=today&older=2";
    expect(parseDeskQuery(new URLSearchParams(deskSearch(parse(search)).slice(1)))).toEqual(parse(search));
    expect(deskSearch(EMPTY_QUERY)).toBe("");
    expect(deskParams(EMPTY_QUERY).toString()).toBe("");
    expect(mergeDeskSearch("?order=o1&q=hat", { locations: ["101"] })).toBe("?q=hat&location=101&order=o1");
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

  // Review fix (Tasks 9 to 13), the AI contract: q holds only words a person
  // typed. An AI answer never writes q; its leftover words go to words,
  // which, like every filter but q, keeps the view (state) the answer chose.
  it("keeps the view for every filter but typed words, so an AI answer's view holds", () => {
    const answer: DeskQuery = {
      ...EMPTY_QUERY,
      status: "new",
      kind: "orders",
      locations: ["101"],
      requester: "p1",
      person: "Avery",
      item: "Hard Hat",
      pz: "Yard Lead",
      words: "blue logo",
      number: "#1024",
      date: "last_month",
      older: 2,
      newer: 30,
    };
    for (const view of ["open", "approval", "all", "closed"] as const) {
      expect(listScope({ ...answer, view }).view, view).toBe(view);
    }
    expect(listScope({ ...answer, from: "2026-09-01", to: "2026-09-30", date: null }).view).toBe("open");
    // Words typed into the box afterwards are plain words again.
    expect(listScope({ ...answer, view: "open", q: "hat" }).view).toBe("all");
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
      words: "blue logo",
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
      "Words: blue logo",
      "#D19",
      "Last month",
      "Waiting over 1 day",
    ]);
    expect(chips[0].patch).toEqual({ locations: ["999"] });
    expect(chips[2].patch).toEqual({ requester: null });
    expect(chips[6].patch).toEqual({ words: "" });
    expect(chips[9].patch).toEqual({ older: null });
  });

  it("labels a custom range", () => {
    expect(filterChips({ ...EMPTY_QUERY, from: "2026-09-01", to: "2026-09-30" }, vocab).map((chip) => chip.label)).toEqual([
      "Sep 1, 2026 to Sep 30, 2026",
    ]);
  });
});

describe("understoodChips", () => {
  const statuses = [{ key: "on_hold", label: "On hold" }];

  it("names the view, kind, status and sort an AI answer set, and each chip undoes only itself", () => {
    const answer: DeskQuery = { ...EMPTY_QUERY, view: "closed", kind: "drafts", status: "on_hold", sort: "oldest" };
    const chips = understoodChips(answer, answer, "open", statuses);
    expect(chips.map((chip) => chip.label)).toEqual(["Closed cards", "Drafts only", "Status: On hold", "Oldest first"]);
    expect(chips.map((chip) => chip.patch)).toEqual([{ view: "open" }, { kind: "all" }, { status: null }, { sort: "newest" }]);
  });

  it("gives a question that sets no search filter its chips (requests on hold, asked from the approval queue)", () => {
    const answer: DeskQuery = { ...EMPTY_QUERY, view: "all", kind: "drafts", status: "on_hold" };
    expect(filterChips(answer, { locations: [], requesterName: null })).toEqual([]);
    const chips = understoodChips(answer, answer, "approval", statuses);
    expect(chips.map((chip) => chip.label)).toEqual(["All cards", "Drafts only", "Status: On hold"]);
    expect(chips[0].patch).toEqual({ view: "approval" });
  });

  it("leaves out what the answer did not change and what the person changed since", () => {
    const answer: DeskQuery = { ...EMPTY_QUERY, view: "all", kind: "orders", status: "on_hold", sort: "waiting" };
    // The answer kept the view the person was on, or they picked a view since.
    expect(understoodChips(answer, answer, "all", statuses).map((chip) => chip.key)).toEqual(["kind", "status", "sort"]);
    expect(understoodChips(answer, answer, null, statuses).map((chip) => chip.key)).toEqual(["kind", "status", "sort"]);
    // The toolbar changed each part afterwards.
    const changed: DeskQuery = { ...answer, view: "closed", kind: "all", status: "new", sort: "newest" };
    expect(understoodChips(answer, changed, "open", statuses)).toEqual([]);
    // A sort that is the view's own default is no part of the understanding.
    expect(understoodChips({ ...EMPTY_QUERY, view: "all", kind: "orders" }, { ...EMPTY_QUERY, view: "all", kind: "orders" }, "all", statuses).map((chip) => chip.key)).toEqual(["kind"]);
    // A status with no label left keeps its key.
    expect(understoodChips({ ...EMPTY_QUERY, status: "gone" }, { ...EMPTY_QUERY, status: "gone" }, "open", statuses)[0].label).toBe("Status: gone");
  });
});

describe("clearAllPatch", () => {
  const after = (search: string, answer: DeskQuery | null, fromView: DeskQuery["view"] | null) =>
    mergeDeskSearch(search, clearAllPatch(answer, parseDeskQuery(new URLSearchParams(search)), fromView));

  it("undoes every part of an AI answer, the sort it set included", () => {
    const search = "?view=all&kind=orders&sort=oldest&location=loc_north";
    const answer = parseDeskQuery(new URLSearchParams(search));
    expect(after(search, answer, "open")).toBe("");
    // Asked from the approval queue: back to the queue and its own sort.
    expect(after(search, answer, "approval")).toBe("?view=approval");
    expect(parseDeskQuery(new URLSearchParams(after(search, answer, "approval"))).sort).toBe("waiting");
    // The person picked a view since: it stays, at its own sort.
    expect(after("?view=closed&kind=orders&sort=oldest", answer, null)).toBe("?view=closed");
  });

  it("keeps a sort the person picked themselves", () => {
    // No AI answer in force: the sort has its own control and stays.
    expect(after("?sort=oldest&location=loc_north", null, null)).toBe("?sort=oldest");
    // The person changed the answer's sort since: theirs stays.
    const answer = parseDeskQuery(new URLSearchParams("?view=all&sort=oldest&location=loc_north"));
    expect(after("?view=all&sort=waiting&location=loc_north", answer, "open")).toBe("?sort=waiting");
    // An answer that left the sort at its default changes nothing about it.
    const plain = parseDeskQuery(new URLSearchParams("?view=all&location=loc_north"));
    expect(after("?view=all&sort=oldest&location=loc_north", plain, "open")).toBe("?sort=oldest");
  });
});

describe("sameDeskQuery", () => {
  // The address an AI question was asked from, after Enter wrote its words.
  const asked = "?q=hard+hats+for+north+yard";

  it("holds while only the drawer opened or closed, or a default was spelled out", () => {
    expect(sameDeskQuery(asked, asked)).toBe(true);
    expect(sameDeskQuery(asked, `${asked}&order=d12`)).toBe(true);
    expect(sameDeskQuery("?view=closed&order=d12", "?view=closed")).toBe(true);
    expect(sameDeskQuery("", "?view=open&sort=newest")).toBe(true);
    expect(sameDeskQuery(asked, "?q=hard%20hats%20for%20north%20yard")).toBe(true);
  });

  it("breaks once the person changed the query while waiting: a view, a status, a sort, a kind, a chip, new words", () => {
    // Picked Closed while the answer was pending: theirs wins.
    expect(sameDeskQuery(asked, `${asked}&view=closed`)).toBe(false);
    expect(sameDeskQuery(asked, `${asked}&status=new`)).toBe(false);
    expect(sameDeskQuery(asked, `${asked}&sort=oldest`)).toBe(false);
    expect(sameDeskQuery(asked, `${asked}&kind=orders`)).toBe(false);
    expect(sameDeskQuery(`${asked}&location=loc_north`, asked)).toBe(false);
    expect(sameDeskQuery(asked, "?q=vests")).toBe(false);
    expect(sameDeskQuery(asked, "")).toBe(false);
  });
});
