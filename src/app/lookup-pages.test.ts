import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { indexOrders } from "@/server/search/index-orders";
import {
  openTestDb,
  seedLocation,
  seedMember,
  seedOrder,
  seedUser,
  seedWorkspace,
  setOrderLocation,
  snapshotOf,
} from "@/server/desk/test-helpers";

// The People and Locations pages by host and member, for real against an
// in-memory database; redirect and notFound throw markers like Next's.
const state: { db: Db | null; host: string; session: { user: { id: string; email: string } } | null } = {
  db: null,
  host: "orderingdesk.test",
  session: null,
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com" }, ctx: {} }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async (resolution: { kind: string }) =>
    resolution.kind === "unknown" ? null : { api: { getSession: async () => state.session } },
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { default: HubPeople } = await import("./w/[slug]/people/page");
const { default: HubPerson } = await import("./w/[slug]/people/[id]/page");
const { default: HubLocations } = await import("./w/[slug]/locations/page");
const { default: HubLocation } = await import("./w/[slug]/locations/[id]/page");
const { default: HostPeople } = await import("./people/page");
const { default: HostPerson } = await import("./people/[id]/page");
const { default: HostLocations } = await import("./locations/page");
const { default: HostLocation } = await import("./locations/[id]/page");
const { PeopleListView } = await import("@/components/lookup/people-list-view");
const { PersonView } = await import("@/components/lookup/person-view");
const { LocationsListView } = await import("@/components/lookup/locations-list-view");
const { LocationView } = await import("@/components/lookup/location-view");
const { WorkspaceShell } = await import("@/components/shell/workspace-shell");

const CLIENT_HOST = "orders.example.com";
let personId = "";

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_other");
  await db
    .update(schema.workspaces)
    .set({ customDomain: CLIENT_HOST, customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
  await seedUser(db, "u_staff", "staff@example.com");
  await seedUser(db, "u_out", "out@example.com");
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_other", "u_out", "manager");
  await seedLocation(db, "ws_impact", { shopifyLocationId: "loc_north", name: "North Yard" });
  await seedOrder(db, "ws_impact", { id: "o1", shopify: snapshotOf({ customerId: "77", customerName: "Riley Oakes" }) });
  await setOrderLocation(db, "o1", "loc_north");
  await indexOrders(db, "ws_impact", ["o1"]);
  personId = (await db.select().from(schema.people))[0].id;
});

async function outcome(render: () => Promise<unknown>): Promise<string | ReactElement> {
  try {
    const element = await render();
    if (!isValidElement(element)) {
      throw new Error("expected an element");
    }
    return element;
  } catch (e) {
    if (e instanceof Error && (e.message.startsWith("REDIRECT") || e.message === "NOT_FOUND")) {
      return e.message;
    }
    throw e;
  }
}

const as = (id: string, email: string) => {
  state.session = { user: { id, email } };
};
const listOf = (slug: string) => ({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) });
const one = (slug: string, id: string) => ({ params: Promise.resolve({ slug, id }) });
const hostList = () => ({ searchParams: Promise.resolve({}) });
const hostOne = (id: string) => ({ params: Promise.resolve({ id }) });

describe("People and Locations on the hub", () => {
  it("send a signed-out visitor to sign in and answer a non-member with not found", async () => {
    expect(await outcome(() => HubPeople(listOf("ws_impact")))).toBe("REDIRECT /sign-in");
    as("u_out", "out@example.com");
    expect(await outcome(() => HubPeople(listOf("ws_impact")))).toBe("NOT_FOUND");
    expect(await outcome(() => HubPerson(one("ws_impact", personId)))).toBe("NOT_FOUND");
    expect(await outcome(() => HubLocations({ params: Promise.resolve({ slug: "ws_impact" }) }))).toBe("NOT_FOUND");
    expect(await outcome(() => HubLocation(one("ws_impact", "loc_north")))).toBe("NOT_FOUND");
  });

  it("show a member the people list, a person, the locations and a location", async () => {
    as("u_staff", "staff@example.com");
    const people = (await outcome(() => HubPeople(listOf("ws_impact")))) as ReactElement<{
      data: { people: { name: string }[] };
      basePath: string;
    }>;
    expect(people.type).toBe(PeopleListView);
    expect(people.props.data.people.map((person) => person.name)).toEqual(["Riley Oakes"]);
    expect(people.props.basePath).toBe("/w/ws_impact");
    const person = (await outcome(() => HubPerson(one("ws_impact", personId)))) as ReactElement<{ data: { person: { name: string } } }>;
    expect(person.type).toBe(PersonView);
    expect(person.props.data.person.name).toBe("Riley Oakes");
    expect(((await outcome(() => HubLocations({ params: Promise.resolve({ slug: "ws_impact" }) }))) as ReactElement).type).toBe(LocationsListView);
    expect(((await outcome(() => HubLocation(one("ws_impact", "loc_north")))) as ReactElement).type).toBe(LocationView);
  });

  it("answer not found for an unknown person or location, or another workspace's", async () => {
    as("u_staff", "staff@example.com");
    expect(await outcome(() => HubPerson(one("ws_impact", "nobody")))).toBe("NOT_FOUND");
    expect(await outcome(() => HubLocation(one("ws_impact", "loc_missing")))).toBe("NOT_FOUND");
    as("u_out", "out@example.com");
    expect(await outcome(() => HubPerson(one("ws_other", personId)))).toBe("NOT_FOUND");
    expect(await outcome(() => HubLocation(one("ws_other", "loc_north")))).toBe("NOT_FOUND");
  });
});

describe("People and Locations on the client host", () => {
  it("redirect the workspace's own slug to the short path and hide every other workspace", async () => {
    state.host = CLIENT_HOST;
    as("u_staff", "staff@example.com");
    expect(await outcome(() => HubPerson(one("ws_impact", personId)))).toBe(`REDIRECT /people/${personId}`);
    expect(await outcome(() => HubLocations({ params: Promise.resolve({ slug: "ws_impact" }) }))).toBe("REDIRECT /locations");
    expect(await outcome(() => HubPeople(listOf("ws_other")))).toBe("NOT_FOUND");
  });

  it("serve /people, /people/[id], /locations and /locations/[id] in the client host shell", async () => {
    state.host = CLIENT_HOST;
    expect(await outcome(() => HostPerson(hostOne(personId)))).toBe("REDIRECT /sign-in");
    as("u_staff", "staff@example.com");
    const person = (await outcome(() => HostPerson(hostOne(personId)))) as ReactElement<{
      clientHost: boolean;
      children: ReactElement<{ basePath: string }>;
    }>;
    expect(person.type).toBe(WorkspaceShell);
    expect(person.props.clientHost).toBe(true);
    expect(person.props.children.type).toBe(PersonView);
    expect(person.props.children.props.basePath).toBe("");
    const shellChild = async (render: () => Promise<unknown>) =>
      ((await outcome(render)) as ReactElement<{ children: ReactElement }>).props.children.type;
    expect(await shellChild(() => HostPeople(hostList()))).toBe(PeopleListView);
    expect(await shellChild(() => HostLocations())).toBe(LocationsListView);
    expect(await shellChild(() => HostLocation(hostOne("loc_north")))).toBe(LocationView);
  });

  it("do not exist on the hub", async () => {
    as("u_staff", "staff@example.com");
    expect(await outcome(() => HostPeople(hostList()))).toBe("NOT_FOUND");
    expect(await outcome(() => HostLocation(hostOne("loc_north")))).toBe("NOT_FOUND");
  });
});
