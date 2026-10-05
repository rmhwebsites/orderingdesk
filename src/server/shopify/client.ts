// Shopify Admin GraphQL client. Callers always get a typed result, never an
// exception, and the access token is never written into any detail string.

// Pinned Admin API version; bump deliberately. Shopify answers a version it
// no longer serves with the oldest one it still does (2025-07 stopped being
// served on July 16, 2026), so the pin has to move before each one lapses
// (draft orders spec section 3.1).
export const SHOPIFY_API_VERSION = "2026-10";

// Whether this isolate has logged a served version other than the pin.
let servedVersionNoticed = false;

// Logs the version Shopify actually served when its X-Shopify-API-Version
// header names another one than the pin, once per isolate: a quiet
// fallback is otherwise invisible. Only the version string is logged.
function noticeServedVersion(response: Response): void {
  if (servedVersionNoticed) {
    return;
  }
  const served = (response.headers?.get("x-shopify-api-version") ?? "").trim();
  if (served.length === 0 || served === SHOPIFY_API_VERSION) {
    return;
  }
  servedVersionNoticed = true;
  console.warn("[shopify] " + JSON.stringify({ apiVersionServed: served.slice(0, 40) }));
}

// Test-only: forget that the served version was logged.
export function resetServedVersionNotice(): void {
  servedVersionNoticed = false;
}

