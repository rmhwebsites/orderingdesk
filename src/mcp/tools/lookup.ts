// Read tools for people and company locations (comprehensive desk design
// section 4), on Wave 1c's people and location read models. Emails and
// phone numbers are never returned (locationAddressLines leaves the phone
// out): a person's name is the stored people.name through personLabel
// (never the display name, which falls back to the email), and find_people
// matches that name only, so a typed email or phone finds nobody.
// Relative imports only.

import { and, eq, or, sql } from "drizzle-orm";
import * as z from "zod";
import { locations } from "../../db/schema";
import { locationAddressLines } from "../../lib/address";
import { getLocationPage, listLocationSummaries } from "../../server/lookup/locations";
import { getPersonPage, listPeople } from "../../server/lookup/people";
import { iso, NAME_MAX, personLabel, plainText } from "../output";
import { cardLine } from "./cards";
import { READ, defineTool, fail, ok } from "./define";

const LIST_MAX = 25;
const CARDS_MAX = 20;

export const findPeople = defineTool({
  name: "find_people",
  title: "Find people",
  description: "Employees who have placed requests or orders, matched by name: id, name, home location, open cards and all cards. Use an id with get_person.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({ query: z.string().max(60).optional().describe("Part of a name; empty lists the most recent people") }).strict(),
  async run(args, deps) {
    const found = await listPeople(deps.db, deps.principal.workspaceId, { q: args.query ?? "", matchOn: (person) => personLabel(person.name) ?? "" });
    return ok({
      total: found.total,
      people: found.people.slice(0, LIST_MAX).map((person) => ({
        id: person.id,
        name: personLabel(person.storedName),
        home_location: plainText(person.locationName, NAME_MAX) || null,
        open_cards: person.openCount,
        cards: person.cardCount,
        last_seen: iso(person.lastSeenAt),
      })),
    });
  },
});

export const getPerson = defineTool({
  name: "get_person",
  title: "Get a person",
  description: "One employee: home location, counts (open, approved, rejected, cancelled), items and sizes over the last 12 months, and the 20 newest cards.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({ person_id: z.string().min(1).max(64).describe("An id from find_people or get_order") }).strict(),
  async run(args, deps) {
    const now = deps.now();
    const page = await getPersonPage(deps.db, deps.principal.workspaceId, args.person_id, now);
    if (!page) {
      return fail("not_found", "No such person in this workspace.");
    }
    const statusByKey = new Map(page.statuses.map((status) => [status.key, status]));
    return ok(
      {
        id: page.person.id,
        name: personLabel(page.person.storedName),
        home_location: page.person.homeLocation ? { id: page.person.homeLocation.id, name: plainText(page.person.homeLocation.name, NAME_MAX) } : null,
        first_seen: iso(page.person.firstSeenAt),
        last_seen: iso(page.person.lastSeenAt),
        counts: page.counts,
        items_last_12_months: page.items.slice(0, 20).map((item) => ({ title: plainText(item.title, 160), size: plainText(item.variant, 80) || null, quantity: item.quantity })),
        recent_cards: page.cards.slice(0, CARDS_MAX).map((summary) => cardLine(summary, statusByKey, now)),
      },
      { kind: "person", id: page.person.id },
    );
  },
});

export const listLocations = defineTool({
  name: "list_locations",
  title: "List company locations",
  description: "The workspace's company locations (branches): id, name, whether active, open cards and all cards. Use an id or name with get_location.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({}).strict(),
  async run(_args, deps) {
    const rows = await listLocationSummaries(deps.db, deps.principal.workspaceId);
    return ok({
      locations: rows.map((row) => ({ id: row.id, name: plainText(row.name, NAME_MAX), active: row.active, open_cards: row.openCount, cards: row.cardCount })),
    });
  },
});

export const getLocation = defineTool({
  name: "get_location",
  title: "Get a company location",
  description: "One company location: address, open cards, the 20 newest orders shipped there, top items and who ordered.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({ location: z.string().min(1).max(80).describe("A location id or name from list_locations") }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const now = deps.now();
    const ref = args.location.trim();
    const rows = await deps.db
      .select({ id: locations.shopifyLocationId })
      .from(locations)
      .where(and(eq(locations.workspaceId, p.workspaceId), or(eq(locations.shopifyLocationId, ref), sql`lower(${locations.name}) = ${ref.toLowerCase()}`)))
      .limit(1);
    const page = rows[0] ? await getLocationPage(deps.db, p.workspaceId, rows[0].id, now) : null;
    if (!page) {
      return fail("not_found", `No company location ${plainText(ref, 80)} in this workspace.`);
    }
    const statusByKey = new Map(page.statuses.map((status) => [status.key, status]));
    return ok(
      {
        id: page.location.id,
        name: plainText(page.location.name, NAME_MAX),
        active: page.location.active,
        address: page.location.address ? locationAddressLines(page.location.address).map((line) => plainText(line, 200)) : [],
        open_count: page.openCount,
        open_cards: page.openCards.slice(0, CARDS_MAX).map((summary) => cardLine(summary, statusByKey, now)),
        recent_orders: page.orders.slice(0, CARDS_MAX).map((summary) => cardLine(summary, statusByKey, now)),
        top_items: page.topItems.slice(0, 20).map((item) => ({ title: plainText(item.title, 160), size: plainText(item.variant, 80) || null, quantity: item.quantity })),
        people: page.people.slice(0, 20).map((person) => ({ id: person.id, name: personLabel(person.storedName), cards: person.cards })),
      },
      { kind: "location", id: page.location.id },
    );
  },
});
