// Shopify B2B company locations (comprehensive design section 2): the
// branches a request ships to. Read with the store's token through
// shopifyGraphql (allowlisted host, timeout, no token in any detail), every
// runtime value in variables. Needs read_companies or write_companies and
// a store with B2B; callers check companiesEnabled first. Callers always
// get a typed result, never an exception. Relative imports on purpose: the
// cron path bundles this into the custom worker entrypoint.

import type { LocationAddress } from "../../lib/address";
import type { AdminFailure } from "./admin";
import { shopifyGraphql } from "./client";
import { companyLocationIdOf } from "./normalize";

// 50 a page costs 153 points by the client.test.ts estimator; at most 20
// pages (1,000 locations) are read per sync.
export const LOCATIONS_PAGE = 50;
export const MAX_LOCATION_PAGES = 20;
export const LOCATION_NAME_MAX = 200;

const LOCATION_FIELDS = `
      id
      name
      company { id }
      shippingAddress { address1 address2 city province zoneCode zip country countryCode phone companyName }`;

export const COMPANY_LOCATIONS_QUERY = `query CompanyLocations($cursor: String) {
  companyLocations(first: ${LOCATIONS_PAGE}, after: $cursor, sortKey: ID) {
    nodes {${LOCATION_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const COMPANY_LOCATION_QUERY = `query CompanyLocationById($id: ID!) {
  companyLocation(id: $id) {${LOCATION_FIELDS}
  }
}`;

export type CompanyLocationRecord = {
  shopifyLocationId: string;
  companyId: string | null;
  name: string;
  address: LocationAddress | null;
};

const COMPANY_GID = /^gid:\/\/shopify\/Company\/([1-9]\d{0,19})$/;

export function companyLocationGid(id: string): string {
  return `gid://shopify/CompanyLocation/${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeCompanyLocation(node: unknown): CompanyLocationRecord | null {
  if (!isRecord(node)) {
    return null;
  }
  const shopifyLocationId = companyLocationIdOf(node.id);
  if (!shopifyLocationId) {
    return null;
  }
  const company = isRecord(node.company) ? node.company : null;
  const address = isRecord(node.shippingAddress) ? node.shippingAddress : null;
  return {
    shopifyLocationId,
    companyId: typeof company?.id === "string" ? (company.id.match(COMPANY_GID)?.[1] ?? null) : null,
    name: str(node.name).slice(0, LOCATION_NAME_MAX) || `Location ${shopifyLocationId}`,
    address: address
      ? {
          address1: str(address.address1),
          address2: str(address.address2),
          city: str(address.city),
          province: str(address.province),
          provinceCode: str(address.zoneCode),
          zip: str(address.zip),
          country: str(address.country),
          countryCode: str(address.countryCode),
          phone: str(address.phone),
          company: str(address.companyName),
        }
      : null,
  };
}

// Every company location of the store. complete is false when the run
// stopped before the last page (the page cap, a page without a cursor, or a
// failure after the first page): the locations gathered are real, but one
// missing from them may still exist, so nothing is deactivated for it.
export async function fetchCompanyLocations(
  shopDomain: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; locations: CompanyLocationRecord[]; complete: boolean } | AdminFailure> {
  const locations: CompanyLocationRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
    const result = await shopifyGraphql(shopDomain, token, COMPANY_LOCATIONS_QUERY, { cursor }, fetchImpl);
    if (result.kind !== "ok") {
      return page === 0 ? result : { kind: "ok", locations, complete: false };
    }
    const connection = result.data.companyLocations;
    if (!isRecord(connection) || !Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) {
      return page === 0 ? { kind: "transient", detail: "unexpected response shape" } : { kind: "ok", locations, complete: false };
    }
    for (const node of connection.nodes) {
      const location = normalizeCompanyLocation(node);
      if (location) {
        locations.push(location);
      }
    }
    if (connection.pageInfo.hasNextPage !== true) {
      return { kind: "ok", locations, complete: true };
    }
    if (typeof connection.pageInfo.endCursor !== "string" || connection.pageInfo.endCursor.length === 0) {
      return { kind: "ok", locations, complete: false };
    }
    cursor = connection.pageInfo.endCursor;
  }
  return { kind: "ok", locations, complete: false };
}

// One location as Shopify has it now, or null when it no longer exists.
export async function fetchCompanyLocation(
  shopDomain: string,
  token: string,
  locationGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; location: CompanyLocationRecord | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, COMPANY_LOCATION_QUERY, { id: locationGid }, fetchImpl);
  if (result.kind !== "ok") {
    return result;
  }
  return { kind: "ok", location: normalizeCompanyLocation(result.data.companyLocation) };
}