export type ShopifyFetchResult =
  | {
      kind: "ok";
      nodes: unknown[];
      // Every matching order from the starting point onward was gathered.
      truncated: false;
      maxUpdatedAt: string | null;
      endCursor: null;
    }
  | {
      kind: "ok";
      nodes: unknown[];
      // More matching orders exist beyond what was gathered: the run stopped
      // at the page cap, at a page that came back without a usable cursor, or
      // at a retryable failure after at least one page had been read.
      // endCursor is always the position the next tick resumes from, so a
      // truncated run never needs any other anchor.
      truncated: true;
      // The newest updatedAt among the gathered nodes. Informational only and
      // never a window anchor: nodes are hydrated fresh, so an order edited a
      // moment ago can still sit at its old place in the updated_at sort and
      // carry an updatedAt far ahead of everything the run has not reached.
      maxUpdatedAt: string;
      endCursor: string;
    }
  | { kind: "auth" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

export type FetchOrdersOptions = {
  // Resume pagination from a cursor persisted by an earlier truncated run.
  startCursor?: string;
};

export type FetchHistoryOptions = FetchOrdersOptions & {
  // Pages to read before stopping with the cursor to resume from.
  maxPages: number;
};

// Anchored allowlist for the host that receives the token. Anything else is
// rejected before fetch, so a tampered shop_domain row cannot exfiltrate the
// token to an arbitrary host.
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// The since window is interpolated into a search string, so only a strict
// UTC ISO timestamp is accepted.
const SINCE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const REQUEST_TIMEOUT_MS = 90000;

// Page shape, sized against Shopify's calculated query cost. Shopify refuses
// a query whose requested cost is above 1,000 points before running it, on
// every plan. Scalars are free, an object costs 1 point and a connection 2,
// and everything selected under a connection is multiplied by its page size.
// One order therefore costs 10 points (the order, two price sets of two
// objects each, customer, shipping address, the line item connection and its
// pageInfo), 5 for its fulfillment list (3 slots; a sized list of objects is
// not a connection and Shopify does not document its price, so client.test.ts
// prices it like one, which can only overstate it), plus 3 per line item slot
// (the item and its price set), which makes orders x line items the whole
// budget. Five orders of up to 48 line items request 3 + 5 x 159 = 798; a
// 49th slot would make it 813. client.test.ts prices the query that is
// actually sent and fails above 800, and raising any of these numbers means
// lowering another. An order with more line items keeps its first 48 and is
// stored with itemsTruncated set (from the line item pageInfo, see
// normalize.ts), so nothing built from the snapshot can mistake it for the
// whole order.
export const ORDERS_PER_PAGE = 5;
const LINE_ITEMS_PER_ORDER = 48;
// The delivered state lives on each fulfillment (displayStatus). A list that
// comes back with all 3 slots filled may continue beyond them, so normalize
// never reads such an order as delivered (see deliveredOf in normalize.ts).
export const FULFILLMENTS_PER_ORDER = 3;
// 100 pages of 5 keep one run's ceiling at 500 orders. A shop's rate bucket
// may well end a large run before that (see retryable below), which is fine:
// the cursor carries on next tick.
export const MAX_PAGES = 100;

// The order selection, shared by the page query below and the single-order
// query a webhook uses (src/server/shopify/admin.ts), so both store exactly
// the same snapshot shape through normalizeOrders.
export const ORDER_FIELDS = `
      id
      legacyResourceId
      name
      createdAt
      updatedAt
      email
      tags
      note
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { firstName lastName displayName email }
      shippingAddress { name firstName lastName address1 address2 city provinceCode zip countryCodeV2 }
      fulfillments(first: ${FULFILLMENTS_PER_ORDER}) { displayStatus }
      lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
        nodes { title quantity sku variantTitle originalUnitPriceSet { shopMoney { amount } } }
        pageInfo { hasNextPage }
      }`;

// Both the cursor and the updated_at search ride as GraphQL variables, so no
// runtime value is ever spliced into the query document itself (the page
// sizes are the module constants above).
const ORDERS_QUERY = `
query OrdersUpdatedSince($cursor: String, $search: String) {
  orders(first: ${ORDERS_PER_PAGE}, after: $cursor, sortKey: UPDATED_AT, query: $search) {
    nodes {${ORDER_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// The order history import (src/server/sync/backfill.ts): the same page
// size and order fields as the sync, so the same cost, but sorted by
// creation date, newest first. Creation dates never change, so a cursor
// held across many cron ticks keeps its place.
const ORDER_HISTORY_QUERY = `
query OrderHistory($cursor: String, $search: String) {
  orders(first: ${ORDERS_PER_PAGE}, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $search) {
    nodes {${ORDER_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Detail strings can carry text that originated outside this worker (error
// messages, response bodies). Strip the token in case anything echoes it.
function scrub(detail: string, token: string): string {
  return token.length > 0 ? detail.split(token).join("[redacted]") : detail;
}

// Shopify signals rate limiting as a GraphQL error carrying extensions.code
// THROTTLED; a message merely mentioning the word does not count.
function isThrottled(errors: unknown[]): boolean {
  return errors.some(
    (error) =>
      isRecord(error) && isRecord(error.extensions) && error.extensions.code === "THROTTLED",
  );
}

export async function fetchOrdersUpdatedSince(
  shopDomain: string,
  token: string,
  sinceIso: string,
  fetchImpl: typeof fetch = fetch,
  opts?: FetchOrdersOptions,
): Promise<ShopifyFetchResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }
  if (!SINCE_ISO.test(sinceIso)) {
    return { kind: "fatal", detail: "invalid since timestamp" };
  }
  return fetchOrderPages(shopDomain, token, ORDERS_QUERY, `updated_at:>='${sinceIso}'`, fetchImpl, {
    startCursor: opts?.startCursor,
    maxPages: MAX_PAGES,
  });
}

// One stretch of the order history import: orders created in
// [sinceIso, untilIso) (every order before untilIso when sinceIso is null),
// newest first, at most opts.maxPages pages from opts.startCursor. The same
// results, failure kinds and protections as fetchOrdersUpdatedSince; a
// truncated result's endCursor is where the next stretch resumes.
export async function fetchOrderHistory(
  shopDomain: string,
  token: string,
  range: { sinceIso: string | null; untilIso: string },
  fetchImpl: typeof fetch = fetch,
  opts: FetchHistoryOptions = { maxPages: MAX_PAGES },
): Promise<ShopifyFetchResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }
  if ((range.sinceIso !== null && !SINCE_ISO.test(range.sinceIso)) || !SINCE_ISO.test(range.untilIso)) {
    return { kind: "fatal", detail: "invalid order history range" };
  }
  const search = [
    range.sinceIso !== null ? `created_at:>='${range.sinceIso}'` : null,
    `created_at:<'${range.untilIso}'`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return fetchOrderPages(shopDomain, token, ORDER_HISTORY_QUERY, search, fetchImpl, {
    startCursor: opts.startCursor,
    maxPages: Math.max(1, Math.min(Math.trunc(opts.maxPages), MAX_PAGES)),
  });
}

// The page loop both queries share. shopDomain and the search string are
// already validated by the caller.
async function fetchOrderPages(
  shopDomain: string,
  token: string,
  query: string,
  search: string,
  fetchImpl: typeof fetch,
  opts: { startCursor?: string; maxPages: number },
): Promise<ShopifyFetchResult> {
  const url = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const nodes: unknown[] = [];
  // The cursor the next request is sent with: the caller's resume point at
  // first, then the endCursor of the last page read.
  let cursor: string | null = opts.startCursor ?? null;
  let pagesRead = 0;
  let maxUpdatedAt: string | null = null;
  let maxUpdatedAtMs = -Infinity;

  // Ends the run with more orders still to come. resumeFrom is where the
  // next tick picks up; without one the run has nothing to show that the
  // next tick could build on, so it is reported as a retryable failure.
  const truncatedAt = (resumeFrom: string | null): ShopifyFetchResult => {
    if (maxUpdatedAt === null) {
      // Every order node carries updatedAt (the query selects it). A
      // truncated run in which none parses is a malformed payload: retry the
      // window on the next tick instead of persisting a cursor past it.
      return { kind: "transient", detail: "truncated response with no usable updatedAt watermark" };
    }
    if (resumeFrom === null) {
      return { kind: "transient", detail: "Shopify reported more pages but returned no cursor" };
    }
    return { kind: "ok", nodes, truncated: true, maxUpdatedAt, endCursor: resumeFrom };
  };

  // A failure the next tick can retry (throttle, timeout, network, 5xx, a
  // garbled body). On the first request it is reported as such. Once pages
  // have been read they are kept: the run ends as a truncation at the cursor
  // the failed request was sent with, and the next tick resumes there. With
  // up to MAX_PAGES small requests per run, a throttle part-way is how a
  // large backlog normally ends a tick; throwing the pages away would fetch
  // and drop the same ones on every tick. A failure that persists shows up
  // on the next tick, where it hits the first request.
  const retryable = (detail: string): ShopifyFetchResult =>
    pagesRead > 0 && cursor !== null && maxUpdatedAt !== null
      ? truncatedAt(cursor)
      : { kind: "transient", detail };

  while (pagesRead < opts.maxPages) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables: { cursor, search } }),
        // Never follow a redirect: the default would re-send the access token
        // to whatever host the redirect names.
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
      if (name === "TimeoutError" || name === "AbortError") {
        return retryable("Shopify request timed out");
      }
      const message = e instanceof Error ? e.message : "fetch threw";
      return retryable(scrub(`network error: ${message}`, token));
    }

    noticeServedVersion(response);
    if (response.status === 401 || response.status === 403) {
      return { kind: "auth" };
    }
    // Anything else outside 2xx (429, 5xx, but also 3xx/4xx surprises) is
    // retried on the next tick rather than parsed into a false green.
    if (response.status < 200 || response.status >= 300) {
      return retryable(`Shopify responded with HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return retryable("Shopify returned invalid JSON");
    }

    const errors = isRecord(body) ? body.errors : undefined;
    if (Array.isArray(errors) && errors.length > 0) {
      if (isThrottled(errors)) {
        return retryable("Shopify throttled the request");
      }
      // Everything else is fatal and loud, including MAX_COST_EXCEEDED (the
      // query asked for more than Shopify's single query limit): the detail
      // is Shopify's own message, which names the cost and the limit.
      const first = errors[0] as { message?: unknown } | null;
      const message =
        typeof first?.message === "string" ? first.message : "Shopify returned a GraphQL error";
      return { kind: "fatal", detail: scrub(message, token) };
    }

    const orders = isRecord(body) && isRecord(body.data) ? body.data.orders : undefined;
    if (
      !isRecord(orders) ||
      !Array.isArray(orders.nodes) ||
      !isRecord(orders.pageInfo) ||
      typeof orders.pageInfo.hasNextPage !== "boolean"
    ) {
      return retryable("unexpected response shape");
    }

    for (const node of orders.nodes) {
      nodes.push(node);
      const updatedAt = isRecord(node) && typeof node.updatedAt === "string" ? node.updatedAt : "";
      const updatedAtMs = Date.parse(updatedAt);
      if (!Number.isNaN(updatedAtMs) && updatedAtMs > maxUpdatedAtMs) {
        maxUpdatedAtMs = updatedAtMs;
        maxUpdatedAt = updatedAt;
      }
    }

    const pageInfo = orders.pageInfo;
    if (pageInfo.hasNextPage !== true) {
      return { kind: "ok", nodes, truncated: false, maxUpdatedAt, endCursor: null };
    }
    if (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0) {
      // More pages exist but Shopify handed back no cursor to reach them.
      // Nothing read so far says where the unread orders begin (a node's
      // updatedAt is not its sort position), so the only safe resume point
      // is the cursor this request was sent with: the next tick asks for
      // this page again. On the first request that would be no progress at
      // all, and reporting it as progress would stall without a trace if
      // Shopify kept answering like this, so that case is a failure.
      return truncatedAt(pagesRead > 0 ? cursor : null);
    }
    cursor = pageInfo.endCursor;
    pagesRead++;
  }

  // Page cap reached with more pages remaining: the caller persists endCursor
  // and resumes this exact window next tick, so dense updatedAt clusters
  // (hundreds of orders sharing one second) cannot livelock the sync, and
  // the order history import advances a bounded stretch per tick.
  return truncatedAt(cursor);
}

// The same host allowlist the sync uses, for callers that normalize a shop
// domain before storing it (the connection settings route).
export function isValidShopDomain(domain: string): boolean {
  return SHOP_DOMAIN.test(domain);
}

export type ShopConnectionResult =
  // accessScopes: the handles of the scopes granted to the token's app.
  | { kind: "ok"; shopName: string; accessScopes: string[] }
  | { kind: "auth" }
  // HTTP 404: no store answers at this myshopify.com address.
  | { kind: "no-store" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

// An owner waits on this while saving the connection, so it gets a much
// shorter budget than the sync's page requests.
const CONNECTION_TEST_TIMEOUT_MS = 15000;

// Two objects and a short list (not a connection): nothing for the cost
// limit to multiply, and no variables.
const CONNECTION_TEST_QUERY =
  "{ shop { name } currentAppInstallation { accessScopes { handle } } }";

// Verifies a domain and token pair with a small fixed query before the token
// is stored, returning the shop name and the token's scopes. Same
// protections as fetchOrdersUpdatedSince: the host is checked against the
// allowlist before any request, redirects are never followed (they would
// re-send the token), the request has a timeout, and no detail string ever
// contains the token. Never throws.
export async function testShopConnection(
  shopDomain: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopConnectionResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: CONNECTION_TEST_QUERY }),
        redirect: "manual",
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      },
    );
  } catch (e) {
    const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "transient", detail: "Shopify request timed out" };
    }
    const message = e instanceof Error ? e.message : "fetch threw";
    return { kind: "transient", detail: scrub(`network error: ${message}`, token) };
  }

  noticeServedVersion(response);
  if (response.status === 401 || response.status === 403) {
    return { kind: "auth" };
  }
  if (response.status === 404) {
    return { kind: "no-store" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "transient", detail: `Shopify responded with HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "transient", detail: "Shopify returned invalid JSON" };
  }

  const errors = isRecord(body) ? body.errors : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    if (isThrottled(errors)) {
      return { kind: "transient", detail: "Shopify throttled the request" };
    }
    const first = errors[0] as { message?: unknown } | null;
    const message =
      typeof first?.message === "string" ? first.message : "Shopify returned a GraphQL error";
    return { kind: "fatal", detail: scrub(message, token) };
  }

  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
  const shop = data?.shop;
  const installation = data?.currentAppInstallation;
  if (
    !isRecord(shop) ||
    typeof shop.name !== "string" ||
    !isRecord(installation) ||
    !Array.isArray(installation.accessScopes)
  ) {
    return { kind: "transient", detail: "unexpected response shape" };
  }
  const accessScopes = installation.accessScopes
    .map((scope) => (isRecord(scope) && typeof scope.handle === "string" ? scope.handle : null))
    .filter((handle): handle is string => handle !== null);
  // The name goes back to the browser; scrubbed like every other string
  // that originated outside this worker.
  return { kind: "ok", shopName: scrub(shop.name, token), accessScopes };
}

