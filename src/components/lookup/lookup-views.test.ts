import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderSummary } from "@/server/desk/read";
import type { StatusView } from "@/server/desk/shapes";
import type { LocationPage } from "@/server/lookup/locations";
import type { PersonPage } from "@/server/lookup/people";
import { CardList } from "./card-list";
import { LocationView } from "./location-view";
import { PeopleListView } from "./people-list-view";
import { PersonView } from "./person-view";

const statuses = [{ key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null }] as StatusView[];
const card = (overrides: Partial<OrderSummary> = {}) =>
  ({
    id: "o1",
    name: "#1042",
    statusKey: "new",
    createdAt: Date.parse("2026-10-01T15:00:00.000Z"),
    customerName: "Riley Oakes",
    itemsPreview: ["2 x Hard Hat"],
    kind: "order",
    draftDeleted: false,
    requesterId: "p1",
    ...overrides,
  }) as OrderSummary;

describe("PersonView", () => {
  it("shows who they are, their counts and items, and links every card and the desk", () => {
    const data = {
      person: { id: "p1", name: "Riley Oakes", email: "riley@example.com", homeLocation: { id: "loc_north", name: "North Yard" }, firstSeenAt: 1, lastSeenAt: 2 },
      counts: { open: 1, approved: 3, rejected: 1, cancelled: 0, cards: 4 },
      items: [{ title: "Hard Hat", variant: "White", quantity: 3 }],
      cards: [card()],
      statuses,
      timeZone: "America/New_York",
    } as PersonPage;
    const html = renderToStaticMarkup(createElement(PersonView, { data, basePath: "/w/ws_impact" }));
    expect(html).toContain("Riley Oakes");
    expect(html).toContain("riley@example.com");
    expect(html).toContain('href="/w/ws_impact/locations/loc_north"');
    expect(html).toContain('href="/w/ws_impact?order=o1"');
    expect(html).toContain('href="/w/ws_impact?requester=p1&amp;view=all"');
    expect(html).toContain("Hard Hat");
    expect(html).toContain("White");
    expect(html).toContain("Oct 1, 2026");
    for (const label of ["Open", "Approved", "Rejected", "Cancelled"]) {
      expect(html).toContain(label);
    }
  });
});

describe("LocationView", () => {
  it("shows open cards, every order for the location, top items and who ordered, on the client host", () => {
    const data = {
      location: { id: "loc_north", name: "North Yard", address: null, active: true },
      openCards: [card()],
      openCount: 1,
      orders: [card({ id: "o2", name: "#1043" })],
      ordersCount: 1,
      topItems: [{ title: "Safety Vest", variant: "L", quantity: 5 }],
      people: [{ id: "p1", name: "Riley Oakes", cards: 2 }],
      statuses,
      timeZone: "America/New_York",
    } as LocationPage;
    const html = renderToStaticMarkup(createElement(LocationView, { data, basePath: "" }));
    expect(html).toContain("North Yard");
    expect(html).toContain('href="/?order=o1"');
    expect(html).toContain('href="/?order=o2"');
    expect(html).toContain('href="/people/p1"');
    expect(html).toContain('href="/?location=loc_north&amp;view=all"');
    expect(html).toContain("Safety Vest");
  });
});

describe("CardList", () => {
  const withCancelled = [
    { key: "shipped", label: "Shipped", color: "green", sort: 1, triggersPo: false, shopifyLink: null },
    { key: "cancelled", label: "Cancelled", color: "slate", sort: 2, triggersPo: false, shopifyLink: "cancelled" },
  ] as StatusView[];
  const render = (cards: OrderSummary[], list: StatusView[]) =>
    renderToStaticMarkup(createElement(CardList, { cards, statuses: list, basePath: "", timeZone: "America/New_York", empty: "None" }));

  it("says Cancelled in Shopify on an order Shopify cancelled outside the Cancelled status, as the desk does", () => {
    const html = render([card({ statusKey: "shipped", cancelled: true })], withCancelled);
    expect(html).toContain("Shipped");
    expect(html).toContain('title="Cancelled in Shopify"');
    expect(html).toContain('<span class="sr-only"> in Shopify</span>');
  });

  it("says it too when the workspace has no Cancelled status", () => {
    expect(render([card({ cancelled: true })], statuses)).toContain('title="Cancelled in Shopify"');
  });

  it("adds nothing to a card in the Cancelled status or one Shopify did not cancel", () => {
    const html = render([card({ id: "o1", statusKey: "cancelled", cancelled: true }), card({ id: "o2", statusKey: "shipped", cancelled: false })], withCancelled);
    expect(html).not.toContain("in Shopify");
  });
});

describe("PeopleListView", () => {
  it("lists people with links and a search form that keeps the words", () => {
    const html = renderToStaticMarkup(
      createElement(PeopleListView, {
        data: { people: [{ id: "p1", name: "Riley Oakes", email: "riley@example.com", locationName: "North Yard", openCount: 1, cardCount: 4, lastSeenAt: 2 }], total: 1 },
        query: "riley",
        basePath: "/w/ws_impact",
      }),
    );
    expect(html).toContain('role="search"');
    expect(html).toContain('value="riley"');
    expect(html).toContain('href="/w/ws_impact/people/p1"');
    expect(html).toContain("North Yard");
  });
});
