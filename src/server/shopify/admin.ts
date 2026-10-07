// The Shopify Admin operations of the two-way sync (platform amendment
// sections 2 to 4): webhook subscriptions, one order, one customer, the
// tagged-customer roster, status tags and fulfillments; and for draft orders
// (draft orders spec section 3): one draft, the draft link lookup, and the
// approve documents. Every request goes
// through shopifyGraphql (allowlisted host, no redirects, timeout, no token
// in any detail) with every runtime value in variables. Relative imports on
// purpose: the cron path bundles this into the custom worker entrypoint.
// Callers always get a typed result, never an exception.

import { EDIT_LINES_MAX } from "../../lib/request-edit";
import { DRAFT_FIELDS, orderFieldsFor, shopifyGraphql, type GraphqlResult } from "./client";
import { companyLocationIdOf, normalizeLineItems, type NormalizedOrder } from "./normalize";

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
// Draft order scopes (draft orders spec section 14)

// Draft orders are an optional feature: they sync only when the app was
// granted these. REQUIRED_SCOPES (src/server/desk/connection.ts) does not
// include them, so a store without drafts keeps working as before.
export const DRAFT_SCOPES = ["read_draft_orders", "write_draft_orders"] as const;

// The draft scopes the grant lacks. A write scope implies its read scope
// (Shopify may list only the write handle), so write_draft_orders alone
// turns the feature on.
export function missingDraftScopes(granted: readonly string[] | null | undefined): string[] {
  const has = new Set(granted ?? []);
  return DRAFT_SCOPES.filter(
    (scope) => !(has.has(scope) || (scope.startsWith("read_") && has.has("write_" + scope.slice("read_".length)))),
  );
}

export function draftsEnabled(granted: readonly string[] | null | undefined): boolean {
  return Array.isArray(granted) && missingDraftScopes(granted).length === 0;
}

// Company locations (comprehensive design section 2): the location sync,
// the location webhooks and the purchasing entity's location on orders
// need a companies scope (the B2B company fields need it). Optional, like
// drafts.
export const COMPANY_SCOPES = ["read_companies", "write_companies"] as const;

export function companiesEnabled(granted: readonly string[] | null | undefined): boolean {
  return Array.isArray(granted) && COMPANY_SCOPES.some((scope) => granted.includes(scope));
}

// ---------------------------------------------------------------------------
// Webhook subscriptions