// Strips every secret in the list from a detail string (see scrub).
function scrubAll(detail: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => scrub(text, secret), detail);
}

function errorName(e: unknown): unknown {
  return typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
}

export type TokenMintResult =
  | {
      kind: "ok";
      accessToken: string;
      // Shopify's readback of the scopes on the app's released version.
      scopes: string[];
      expiresInSeconds: number;
    }
  // Shopify refused the credentials (HTTP 400, 401 or 403); detail is
  // Shopify's own error code and description when it sent them.
  | { kind: "rejected"; detail: string }
  // HTTP 404: no store answers at this myshopify.com address.
  | { kind: "no-store" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

// A platform admin may be waiting on this (connecting a store), so it gets
// the short budget of the connection test.
const TOKEN_MINT_TIMEOUT_MS = 15000;
const MINT_DETAIL_MAX = 300;

// The client credentials grant (platform amendment section 3): trades a Dev
// Dashboard app's Client ID and secret for an access token that lasts about
// 24 hours. POST https://{shop}/admin/oauth/access_token, form encoded. The
// same protections as every other request here: the host must pass the
// allowlist before anything is sent, redirects are never followed (they
// would re-send the secret), the request has a timeout, and no detail
// string ever contains the secret or the minted token. Never throws.
export async function mintAccessToken(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenMintResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }
  const secrets = [clientSecret];
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  let response: Response;
  try {
    response = await fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
    });
  } catch (e) {
    const name = errorName(e);
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "transient", detail: "Shopify request timed out" };
    }
    const message = e instanceof Error ? e.message : "fetch threw";
    return { kind: "transient", detail: scrubAll(`network error: ${message}`, secrets) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isRecord(body) && typeof body.access_token === "string") {
    secrets.push(body.access_token);
  }

  if (response.status === 404) {
    return { kind: "no-store" };
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    const parts = isRecord(body)
      ? [body.error, body.error_description].filter(
          (part): part is string => typeof part === "string" && part.length > 0,
        )
      : [];
    const detail = parts.length > 0 ? parts.join(": ") : `Shopify responded with HTTP ${response.status}`;
    return { kind: "rejected", detail: scrubAll(detail, secrets).slice(0, MINT_DETAIL_MAX) };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "transient", detail: `Shopify responded with HTTP ${response.status}` };
  }
  if (!isRecord(body)) {
    return { kind: "transient", detail: "Shopify returned an unreadable token response" };
  }
  const accessToken = body.access_token;
  const expiresIn = body.expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return { kind: "transient", detail: "Shopify returned an unexpected token response" };
  }
  const scopes =
    typeof body.scope === "string"
      ? body.scope
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0)
      : [];
  return { kind: "ok", accessToken, scopes, expiresInSeconds: expiresIn };
}

