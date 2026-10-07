import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { seedLocation } from "@/server/desk/test-helpers";
import { indexOrders } from "@/server/search/index-orders";
import { NOW, WS, call, setupMcp, toolDeps } from "../test-helpers";
import { findPeople, getLocation, getPerson, listLocations } from "./lookup";

const ADDRESS = {
  address1: "100 Example Way",
  address2: "",
  city: "Harbor Point",
  province: "Georgia",
  provinceCode: "GA",
  zip: "30000",
  country: "United States",
  countryCode: "US",
  phone: "+15555550100",
  company: "Example Rentals",
};

async function setup() {
  const db = await setupMcp();
  await seedLocation(db, WS, { shopifyLocationId: "101", name: "North Yard", address: ADDRESS });
  await seedLocation(db, WS, { shopifyLocationId: "102", name: "Harbor Point" });
  await db.update(schema.orders).set({ locationId: "101", createdAt: NOW - 86400000 }).where(eq(schema.orders.id, "d1"));
  await db.insert(schema.people).values({
    id: "p_jordan",
    workspaceId: WS,
    shopifyCustomerId: "301",
    name: "Jordan Vale",
    email: "jordan@example.com",
    companyContactId: "401",
    locationId: "101",
    firstSeenAt: NOW - 86400000,
    lastSeenAt: NOW - 1000,
  });
  await indexOrders(db, WS, ["d1", "o1"]);
  await db.update(schema.orderSearch).set({ requesterId: "p_jordan" }).where(eq(schema.orderSearch.orderId, "d1"));
  return db;
}

describe("people and location tools", () => {
  it("find people by name, without emails", async () => {
    const db = await setup();
    const { data } = await call(findPeople, { query: "jord" }, toolDeps(db));
    expect(data.people).toEqual([expect.objectContaining({ id: "p_jordan", name: "Jordan Vale", home_location: "North Yard" })]);
    expect(JSON.stringify(data)).not.toContain("jordan@example.com");
  });

  it("show a person's counts, items and recent cards", async () => {
    const db = await setup();
    const { data, result } = await call(getPerson, { person_id: "p_jordan" }, toolDeps(db));
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ id: "p_jordan", name: "Jordan Vale", home_location: { id: "101", name: "North Yard" } });
    expect(data.counts).toMatchObject({ open: 1 });
    expect(data.recent_cards.map((card: { number: string }) => card.number)).toEqual(["#D12"]);
    expect((await call(getPerson, { person_id: "p_nobody" }, toolDeps(db))).data.error).toMatchObject({ code: "not_found" });
  });

  // Decision 13: requester emails are never returned. people.name is null
  // when Shopify gave no name (the app's pages then show the email), and
  // Shopify's displayName falls back to the email, then the phone, so a
  // stored name can be one of those too.
  it("never return a person's email or phone as their name, nor find them by it", async () => {
    for (const stored of [null, "noname@example.com", "+15555550142"]) {
      const db = await setup();
      await db.update(schema.people).set({ name: stored, email: "noname@example.com" }).where(eq(schema.people.id, "p_jordan"));
      const listed = await call(findPeople, {}, toolDeps(db));
      expect(listed.data.people, String(stored)).toEqual([expect.objectContaining({ id: "p_jordan", name: null, home_location: "North Yard" })]);
      for (const query of ["noname", "noname@example", "example.com", "5555550142"]) {
        expect((await call(findPeople, { query }, toolDeps(db))).data, `${stored} ${query}`).toMatchObject({ total: 0, people: [] });
      }
      const person = await call(getPerson, { person_id: "p_jordan" }, toolDeps(db));
      expect(person.data, String(stored)).toMatchObject({ id: "p_jordan", name: null });
      const location = await call(getLocation, { location: "101" }, toolDeps(db));
      expect(location.data.people, String(stored)).toEqual([{ id: "p_jordan", name: null, cards: 1 }]);
      for (const data of [listed.data, person.data, location.data]) {
        expect(JSON.stringify(data), String(stored)).not.toContain("noname@example.com");
        expect(JSON.stringify(data), String(stored)).not.toContain("5555550142");
      }
    }
  });

  it("list locations and show one by id or name, with its address and open cards", async () => {
    const db = await setup();
    const list = await call(listLocations, {}, toolDeps(db));
    expect(list.data.locations.map((location: { name: string }) => location.name)).toEqual(["Harbor Point", "North Yard"]);
    const byName = await call(getLocation, { location: "north yard" }, toolDeps(db));
    // Wave 1b's locationAddressLines ends with the country code.
    expect(byName.data).toMatchObject({ id: "101", name: "North Yard", address: ["100 Example Way", "Harbor Point GA 30000", "US"] });
    expect(byName.data.open_cards.map((card: { number: string }) => card.number)).toEqual(["#D12"]);
    expect(JSON.stringify(byName.data)).not.toContain("5555550100");
    expect((await call(getLocation, { location: "102" }, toolDeps(db))).data.name).toBe("Harbor Point");
    expect((await call(getLocation, { location: "Nowhere" }, toolDeps(db))).data.error).toMatchObject({ code: "not_found" });
  });
});
