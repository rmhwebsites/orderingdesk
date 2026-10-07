// Shopify documents for placing a request through an AI app (comprehensive
// desk design section 4): find product variants, read a customer's company
// contacts and their location roles, calculate a draft (the $0 check, no
// draft is created), create the draft (sent once), and find a draft by its
// marker tag (the read after a timeout, never a resend). Validated against
// Admin 2026-10. Every runtime value travels in variables; callers always
// get a typed result. Relative imports only: custom-worker.ts bundles this.

import { DRAFT_FIELDS, shopifyGraphql, type GraphqlResult } from "./client";
import { legacyIdOf, userErrorsOf, type AdminFailure } from "./admin";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function failed(result: Exclude<GraphqlResult, { kind: "ok" }>): AdminFailure {
  return result;
}

function amountOf(value: unknown): string | null {
  const money = isRecord(value) && isRecord(value.shopMoney) ? value.shopMoney : null;
  const amount = money?.amount;
  return typeof amount === "string" ? amount : typeof amount === "number" && Number.isFinite(amount) ? String(amount) : null;
}

export const FIND_VARIANTS_QUERY = `query FindVariants($query: String!) {
  productVariants(first: 10, query: $query) {
    nodes { id legacyResourceId title sku displayName product { id title status } }
  }
}`;

export type VariantMatch = { variantId: string; product: string; variant: string; sku: string; active: boolean };

export async function findVariants(
  shopDomain: string,
  token: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; variants: VariantMatch[] } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, FIND_VARIANTS_QUERY, { query: text }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const nodes = isRecord(result.data.productVariants) && Array.isArray(result.data.productVariants.nodes) ? result.data.productVariants.nodes : [];
  return {
    kind: "ok",
    variants: nodes.filter(isRecord).map((node) => {
      const product = isRecord(node.product) ? node.product : {};
      const variant = str(node.title);
      return {
        variantId: str(node.legacyResourceId) || legacyIdOf(str(node.id)),
        product: str(product.title),
        variant: variant === "Default Title" ? "" : variant,
        sku: str(node.sku),
        active: product.status === "ACTIVE",
      };
    }),
  };
}

export const CONTACT_PROFILES_QUERY = `query ContactOfCustomer($id: ID!) {
  customer(id: $id) {
    id
    companyContactProfiles {
      id
      company { id }
      roleAssignments(first: 20) { nodes { companyLocation { id name } } }
    }
  }
}`;

export type ContactProfile = { contactId: string; companyId: string; locationIds: string[] };

// null profiles: Shopify has no such customer.
export async function fetchContactProfiles(
  shopDomain: string,
  token: string,
  customerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; profiles: ContactProfile[] | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, CONTACT_PROFILES_QUERY, { id: `gid://shopify/Customer/${customerId}` }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const customer = result.data.customer;
  if (!isRecord(customer)) {
    return { kind: "ok", profiles: null };
  }
  const profiles = Array.isArray(customer.companyContactProfiles) ? customer.companyContactProfiles.filter(isRecord) : [];
  return {
    kind: "ok",
    profiles: profiles.map((profile) => {
      const roles = isRecord(profile.roleAssignments) && Array.isArray(profile.roleAssignments.nodes) ? profile.roleAssignments.nodes.filter(isRecord) : [];
      return {
        contactId: legacyIdOf(str(profile.id)),
        companyId: isRecord(profile.company) ? legacyIdOf(str(profile.company.id)) : "",
        locationIds: roles.map((role) => (isRecord(role.companyLocation) ? legacyIdOf(str(role.companyLocation.id)) : "")).filter((id) => id.length > 0),
      };
    }),
  };
}

export const CALCULATE_REQUEST_MUTATION = `mutation CalculateRequest($input: DraftOrderInput!) {
  draftOrderCalculate(input: $input) {
    calculatedDraftOrder {
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems { title quantity sku variantTitle originalUnitPriceSet { shopMoney { amount } } }
    }
    userErrors { field message }
  }
}`;

export type CalculatedRequest = {
  total: string | null;
  currency: string;
  lines: { title: string; variant: string; sku: string; quantity: number; unitPrice: string | null }[];
};

export async function calculateRequest(
  shopDomain: string,
  token: string,
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; calculated: CalculatedRequest } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, CALCULATE_REQUEST_MUTATION, { input }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const payload = result.data.draftOrderCalculate;
  const refused = userErrorsOf(payload);
  if (refused) {
    return { kind: "refused", detail: refused };
  }
  const calculated = isRecord(payload) && isRecord(payload.calculatedDraftOrder) ? payload.calculatedDraftOrder : null;
  if (!calculated) {
    return { kind: "transient", detail: "Shopify returned no calculation" };
  }
  const totalSet = isRecord(calculated.totalPriceSet) && isRecord(calculated.totalPriceSet.shopMoney) ? calculated.totalPriceSet.shopMoney : {};
  const lines = Array.isArray(calculated.lineItems) ? calculated.lineItems.filter(isRecord) : [];
  return {
    kind: "ok",
    calculated: {
      total: amountOf(calculated.totalPriceSet),
      currency: str(totalSet.currencyCode) || "USD",
      lines: lines.map((line) => {
        const variant = str(line.variantTitle);
        return {
          title: str(line.title),
          variant: variant === "Default Title" ? "" : variant,
          sku: str(line.sku),
          quantity: typeof line.quantity === "number" ? line.quantity : 0,
          unitPrice: amountOf(line.originalUnitPriceSet),
        };
      }),
    },
  };
}

export const PLACE_REQUEST_MUTATION = `mutation PlaceRequest($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {${DRAFT_FIELDS}
    }
    userErrors { field message }
  }
}`;

// Sent once. node: the new draft in the sync's selection (null when Shopify
// sent none). A timeout or transport failure comes back as transient: the
// caller then looks the draft up by its marker, never sends again.
export async function createRequestDraft(
  shopDomain: string,
  token: string,
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, PLACE_REQUEST_MUTATION, { input }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const payload = result.data.draftOrderCreate;
  const refused = userErrorsOf(payload);
  if (refused) {
    return { kind: "refused", detail: refused };
  }
  return { kind: "ok", node: isRecord(payload) && isRecord(payload.draftOrder) ? payload.draftOrder : null };
}

export const DRAFT_BY_MARKER_QUERY = `query DraftByMarker($query: String!) {
  draftOrders(first: 2, query: $query) {
    nodes {${DRAFT_FIELDS}
    }
  }
}`;

const MARKER = /^od-ai-[0-9a-f]{16}$/;

export function markerTag(hex: string): string {
  return `od-ai-${hex}`;
}

export async function findDraftByMarker(
  shopDomain: string,
  token: string,
  marker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  if (!MARKER.test(marker)) {
    return { kind: "fatal", detail: "invalid marker" };
  }
  const result = await shopifyGraphql(shopDomain, token, DRAFT_BY_MARKER_QUERY, { query: `tag:"${marker}"` }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const nodes = isRecord(result.data.draftOrders) && Array.isArray(result.data.draftOrders.nodes) ? result.data.draftOrders.nodes.filter(isRecord) : [];
  return { kind: "ok", node: nodes[0] ?? null };
}