export type GraphqlResult =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "auth" }
  | { kind: "transient"; detail: string }
  | { kind: "fatal"; detail: string };

// Single Admin GraphQL requests (webhook subscriptions, one order, one
// customer, tag and fulfillment writes) answer within this budget.
const GRAPHQL_TIMEOUT_MS = 20000;

// One Admin GraphQL request for the Shopify stage's operations
// (src/server/shopify/admin.ts). Every runtime value travels in variables,
// never spliced into the document. Same protections as the sync's page
// requests: allowlisted host, no redirects, a timeout, no token in any
// detail. A THROTTLED error, a non-2xx other than 401/403 and a garbled body
// are transient; any other GraphQL error is fatal in Shopify's own words.
// Mutation userErrors arrive inside data and are the caller's to read.
// Never throws.
export async function shopifyGraphql(
  shopDomain: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphqlResult> {
  if (!SHOP_DOMAIN.test(shopDomain)) {
    return { kind: "fatal", detail: "invalid shop domain" };
  }
  let response: Response;
  try {
    response = await fetchImpl(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      redirect: "manual",
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });
  } catch (e) {
    const name = errorName(e);
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "transient", detail: "Shopify request timed out" };
    }
    const message = e instanceof Error ? e.message : "fetch threw";
    return { kind: "transient", detail: scrub(`network error: ${message}`, token) };
  }
  noticeServedVersion(response);
  if (response.status === 401 || response.status === 403) {
    return { kind: "auth" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "transient", detail: `Shopify responded with HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "transient", detail: "Shopify returned invalid JSON" };
  }
  const errors = isRecord(body) ? body.errors : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    if (isThrottled(errors)) {
      return { kind: "transient", detail: "Shopify throttled the request" };
    }
    const first = errors[0] as { message?: unknown } | null;
    const message =
      typeof first?.message === "string" ? first.message : "Shopify returned a GraphQL error";
    return { kind: "fatal", detail: scrub(message, token) };
  }
  if (!isRecord(body) || !isRecord(body.data)) {
    return { kind: "transient", detail: "unexpected response shape" };
  }
  return { kind: "ok", data: body.data };
}