// The topics registered on connect (platform amendment section 4).
export const BASE_WEBHOOK_TOPICS = [
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

// Draft orders (draft orders spec section 7.2), only for an app that holds
// the draft scopes.
export const DRAFT_WEBHOOK_TOPICS = ["DRAFT_ORDERS_CREATE", "DRAFT_ORDERS_UPDATE", "DRAFT_ORDERS_DELETE"] as const;

// Company locations (comprehensive design section 2), only with a companies
// scope. Shopify accepts them with read_customers too, which every
// connection holds, so they can never be the refusal that stops
// registration; they still go before the draft topics, which stay last.
export const COMPANY_LOCATION_WEBHOOK_TOPICS = [
  "COMPANY_LOCATIONS_CREATE",
  "COMPANY_LOCATIONS_UPDATE",
  "COMPANY_LOCATIONS_DELETE",
] as const;

export type WebhookTopic =
  | (typeof BASE_WEBHOOK_TOPICS)[number]
  | (typeof COMPANY_LOCATION_WEBHOOK_TOPICS)[number]
  | (typeof DRAFT_WEBHOOK_TOPICS)[number];

// The topics to register for a grant. Shopify refuses a draft subscription
// without the scope, and replaceWebhookSubscriptions stops at the first
// refusal, so the draft topics are requested only with the scope, and last.
export function webhookTopicsFor(granted: readonly string[] | null | undefined): WebhookTopic[] {
  return [
    ...BASE_WEBHOOK_TOPICS,
    ...(companiesEnabled(granted) ? COMPANY_LOCATION_WEBHOOK_TOPICS : []),
    ...(draftsEnabled(granted) ? DRAFT_WEBHOOK_TOPICS : []),
  ];
}

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

// Creates one subscription per topic (in the order given) pointing at
// callbackUrl, first deleting the app's existing subscriptions for that
// exact address (a reconnect replaces them; Shopify refuses a second
// subscription for the same topic and address). Subscriptions for any other
// address are left alone. Stops at the first refusal.
export async function replaceWebhookSubscriptions(
  shopDomain: string,
  token: string,
  callbackUrl: string,
  topics: readonly WebhookTopic[],
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

  for (const topic of topics) {
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

// The same selection as the sync's page query, so the node normalizes to
// exactly the snapshot shape the sync stores. One order costs about 160
// points by the client.test.ts estimator (157 without the company
// location). companies: the stored grant holds a companies scope.
function orderQuery(companies: boolean): string {
  return `query OrderById($id: ID!) {
  order(id: $id) {${orderFieldsFor(companies)}
  }
}`;
}

// The raw order node, or null when Shopify has no such order.
export async function fetchOrderNode(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
  opts?: { companies?: boolean },
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, orderQuery(opts?.companies === true), { id: orderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  return { kind: "ok", node: isRecord(result.data.order) ? result.data.order : null };
}

// ---------------------------------------------------------------------------
// Draft orders (draft orders spec sections 3.3 to 3.6)

// gid://shopify/DraftOrder/<legacy id>
export function draftGid(draftId: string): string {
  return `gid://shopify/DraftOrder/${draftId}`;
}

// The same selection as the drafts page query (DRAFT_FIELDS), about 159
// points by the client.test.ts estimator.
export const DRAFT_ORDER_QUERY = `query DraftOrderById($id: ID!) {
  draftOrder(id: $id) {${DRAFT_FIELDS}
  }
}`;

// The raw draft node, or null when Shopify has no such draft (deleted, or
// purged after a year without activity).
export async function fetchDraftNode(
  shopDomain: string,
  token: string,
  draftOrderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, DRAFT_ORDER_QUERY, { id: draftOrderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  return { kind: "ok", node: isRecord(result.data.draftOrder) ? result.data.draftOrder : null };
}

// Live objects, not the search index, so a draft completed a second ago is
// seen as completed.
export const DRAFT_LINKS_QUERY = `query DraftLinks($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on DraftOrder { id legacyResourceId status updatedAt order { id legacyResourceId name } }
  }
}`;
export const DRAFT_LINK_CHUNK = 100;

// What Shopify says about one draft now: still a request, completed (with
// the legacy id and name of the order it became, when Shopify names it), or
// gone (deleted or purged).
export type DraftLink =
  | { kind: "open" }
  | { kind: "completed"; orderId: string | null; orderName: string | null }
  | { kind: "gone" };

function draftLinkOf(node: unknown): DraftLink | null {
  if (node === null) {
    return { kind: "gone" };
  }
  if (!isRecord(node) || typeof node.status !== "string") {
    // Not a draft at all, or a shape this code does not know: no verdict.
    return null;
  }
  if (node.status !== "COMPLETED") {
    return { kind: "open" };
  }
  const order = isRecord(node.order) ? node.order : null;
  const legacy = order?.legacyResourceId;
  const orderId =
    typeof legacy === "string" && legacy.length > 0
      ? legacy
      : typeof order?.id === "string" && order.id.length > 0
        ? legacyIdOf(order.id)
        : null;
  const orderName = typeof order?.name === "string" && order.name.length > 0 ? order.name : null;
  return { kind: "completed", orderId, orderName };
}

// The link state of each draft, by its legacy id, in chunks of
// DRAFT_LINK_CHUNK ids per request. Shopify answers a deleted draft with
// null in its place (gone). An id Shopify gave no usable verdict for is
// left out of the map. Any failed chunk fails the whole lookup.
export async function fetchDraftLinks(
  shopDomain: string,
  token: string,
  draftIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; links: Map<string, DraftLink> } | AdminFailure> {
  const links = new Map<string, DraftLink>();
  const ids = [...new Set(draftIds)];
  for (let i = 0; i < ids.length; i += DRAFT_LINK_CHUNK) {
    const chunk = ids.slice(i, i + DRAFT_LINK_CHUNK);
    const result = await shopifyGraphql(shopDomain, token, DRAFT_LINKS_QUERY, { ids: chunk.map(draftGid) }, fetchImpl);
    if (result.kind !== "ok") {
      return failed(result);
    }
    const nodes = result.data.nodes;
    if (!Array.isArray(nodes) || nodes.length !== chunk.length) {
      return { kind: "transient", detail: "unexpected response shape" };
    }
    chunk.forEach((id, index) => {
      const link = draftLinkOf(nodes[index]);
      if (link) {
        links.set(id, link);
      }
    });
  }
  return { kind: "ok", links };
}

// ---------------------------------------------------------------------------
// Requester ids of cards stored before snapshots kept them (Wave 1c search
// backfill): the Shopify customer and, for a B2B purchase, the company
// contact, read live by id.

export const REQUESTER_IDS_QUERY = `query RequesterIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order { id customer { id } purchasingEntity { __typename ... on PurchasingCompany { contact { id } } } }
    ... on DraftOrder { id customer { id } purchasingEntity { __typename ... on PurchasingCompany { contact { id } } } }
  }
}`;
export const REQUESTER_CHUNK = 50;

export type RequesterIds = { customerId: string; contactId: string };

function requesterIdsOf(node: unknown): RequesterIds | null {
  if (!isRecord(node)) {
    return null;
  }
  const customer = isRecord(node.customer) && typeof node.customer.id === "string" ? legacyIdOf(node.customer.id) : "";
  if (customer.length === 0) {
    return null;
  }
  const entity = isRecord(node.purchasingEntity) ? node.purchasingEntity : null;
  const contact = entity && isRecord(entity.contact) && typeof entity.contact.id === "string" ? legacyIdOf(entity.contact.id) : "";
  return { customerId: customer, contactId: contact };
}

// By order or draft gid, REQUESTER_CHUNK ids per request. A card with no
// customer (or one Shopify no longer has) is left out of the map. Any
// failed chunk fails the whole lookup.
export async function fetchRequesterIds(
  shopDomain: string,
  token: string,
  gids: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; ids: Map<string, RequesterIds> } | AdminFailure> {
  const ids = new Map<string, RequesterIds>();
  const unique = [...new Set(gids)];
  for (let i = 0; i < unique.length; i += REQUESTER_CHUNK) {
    const chunk = unique.slice(i, i + REQUESTER_CHUNK);
    const result = await shopifyGraphql(shopDomain, token, REQUESTER_IDS_QUERY, { ids: chunk }, fetchImpl);
    if (result.kind !== "ok") {
      return failed(result);
    }
    const nodes = result.data.nodes;
    if (!Array.isArray(nodes) || nodes.length !== chunk.length) {
      return { kind: "transient", detail: "unexpected response shape" };
    }
    chunk.forEach((gid, index) => {
      const found = requesterIdsOf(nodes[index]);
      if (found) {
        ids.set(gid, found);
      }
    });
  }
  return { kind: "ok", ids };
}

// Read fresh right before an approval: the status, whether Shopify has
// finished calculating the draft (ready), the order it became, the total.
export const DRAFT_BEFORE_APPROVE_QUERY = `query DraftBeforeApprove($id: ID!) {
  draftOrder(id: $id) {
    id name status ready completedAt
    order { id legacyResourceId name }
    totalPriceSet { shopMoney { amount currencyCode } }
  }
}`;

export type DraftForApprove = {
  name: string;
  // Shopify's own value: OPEN, INVOICE_SENT or COMPLETED.
  status: string;
  ready: boolean;
  completedAt: string | null;
  orderId: string | null;
  orderName: string | null;
  // The total as Shopify sent it (a decimal string), or null when missing.
  total: string | null;
  currency: string;
};

// The draft as Shopify has it now, or null when it no longer exists.
export async function fetchDraftForApprove(
  shopDomain: string,
  token: string,
  draftOrderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; draft: DraftForApprove | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, DRAFT_BEFORE_APPROVE_QUERY, { id: draftOrderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const node = result.data.draftOrder;
  if (!isRecord(node)) {
    return { kind: "ok", draft: null };
  }
  const link = draftLinkOf(node);
  const money =
    isRecord(node.totalPriceSet) && isRecord(node.totalPriceSet.shopMoney) ? node.totalPriceSet.shopMoney : {};
  const amount = money.amount;
  return {
    kind: "ok",
    draft: {
      name: typeof node.name === "string" ? node.name : "",
      status: typeof node.status === "string" ? node.status : "",
      ready: node.ready === true,
      completedAt: typeof node.completedAt === "string" ? node.completedAt : null,
      orderId: link?.kind === "completed" ? link.orderId : null,
      orderName: link?.kind === "completed" ? link.orderName : null,
      total: typeof amount === "string" ? amount : typeof amount === "number" && Number.isFinite(amount) ? String(amount) : null,
      currency: typeof money.currencyCode === "string" ? money.currencyCode : "USD",
    },
  };
}

// Completing a $0 draft with no other argument is what Mark as paid does:
// no payment gateway, no source name, and paymentPending (deprecated) left
// at its default false. The response carries the completed draft in the
// sync's own selection.
export const APPROVE_DRAFT_MUTATION = `mutation ApproveDraft($id: ID!) {
  draftOrderComplete(id: $id) {
    draftOrder {${DRAFT_FIELDS}
    }
    userErrors { field message }
  }
}`;

// Completes the draft in Shopify. Variables are exactly { id }. userErrors
// come back as refused, in Shopify's words. node: the completed draft (null
// when Shopify sent none).
export async function completeDraft(
  shopDomain: string,
  token: string,
  draftOrderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, APPROVE_DRAFT_MUTATION, { id: draftOrderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const payload = result.data.draftOrderComplete;
  const refused = userErrorsOf(payload);
  if (refused) {
    return { kind: "refused", detail: refused };
  }
  const node = isRecord(payload) && isRecord(payload.draftOrder) ? payload.draftOrder : null;
  return { kind: "ok", node };
}

// ---------------------------------------------------------------------------
// Edit a request (comprehensive design section 2)

// Reading a line's variant id needs read_products (or write_products).
export function productsEnabled(granted: readonly string[] | null | undefined): boolean {
  return Array.isArray(granted) && (granted.includes("read_products") || granted.includes("write_products"));
}

// Read fresh before an edit and after a timeout: every line with its uuid,
// variant and custom attributes exactly as Shopify has them (the stored
// snapshot caps attribute values, so it is never the source of a save),
// what would make a line impossible to keep exactly, the purchasing
// company, contact and location, the recipient's name, and updatedAt (the
// edit's concurrency token). 310 points by the client.test.ts estimator.
export const DRAFT_FOR_EDIT_QUERY = `query DraftForEdit($id: ID!) {
  draftOrder(id: $id) {
    id
    name
    status
    updatedAt
    purchasingEntity {
      __typename
      ... on PurchasingCompany { company { id } contact { id } location { id name } }
    }
    shippingAddress { firstName lastName }
    lineItems(first: ${EDIT_LINES_MAX}) {
      nodes {
        uuid
        custom
        quantity
        title
        sku
        variantTitle
        variant { id }
        customAttributes { key value }
        appliedDiscount { title }
        priceOverride { amount }
        components { uuid }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

export type DraftForEditLine = {
  uuid: string;
  // The ProductVariant gid, or null (a custom line, or a deleted variant).
  variantId: string | null;
  quantity: number;
  title: string;
  variantTitle: string;
  sku: string;
  custom: boolean;
  // Exactly as Shopify sent them; a null value reads as "".
  attributes: { key: string; value: string }[];
  // The line carries its own discount or a price override.
  priced: boolean;
  // The line is a bundle with components.
  bundle: boolean;
};

export type DraftForEdit = {
  name: string;
  // Shopify's own value: OPEN, INVOICE_SENT or COMPLETED.
  status: string;
  updatedAt: string;
  // Null for a customer's own (D2C) draft. Gids for the update, legacy ids
  // for the locations table.
  company: {
    companyGid: string;
    companyId: string;
    contactGid: string | null;
    locationGid: string;
    locationId: string;
    locationName: string;
  } | null;
  recipient: { firstName: string; lastName: string } | null;
  lines: DraftForEditLine[];
  // Shopify said there are no more lines than the ones read.
  complete: boolean;
};

const COMPANY_GID = /^gid:\/\/shopify\/Company\/([1-9]\d{0,19})$/;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function draftForEditOf(node: Record<string, unknown>): DraftForEdit {
  const entity = isRecord(node.purchasingEntity) ? node.purchasingEntity : null;
  const companyNode = entity && isRecord(entity.company) ? entity.company : null;
  const contactNode = entity && isRecord(entity.contact) ? entity.contact : null;
  const locationNode = entity && isRecord(entity.location) ? entity.location : null;
  const companyGid = text(companyNode?.id);
  const locationGid = text(locationNode?.id);
  const companyId = companyGid.match(COMPANY_GID)?.[1] ?? null;
  const locationId = companyLocationIdOf(locationGid);
  const shipping = isRecord(node.shippingAddress) ? node.shippingAddress : null;
  const connection = isRecord(node.lineItems) ? node.lineItems : {};
  const nodes = Array.isArray(connection.nodes) ? connection.nodes.filter(isRecord) : [];
  const pageInfo = isRecord(connection.pageInfo) ? connection.pageInfo : {};
  return {
    name: text(node.name),
    status: text(node.status),
    updatedAt: text(node.updatedAt),
    company:
      companyId && locationId
        ? {
            companyGid,
            companyId,
            contactGid: typeof contactNode?.id === "string" ? contactNode.id : null,
            locationGid,
            locationId,
            locationName: text(locationNode?.name),
          }
        : null,
    recipient: shipping ? { firstName: text(shipping.firstName), lastName: text(shipping.lastName) } : null,
    lines: nodes
      .filter((line) => typeof line.uuid === "string" && line.uuid.length > 0)
      .map((line) => ({
        uuid: line.uuid as string,
        variantId: isRecord(line.variant) && typeof line.variant.id === "string" ? line.variant.id : null,
        quantity: typeof line.quantity === "number" && Number.isInteger(line.quantity) ? line.quantity : 1,
        title: text(line.title),
        variantTitle: text(line.variantTitle),
        sku: text(line.sku),
        custom: line.custom === true,
        attributes: Array.isArray(line.customAttributes)
          ? line.customAttributes
              .filter(isRecord)
              .filter((attribute) => typeof attribute.key === "string")
              .map((attribute) => ({ key: attribute.key as string, value: text(attribute.value) }))
          : [],
        priced: isRecord(line.appliedDiscount) || isRecord(line.priceOverride),
        bundle: Array.isArray(line.components) && line.components.length > 0,
      })),
    complete: pageInfo.hasNextPage === false,
  };
}

// The draft as Shopify has it now, or null when it no longer exists.
export async function fetchDraftForEdit(
  shopDomain: string,
  token: string,
  draftOrderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; draft: DraftForEdit | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, DRAFT_FOR_EDIT_QUERY, { id: draftOrderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  return { kind: "ok", draft: isRecord(result.data.draftOrder) ? draftForEditOf(result.data.draftOrder) : null };
}

// draftOrderUpdate with the input the edit service builds (the full line
// list, the purchasing entity, and a shipping address only for a new
// location; never tags, note or cart attributes). The response carries the
// draft in the sync's own selection, so the card is written at once.
export const EDIT_DRAFT_MUTATION = `mutation EditDraft($id: ID!, $input: DraftOrderInput!) {
  draftOrderUpdate(id: $id, input: $input) {
    draftOrder {${DRAFT_FIELDS}
    }
    userErrors { field message }
  }
}`;

export async function updateDraftOrder(
  shopDomain: string,
  token: string,
  draftOrderGid: string,
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, EDIT_DRAFT_MUTATION, { id: draftOrderGid, input }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const payload = result.data.draftOrderUpdate;
  const refused = userErrorsOf(payload);
  if (refused) {
    return { kind: "refused", detail: refused };
  }
  return { kind: "ok", node: isRecord(payload) && isRecord(payload.draftOrder) ? payload.draftOrder : null };
}

// ---------------------------------------------------------------------------
// Every line item of one order (a purchase order prefill): the sync stores
// only the first 35 and marks the rest as missing (itemsTruncated). 100 a
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

// Either kind (draft orders spec section 3.5): tagsAdd and tagsRemove take
// a DraftOrder id unchanged. Never draftOrderUpdate for tags (it replaces
// every tag, and updating a draft with a started checkout unlinks it).
export const STATUS_TAGS_QUERY = `query StatusTags($id: ID!) {
  node(id: $id) {
    ... on Order { id tags }
    ... on DraftOrder { id tags }
  }
}`;
const TAGS_REMOVE = `mutation StatusTagRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
}`;
const TAGS_ADD = `mutation StatusTagAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

// The current tags of an order or a draft order (by its gid), or null when
// Shopify has no such object.
export async function fetchStatusTags(
  shopDomain: string,
  token: string,
  gid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; tags: string[] | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, STATUS_TAGS_QUERY, { id: gid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const node = result.data.node;
  if (!isRecord(node) || typeof node.id !== "string") {
    return { kind: "ok", tags: null };
  }
  return {
    kind: "ok",
    tags: Array.isArray(node.tags) ? node.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

// The gid may name an Order or a DraftOrder.
async function tagMutation(
  document: string,
  field: "tagsAdd" | "tagsRemove",
  shopDomain: string,
  token: string,
  gid: string,
  tags: string[],
  fetchImpl: typeof fetch,
): Promise<{ kind: "ok" } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, document, { id: gid, tags }, fetchImpl);
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

// ---------------------------------------------------------------------------
// Cancel an order (comprehensive design section 2)

// Read right before a cancel and after a timeout: whether Shopify cancelled
// it already, how it is fulfilled, and its total (Ordering Desk cancels only
// $0 orders, because it never refunds).
export const ORDER_CANCEL_STATE_QUERY = `query OrderCancelState($id: ID!) {
  order(id: $id) {
    id
    name
    cancelledAt
    displayFulfillmentStatus
    currentTotalPriceSet { shopMoney { amount currencyCode } }
  }
}`;

export type OrderCancelState = {
  name: string;
  // Shopify's ISO time, or null while the order is not cancelled.
  cancelledAt: string | null;
  // Shopify's own value, for example UNFULFILLED or FULFILLED.
  fulfillment: string;
  total: string | null;
  currency: string;
};

export async function fetchOrderCancelState(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; order: OrderCancelState | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, ORDER_CANCEL_STATE_QUERY, { id: orderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const node = result.data.order;
  if (!isRecord(node)) {
    return { kind: "ok", order: null };
  }
  const money =
    isRecord(node.currentTotalPriceSet) && isRecord(node.currentTotalPriceSet.shopMoney) ? node.currentTotalPriceSet.shopMoney : {};
  const amount = money.amount;
  return {
    kind: "ok",
    order: {
      name: typeof node.name === "string" ? node.name : "",
      cancelledAt: typeof node.cancelledAt === "string" && node.cancelledAt.length > 0 ? node.cancelledAt : null,
      fulfillment: typeof node.displayFulfillmentStatus === "string" ? node.displayFulfillmentStatus : "",
      total: typeof amount === "string" ? amount : typeof amount === "number" && Number.isFinite(amount) ? String(amount) : null,
      currency: typeof money.currencyCode === "string" ? money.currencyCode : "USD",
    },
  };
}

// 2026-10: orderCancel(orderId, reason, restock, notifyCustomer,
// refundMethod, staffNote). refundMethod is left out, which refunds nothing
// (Shopify voids an authorization either way; every IMPACT order is $0).
// The deprecated refund argument and userErrors field are not used. Shopify
// cancels in a background job: an accepted cancel returns the job, and the
// order shows cancelledAt once the job is done.
export const CANCEL_ORDER_MUTATION = `mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String) {
  orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
    job { id done }
    orderCancelUserErrors { field message code }
  }
}`;

// Shopify's limit for a cancellation's staff note, counted in characters
// (code points), so the cut never splits a surrogate pair.
export const STAFF_NOTE_MAX = 255;

// Sends the cancel once. The customer is never emailed, nothing is
// restocked and nothing is refunded. Refusals come back as refused, in
// Shopify's words.
export async function cancelOrderInShopify(
  shopDomain: string,
  token: string,
  orderGid: string,
  staffNote: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; jobId: string | null; done: boolean } | AdminFailure> {
  const result = await shopifyGraphql(
    shopDomain,
    token,
    CANCEL_ORDER_MUTATION,
    {
      orderId: orderGid,
      reason: "OTHER",
      restock: false,
      notifyCustomer: false,
      staffNote: Array.from(staffNote).slice(0, STAFF_NOTE_MAX).join(""),
    },
    fetchImpl,
  );
  if (result.kind !== "ok") {
    return failed(result);
  }
  const payload = isRecord(result.data.orderCancel) ? result.data.orderCancel : {};
  const refused = userErrorsOf({ userErrors: payload.orderCancelUserErrors });
  if (refused) {
    return { kind: "refused", detail: refused };
  }
  const job = isRecord(payload.job) ? payload.job : null;
  return { kind: "ok", jobId: typeof job?.id === "string" ? job.id : null, done: job?.done === true };
}
