import { describe, it, expect } from "vitest";
import {
  COMPANY_LOCATIONS_QUERY,
  LOCATIONS_PAGE,
  MAX_LOCATION_PAGES,
  companyLocationGid,
  fetchCompanyLocation,
  fetchCompanyLocations,
  normalizeCompanyLocation,
} from "./locations";

// Shopify B2B company locations (comprehensive design section 2), against a
// stubbed fetch.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_locations_token_never_leak";

const node = (id: number, name: string, overrides: Record<string, unknown> = {}) => ({
  id: `gid://shopify/CompanyLocation/${id}`,
  name,
  company: { id: "gid://shopify/Company/7" },
  shippingAddress: {
    address1: "100 Example Way",
    address2: null,
    city: "Buford",
    province: "Georgia",
    zoneCode: "GA",
    zip: "30518",
    country: "United States",
    countryCode: "US",
    phone: null,
    companyName: "Example Rentals",
  },
  ...overrides,
});

type Call = { query: string; variables: Record<string, unknown> };

function stub(answer: (call: Call, index: number) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call, calls.length - 1);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const page = (nodes: unknown[], next: string | null) => ({
  data: { companyLocations: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
});

describe("normalizeCompanyLocation", () => {
  it("keeps the legacy ids, the name and the shipping address", () => {
    expect(normalizeCompanyLocation(node(101, " Buford HQ "))).toEqual({
      shopifyLocationId: "101",
      companyId: "7",
      name: "Buford HQ",
      address: {
        address1: "100 Example Way",
        address2: "",
        city: "Buford",
        province: "Georgia",
        provinceCode: "GA",
        zip: "30518",
        country: "United States",
        countryCode: "US",
        phone: "",
        company: "Example Rentals",
      },
    });
  });

  it("degrades a missing address, company or name, and skips nodes without a location id", () => {
    expect(normalizeCompanyLocation(node(102, "", { shippingAddress: null, company: null }))).toEqual({
      shopifyLocationId: "102",
      companyId: null,
      name: "Location 102",
      address: null,
    });
    expect(normalizeCompanyLocation({ id: "gid://shopify/Location/5", name: "Warehouse" })).toBeNull();
    expect(normalizeCompanyLocation(null)).toBeNull();
  });
});

describe("fetchCompanyLocations", () => {
  it("reads every page with the cursor in a variable", async () => {
    const { impl, calls } = stub((_call, index) =>
      index === 0 ? page([node(101, "Buford HQ"), node(102, "Mableton")], "c1") : page([node(103, "Athens")], null),
    );
    const result = await fetchCompanyLocations(DOMAIN, TOKEN, impl);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.complete).toBe(true);
    expect(result.locations.map((location) => location.shopifyLocationId)).toEqual(["101", "102", "103"]);
    expect(calls.map((call) => call.variables)).toEqual([{ cursor: null }, { cursor: "c1" }]);
    expect(calls[0].query).toBe(COMPANY_LOCATIONS_QUERY);
    expect(COMPANY_LOCATIONS_QUERY).toContain(`companyLocations(first: ${LOCATIONS_PAGE}, after: $cursor, sortKey: ID)`);
    expect(MAX_LOCATION_PAGES).toBe(20);
  });

  it("fails on the first page, and reports a partial list when a later page fails", async () => {
    const first = stub(() => new Response("busy", { status: 503 }));
    expect(await fetchCompanyLocations(DOMAIN, TOKEN, first.impl)).toEqual({
      kind: "transient",
      detail: "Shopify responded with HTTP 503",
    });
    const later = stub((_call, index) => (index === 0 ? page([node(101, "Buford HQ")], "c1") : new Response("busy", { status: 503 })));
    const result = await fetchCompanyLocations(DOMAIN, TOKEN, later.impl);
    expect(result).toMatchObject({ kind: "ok", complete: false });
  });
});

describe("fetchCompanyLocation", () => {
  it("reads one location by gid, or null when Shopify has none", async () => {
    const found = stub(() => ({ data: { companyLocation: node(104, "Greenville") } }));
    const result = await fetchCompanyLocation(DOMAIN, TOKEN, companyLocationGid("104"), found.impl);
    expect(result).toMatchObject({ kind: "ok", location: { shopifyLocationId: "104", name: "Greenville" } });
    expect(found.calls[0].variables).toEqual({ id: "gid://shopify/CompanyLocation/104" });
    const gone = stub(() => ({ data: { companyLocation: null } }));
    expect(await fetchCompanyLocation(DOMAIN, TOKEN, companyLocationGid("105"), gone.impl)).toEqual({ kind: "ok", location: null });
  });
});
