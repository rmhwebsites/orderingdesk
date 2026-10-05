// The Shopify Admin operations of the two-way sync (platform amendment
// sections 2 to 4): webhook subscriptions, one order, one customer, the
// tagged-customer roster, status tags and fulfillments. Every request goes
// through shopifyGraphql (allowlisted host, no redirects, timeout, no token
// in any detail) with every runtime value in variables. Relative imports on
// purpose: the cron path bundles this into the custom worker entrypoint.
// Callers always get a typed result, never an exception.

import { ORDER_FIELDS, shopifyGraphql, type GraphqlResult } from "./client";
import { normalizeLineItems, type NormalizedOrder } from "./normalize";

export type AdminFailure =
  | { kind: "auth" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string }
  // Shopify answered a mutation with userErrors (its own words in detail).
  | { kind: "refused"; detail: string };

// A failure as one sentence for an activity event or a warning.
export function failureText(failure: AdminFailure): string {
  return failure.kind === "auth" ? "Shopify rejected the access token" : failure.detail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(result: Exclude<GraphqlResult, { kind: "ok" }>): AdminFailure {
  return result;
}

// The messages of a mutation payload's userErrors, or null when there are
// none.
function userErrorsOf(payload: unknown): string | null {
  const errors = isRecord(payload) ? payload.userErrors : undefined;
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }
  const messages = errors
    .map((error) => (isRecord(error) && typeof error.message === "string" ? error.message : ""))
    .filter((message) => message.length > 0);
  return messages.length > 0 ? messages.join("; ") : "Shopify refused the change";
}

// The numeric id at the end of a gid ("gid://shopify/Customer/42" -> "42").
export function legacyIdOf(gid: string): string {
  return gid.slice(gid.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// Webhook subscriptions

// The topics registered on connect (platform amendment section 4).
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_FULFILLED",
  "ORDERS_PARTIALLY_FULFILLED",
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "CUSTOMERS_DELETE",
] as const;

// Where Shopify delivers a workspace's webhooks: always the platform host
// (APP_URL), never a client's custom domain.
export function webhookCallbackUrl(appUrl: string, workspaceId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/shopify/${encodeURIComponent(workspaceId)}`;
}

const WEBHOOKS_QUERY = `query WebhookSubscriptions($cursor: String) {
  webhookSubscriptions(first: 50, after: $cursor) {
    nodes { id topic uri }
    pageInfo { hasNextPage endCursor }
  }
}`;
const WEBHOOK_DELETE = `mutation WebhookSubscriptionDelete($id: ID!) {
  webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } }
}`;
const WEBHOOK_CREATE = `mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;
// An app has a handful of subscriptions per shop; 4 pages of 50 is ample.
const MAX_WEBHOOK_PAGES = 4;

// Creates one subscription per topic pointing at callbackUrl, first deleting
// the app's existing subscriptions for that exact address (a reconnect
// replaces them; Shopify refuses a second subscription for the same topic
// and address). Subscriptions for any other address are left alone.
export async function replaceWebhookSubscriptions(
  shopDomain: string,
  token: string,
  callbackUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok" } | AdminFailure> {
  const stale: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_WEBHOOK_PAGES; page++) {
    const listed = await shopifyGraphql(shopDomain, token, WEBHOOKS_QUERY, { cursor }, fetchImpl);
    if (listed.kind !== "ok") {
      return failed(listed);
    }
    const connection = listed.data.webhookSubscriptions;
    const nodes = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : [];
    for (const node of nodes) {
      if (isRecord(node) && node.uri === callbackUrl && typeof node.id === "string") {
        stale.push(node.id);
      }
    }
    const pageInfo = isRecord(connection) ? connection.pageInfo : undefined;
    if (!isRecord(pageInfo) || pageInfo.hasNextPage !== true || typeof pageInfo.endCursor !== "string") {
      break;
    }
    cursor = pageInfo.endCursor;
  }

  for (const id of stale) {
    const deleted = await shopifyGraphql(shopDomain, token, WEBHOOK_DELETE, { id }, fetchImpl);
    if (deleted.kind !== "ok") {
      return failed(deleted);
    }
    const refused = userErrorsOf(deleted.data.webhookSubscriptionDelete);
    if (refused) {
      return { kind: "refused", detail: refused };
    }
  }

  for (const topic of WEBHOOK_TOPICS) {
    const created = await shopifyGraphql(
      shopDomain,
      token,
      WEBHOOK_CREATE,
      { topic, webhookSubscription: { uri: callbackUrl, format: "JSON" } },
      fetchImpl,
    );
    if (created.kind !== "ok") {
      return failed(created);
    }
    const refused = userErrorsOf(created.data.webhookSubscriptionCreate);
    if (refused) {
      return { kind: "refused", detail: refused };
    }
  }
  return { kind: "ok" };
}

// ---------------------------------------------------------------------------
// One order, re-fetched for a webhook

// The same selection as the sync's page query (ORDER_FIELDS), so the node
// normalizes to exactly the snapshot shape the sync stores. One order costs
// about 160 points by the client.test.ts estimator.
const ORDER_QUERY = `query OrderById($id: ID!) {
  order(id: $id) {${ORDER_FIELDS}
  }
}`;

// The raw order node, or null when Shopify has no such order.
export async function fetchOrderNode(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, ORDER_QUERY, { id: orderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  return { kind: "ok", node: isRecord(result.data.order) ? result.data.order : null };
}

// ---------------------------------------------------------------------------
// Every line item of one order (a purchase order prefill): the sync stores
// only the first 48 and marks the rest as missing (itemsTruncated). 100 a
// page costs about 304 points by the client.test.ts estimator; at most 10
// pages (1,000 line items) are read.

export const LINE_ITEM_PAGE = 100;
export const MAX_LINE_ITEM_PAGES = 10;

export const ORDER_LINE_ITEMS_QUERY = `query OrderLineItems($id: ID!, $cursor: String) {
  order(id: $id) {
    lineItems(first: ${LINE_ITEM_PAGE}, after: $cursor) {
      nodes { title quantity sku variantTitle originalUnitPriceSet { shopMoney { amount } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

// items null: Shopify has no such order. complete false: more line items
// exist than were read (the page cap, or a page without a cursor).
export async function fetchAllLineItems(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; items: NormalizedOrder["items"] | null; complete: boolean } | AdminFailure> {
  const items: NormalizedOrder["items"] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LINE_ITEM_PAGES; page++) {
    const result = await shopifyGraphql(shopDomain, token, ORDER_LINE_ITEMS_QUERY, { id: orderGid, cursor }, fetchImpl);
    if (result.kind !== "ok") {
      return failed(result);
    }
    const order = result.data.order;
    if (!isRecord(order)) {
      return { kind: "ok", items: null, complete: true };
    }
    const connection = isRecord(order.lineItems) ? order.lineItems : {};
    items.push(...normalizeLineItems(connection));
    const pageInfo = isRecord(connection.pageInfo) ? connection.pageInfo : {};
    if (pageInfo.hasNextPage === false) {
      return { kind: "ok", items, complete: true };
    }
    if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0) {
      return { kind: "ok", items, complete: false };
    }
    cursor = pageInfo.endCursor;
  }
  return { kind: "ok", items, complete: false };
}

// ---------------------------------------------------------------------------
// Customers, for the roster (platform amendment section 2)

export type RosterCustomer = {
  // The numeric customer id (stored in shopify_roster.shopify_customer_id).
  customerId: string;
  // Lowercased; null when the customer has no email.
  email: string | null;
  tags: string[];
};

function rosterCustomerOf(node: unknown): RosterCustomer | null {
  if (!isRecord(node) || typeof node.id !== "string" || node.id.length === 0) {
    return null;
  }
  const email = typeof node.email === "string" && node.email.trim().length > 0 ? node.email.trim().toLowerCase() : null;
  const tags = Array.isArray(node.tags) ? node.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return { customerId: legacyIdOf(node.id), email, tags };
}

const CUSTOMER_QUERY = `query RosterCustomer($id: ID!) {
  customer(id: $id) { id email tags }
}`;

// The customer as Shopify has it now, or null when it no longer exists.
export async function fetchCustomer(
  shopDomain: string,
  token: string,
  customerGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; customer: RosterCustomer | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, CUSTOMER_QUERY, { id: customerGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  return { kind: "ok", customer: rosterCustomerOf(result.data.customer) };
}

// 100 customers of two scalars each: 2 + 100 + 1 = 103 points a page by the
// client.test.ts estimator, far inside the 1,000 point single query limit.
export const ROSTER_PAGE_SIZE = 100;
// Up to 2,000 tagged customers per run; beyond that the run is incomplete
// and only adds (see syncRoster).
export const MAX_ROSTER_PAGES = 20;

const CUSTOMERS_QUERY = `query RosterCustomers($cursor: String, $search: String) {
  customers(first: ${ROSTER_PAGE_SIZE}, after: $cursor, query: $search) {
    nodes { id email tags }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Shopify search syntax: each tag quoted, with backslashes and quotes
// escaped, any of them matching.
export function rosterSearch(tags: string[]): string {
  return tags
    .map((tag) => `tag:"${tag.split("\\").join("\\\\").split('"').join('\\"')}"`)
    .join(" OR ");
}

// Every customer carrying any of the tags. complete is false when the run
// stopped before the last page (page cap, a page without a cursor, or a
// failure after the first page): the customers gathered are real, but a
// customer missing from them may still be tagged.
export async function fetchTaggedCustomers(
  shopDomain: string,
  token: string,
  tags: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; customers: RosterCustomer[]; complete: boolean } | AdminFailure> {
  const search = rosterSearch(tags);
  const customers: RosterCustomer[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ROSTER_PAGES; page++) {
    const result = await shopifyGraphql(shopDomain, token, CUSTOMERS_QUERY, { cursor, search }, fetchImpl);
    if (result.kind !== "ok") {
      return page === 0 ? failed(result) : { kind: "ok", customers, complete: false };
    }
    const connection = result.data.customers;
    if (!isRecord(connection) || !Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) {
      return page === 0
        ? { kind: "transient", detail: "unexpected response shape" }
        : { kind: "ok", customers, complete: false };
    }
    for (const node of connection.nodes) {
      const customer = rosterCustomerOf(node);
      if (customer) {
        customers.push(customer);
      }
    }
    if (connection.pageInfo.hasNextPage !== true) {
      return { kind: "ok", customers, complete: true };
    }
    if (typeof connection.pageInfo.endCursor !== "string" || connection.pageInfo.endCursor.length === 0) {
      return { kind: "ok", customers, complete: false };
    }
    cursor = connection.pageInfo.endCursor;
  }
  return { kind: "ok", customers, complete: false };
}

// ---------------------------------------------------------------------------
// Status tags and fulfillments (App -> Shopify)

const ORDER_TAGS_QUERY = `query OrderTags($id: ID!) {
  order(id: $id) { id tags }
}`;
const TAGS_REMOVE = `mutation StatusTagRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
}`;
const TAGS_ADD = `mutation StatusTagAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

// The order's current tags, or null when Shopify has no such order.
export async function fetchOrderTags(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; tags: string[] | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, ORDER_TAGS_QUERY, { id: orderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const order = result.data.order;
  if (!isRecord(order)) {
    return { kind: "ok", tags: null };
  }
  return {
    kind: "ok",
    tags: Array.isArray(order.tags) ? order.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

async function tagMutation(
  document: string,
  field: "tagsAdd" | "tagsRemove",
  shopDomain: string,
  token: string,
  orderGid: string,
  tags: string[],
  fetchImpl: typeof fetch,
): Promise<{ kind: "ok" } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, document, { id: orderGid, tags }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const refused = userErrorsOf(result.data[field]);
  return refused ? { kind: "refused", detail: refused } : { kind: "ok" };
}

export function removeOrderTags(
  shopDomain: string,
  token: string,
  orderGid: string,
  tags: string[],
  fetchImpl: typeof fetch = fetch,
) {
  return tagMutation(TAGS_REMOVE, "tagsRemove", shopDomain, token, orderGid, tags, fetchImpl);
}

export function addOrderTags(
  shopDomain: string,
  token: string,
  orderGid: string,
  tags: string[],
  fetchImpl: typeof fetch = fetch,
) {
  return tagMutation(TAGS_ADD, "tagsAdd", shopDomain, token, orderGid, tags, fetchImpl);
}

// An order has a few fulfillment orders at most (one per location).
const FULFILLMENT_ORDERS_QUERY = `query OpenFulfillmentOrders($id: ID!) {
  order(id: $id) {
    id
    fulfillmentOrders(first: 10) { nodes { id status supportedActions { action } } }
  }
}`;
const FULFILLMENT_CREATE = `mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status }
    userErrors { field message }
  }
}`;

// The order's fulfillment orders that can be fulfilled now (Shopify lists
// CREATE_FULFILLMENT among their supported actions), or null when Shopify
// has no such order.
export async function fetchFulfillableOrderIds(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; ids: string[] | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, FULFILLMENT_ORDERS_QUERY, { id: orderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const order = result.data.order;
  if (!isRecord(order)) {
    return { kind: "ok", ids: null };
  }
  const connection = order.fulfillmentOrders;
  const nodes = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : [];
  const ids = nodes
    .filter(
      (node): node is Record<string, unknown> =>
        isRecord(node) &&
        typeof node.id === "string" &&
        Array.isArray(node.supportedActions) &&
        node.supportedActions.some((item) => isRecord(item) && item.action === "CREATE_FULFILLMENT"),
    )
    .map((node) => node.id as string);
  return { kind: "ok", ids };
}

// Fulfills every line item of one fulfillment order. The customer is never
// notified (Ryan: never email customers from a status change).
export async function createFulfillment(
  shopDomain: string,
  token: string,
  fulfillmentOrderId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok" } | AdminFailure> {
  const result = await shopifyGraphql(
    shopDomain,
    token,
    FULFILLMENT_CREATE,
    { fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }], notifyCustomer: false } },
    fetchImpl,
  );
  if (result.kind !== "ok") {
    return failed(result);
  }
  const refused = userErrorsOf(result.data.fulfillmentCreate);
  return refused ? { kind: "refused", detail: refused } : { kind: "ok" };
}
