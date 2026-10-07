import { describe, it, expect } from "vitest";
import {
  DRAFTS_PER_PAGE,
  FIRST_DRAFT_SEARCH,
  FULFILLMENTS_PER_ORDER,
  LINE_ITEMS,
  MAX_DRAFT_PAGES,
  fetchDraftsUpdatedSince,
  fetchOrderHistory,
  fetchOrdersUpdatedSince,
  MAX_PAGES,
  ORDER_FIELDS,
  ORDERS_PER_PAGE,
  orderFieldsFor,
  SHOPIFY_API_VERSION,
} from "./client";
import {
  APPROVE_DRAFT_MUTATION,
  CANCEL_ORDER_MUTATION,
  DRAFT_BEFORE_APPROVE_QUERY,
  DRAFT_LINK_CHUNK,
  DRAFT_LINKS_QUERY,
  DRAFT_ORDER_QUERY,
  ORDER_CANCEL_STATE_QUERY,
  ORDER_LINE_ITEMS_QUERY,
  STATUS_TAGS_QUERY,
} from "./admin";
import { COMPANY_LOCATION_QUERY, COMPANY_LOCATIONS_QUERY } from "./locations";

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_super_secret_value_9f3a";
const SINCE = "2026-08-01T00:00:00.000Z";
const SEARCH = `updated_at:>='${SINCE}'`;

type RecordedCall = { url: string; init: RequestInit; body: Record<string, unknown> };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ordersPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): Response {
  return jsonResponse({ data: { orders: { nodes, pageInfo } } });
}

// Sequential stub: each call consumes the next scripted response (a Response,
// an Error to throw, or a factory). Records every call for assertions.
function stubFetch(script: Array<Response | Error | (() => Response)>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), init: init ?? {}, body: parsedBody });
    const next = script.shift();
    if (!next) {
      throw new Error("fetch stub script exhausted");
    }
    if (next instanceof Error) {
      throw next;
    }
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { impl, calls };
}

function variablesOf(call: RecordedCall): Record<string, unknown> {
  return call.body.variables as Record<string, unknown>;
}

// Requested query cost, estimated the way Shopify documents it
// (shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits): scalars and
// enums are free, an object costs 1 point, a connection costs 2 points plus
// its page size times the cost of one node, and so everything selected under
// a connection is multiplied by that page size. Shopify refuses any query
// whose requested cost is above 1,000 points before running it, whatever the
// shop's plan. No fetch stub or simulator in this repo charges for a query,
// so this estimate is the only thing standing between the page shape and
// that limit.
type QueryField = { name: string; pageSize: number | null; fields: QueryField[] };

function parseQueryFields(document: string): QueryField[] {
  const tokens = document.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|\S/g) ?? [];
  let at = 0;
  const take = (): string => {
    if (at >= tokens.length) {
      throw new Error("query document ended inside a selection set");
    }
    return tokens[at++];
  };
  const selectionSet = (): QueryField[] => {
    const fields: QueryField[] = [];
    take(); // the opening brace
    while (tokens[at] !== "}") {
      const field: QueryField = { name: take(), pageSize: null, fields: [] };
      if (tokens[at] === "(") {
        while (tokens[at] !== ")") {
          const argument = take();
          if ((argument === "first" || argument === "last") && tokens[at] === ":") {
            const size = Number(tokens[at + 1]);
            if (!Number.isInteger(size)) {
              throw new Error(`${field.name}: the page size must be a literal to be priced`);
            }
            field.pageSize = size;
          }
        }
        take(); // the closing parenthesis
      }
      if (tokens[at] === "{") {
        field.fields = selectionSet();
      }
      fields.push(field);
    }
    take(); // the closing brace
    return fields;
  };
  // Skip the operation header (name and variable definitions).
  while (at < tokens.length && tokens[at] !== "{") {
    at++;
  }
  return selectionSet();
}

function costOfField(field: QueryField): number {
  const sum = (fields: QueryField[]) =>
    fields.reduce((total, child) => total + costOfField(child), 0);
  if (field.fields.length === 0) {
    return 0;
  }
  if (field.pageSize === null) {
    return 1 + sum(field.fields);
  }
  // A list of objects with a size argument (Order.fulfillments(first: 3)) is
  // not a connection, and the documentation does not price it. Priced here
  // like a connection whose nodes are the list items, which can only
  // overstate the cost.
  if (!field.fields.some((child) => child.name === "nodes" || child.name === "edges")) {
    return 2 + field.pageSize * (1 + sum(field.fields));
  }
  let perNode = 0;
  let once = 2;
  for (const child of field.fields) {
    if (child.name === "nodes") {
      perNode += 1 + sum(child.fields);
    } else if (child.name === "edges") {
      perNode +=
        1 + sum(child.fields.flatMap((inner) => (inner.name === "node" ? inner.fields : [inner])));
    } else {
      once += costOfField(child);
    }
  }
  return once + field.pageSize * perNode;
}

function requestedQueryCost(document: string): number {
  return parseQueryFields(document).reduce((total, field) => total + costOfField(field), 0);
}

const SINGLE_QUERY_COST_LIMIT = 1000;
// The estimate is this file's reading of the documented rules, not a number
// Shopify returned, so the query has to leave a fifth of the limit unused.
const QUERY_COST_BUDGET = SINGLE_QUERY_COST_LIMIT * 0.8;

// Failures on a request after the first, which keep the pages already read
// (shared by the orders and drafts feeds).
const laterRequestFailures: Array<[string, () => Response | Error]> = [
  [
    "a THROTTLED GraphQL error",
    () => jsonResponse({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
  ],
  ["HTTP 429", () => jsonResponse({}, 429)],
  ["HTTP 503", () => jsonResponse({}, 503)],
  ["invalid JSON", () => new Response("<html>bad gateway page</html>", { status: 200 })],
  ["an unexpected response shape", () => jsonResponse({ data: {} })],
  ["a network error", () => new Error("socket hang up")],
  ["a timeout", () => new DOMException("The operation timed out", "TimeoutError")],
];

describe("fetchOrdersUpdatedSince", () => {
  it("fetches a single page of orders", async () => {
    const nodes = [
      { id: "gid://shopify/Order/1", name: "#1001", updatedAt: "2026-09-14T09:15:40Z" },
    ];
    const { impl, calls } = stubFetch([ordersPage(nodes, { hasNextPage: false, endCursor: null })]);

    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);

    expect(result).toEqual({
      kind: "ok",
      nodes,
      truncated: false,
      maxUpdatedAt: "2026-09-14T09:15:40Z",
      endCursor: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://${DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(headers["content-type"]).toBe("application/json");
    const query = String(calls[0].body.query);
    expect(query).toContain("orders(first: 5,");
    expect(query).toContain("sortKey: UPDATED_AT");
    expect(query).toContain("query: $search");
    expect(query).toContain("legacyResourceId");
    expect(query).toContain("lineItems(first: 35)");
    expect(query).toContain("fulfillments(first: 3) { displayStatus }");
    // Draft orders spec section 3.2: where the order came from, its cart
    // attributes, each line item's properties, and the current country field.
    expect(query).toContain("sourceName");
    expect(query).toContain("customAttributes { key value }");
    expect(query).toContain("countryCodeV2");
    // Comprehensive design section 2: cancellations always; the company
    // location only when the caller says the grant holds a companies scope.
    expect(query).toContain("cancelledAt");
    expect(query).not.toContain("purchasingEntity");
    expect(query).not.toMatch(/countryCode\b/);
    expect(variablesOf(calls[0]).cursor).toBeNull();
    expect(variablesOf(calls[0]).search).toBe(SEARCH);
  });

  it("asks for the purchasing entity's company location only with a companies scope", async () => {
    const { impl, calls } = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl, { companies: true });
    expect(String(calls[0].body.query)).toContain("... on PurchasingCompany { location { id } }");
    expect(orderFieldsFor(false)).not.toContain("purchasingEntity");
    expect(orderFieldsFor(true)).toBe(ORDER_FIELDS);
  });

  it("paginates, passes the cursor on the second call, and tracks the max updatedAt", async () => {
    const first = [{ id: "gid://shopify/Order/1", updatedAt: "2026-09-10T00:00:00Z" }];
    const second = [{ id: "gid://shopify/Order/2", updatedAt: "2026-09-11T00:00:00Z" }];
    const { impl, calls } = stubFetch([
      ordersPage(first, { hasNextPage: true, endCursor: "cursor-page-2" }),
      ordersPage(second, { hasNextPage: false, endCursor: null }),
    ]);

    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);

    expect(result).toEqual({
      kind: "ok",
      nodes: [...first, ...second],
      truncated: false,
      maxUpdatedAt: "2026-09-11T00:00:00Z",
      endCursor: null,
    });
    expect(calls).toHaveLength(2);
    expect(variablesOf(calls[0]).cursor).toBeNull();
    expect(variablesOf(calls[1]).cursor).toBe("cursor-page-2");
    expect(variablesOf(calls[1]).search).toBe(SEARCH);
  });

  it("reports truncation and the updatedAt watermark at the 100 page cap", async () => {
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    const script = Array.from({ length: 102 }, (_, i) =>
      ordersPage(
        [{ id: `gid://shopify/Order/${i}`, updatedAt: new Date(base + i * 60000).toISOString() }],
        { hasNextPage: true, endCursor: `cursor-${i}` },
      ),
    );
    const { impl, calls } = stubFetch(script);

    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);

    expect(calls).toHaveLength(100);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.nodes).toHaveLength(100);
      expect(result.truncated).toBe(true);
      expect(result.maxUpdatedAt).toBe(new Date(base + 99 * 60000).toISOString());
      expect(result.endCursor).toBe("cursor-99");
    }
  });

  it("keeps one run's ceiling at 500 orders", () => {
    expect(ORDERS_PER_PAGE).toBe(5);
    expect(MAX_PAGES).toBe(100);
    expect(ORDERS_PER_PAGE * MAX_PAGES).toBe(500);
  });

  it("returns a null watermark when no node carries a usable updatedAt", async () => {
    const nodes = [{ id: "gid://shopify/Order/1" }, { id: "gid://shopify/Order/2", updatedAt: 7 }];
    const { impl } = stubFetch([ordersPage(nodes, { hasNextPage: false, endCursor: null })]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result).toEqual({
      kind: "ok",
      nodes,
      truncated: false,
      maxUpdatedAt: null,
      endCursor: null,
    });
  });

  it("starts pagination from a provided cursor", async () => {
    const nodes = [{ id: "gid://shopify/Order/9", updatedAt: "2026-09-14T09:15:40Z" }];
    const { impl, calls } = stubFetch([ordersPage(nodes, { hasNextPage: false, endCursor: null })]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl, {
      startCursor: "resume-here",
    });
    expect(result.kind).toBe("ok");
    expect(variablesOf(calls[0]).cursor).toBe("resume-here");
    expect(variablesOf(calls[0]).search).toBe(SEARCH);
  });

  it("returns transient when truncated with no usable watermark (capped path)", async () => {
    const script = Array.from({ length: 102 }, (_, i) =>
      ordersPage([{ id: `gid://shopify/Order/${i}` }], {
        hasNextPage: true,
        endCursor: `cursor-${i}`,
      }),
    );
    const { impl } = stubFetch(script);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result).toEqual({
      kind: "transient",
      detail: "truncated response with no usable updatedAt watermark",
    });
  });

  it("returns transient when truncated with no usable watermark (missing cursor path)", async () => {
    const { impl } = stubFetch([
      ordersPage([{ id: "gid://shopify/Order/1" }], { hasNextPage: true, endCursor: null }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result).toEqual({
      kind: "transient",
      detail: "truncated response with no usable updatedAt watermark",
    });
  });

  // A truncated result must always say where to resume. The updatedAt of the
  // gathered nodes cannot stand in for that: a node is hydrated fresh, so its
  // updatedAt can sit far ahead of its place in the updated_at sort, and a
  // window anchored there would skip every order the run never reached.
  it("returns transient when the first request reports more pages without a cursor", async () => {
    const nodes = [{ id: "gid://shopify/Order/1", updatedAt: "2026-09-14T09:15:40Z" }];
    for (const endCursor of [null, ""]) {
      const { impl, calls } = stubFetch([ordersPage(nodes, { hasNextPage: true, endCursor })]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result).toEqual({
        kind: "transient",
        detail: "Shopify reported more pages but returned no cursor",
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("returns transient when a resumed run's first request reports more pages without a cursor", async () => {
    const nodes = [{ id: "gid://shopify/Order/9", updatedAt: "2026-09-14T09:15:40Z" }];
    const { impl, calls } = stubFetch([ordersPage(nodes, { hasNextPage: true, endCursor: null })]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl, {
      startCursor: "resume-here",
    });
    // Handing the same cursor back as progress would stall without a trace
    // if Shopify kept answering like this; a transient is retried and shown.
    expect(result).toEqual({
      kind: "transient",
      detail: "Shopify reported more pages but returned no cursor",
    });
    expect(variablesOf(calls[0]).cursor).toBe("resume-here");
  });

  it("ends the run at the cursor it last used when a later page reports more pages without one", async () => {
    const first = [{ id: "gid://shopify/Order/1", updatedAt: "2026-09-10T00:00:00Z" }];
    // The second page carries a node whose updatedAt is far ahead of its sort
    // position; it must not influence where the next tick picks up.
    const second = [{ id: "gid://shopify/Order/2", updatedAt: "2026-09-30T23:59:50Z" }];
    for (const endCursor of [null, ""]) {
      const { impl, calls } = stubFetch([
        ordersPage(first, { hasNextPage: true, endCursor: "cursor-page-2" }),
        ordersPage(second, { hasNextPage: true, endCursor }),
      ]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result).toEqual({
        kind: "ok",
        nodes: [...first, ...second],
        truncated: true,
        maxUpdatedAt: "2026-09-30T23:59:50Z",
        endCursor: "cursor-page-2",
      });
      expect(calls).toHaveLength(2);
      expect(variablesOf(calls[1]).cursor).toBe("cursor-page-2");
    }
  });

  // A run reads up to 100 small pages, so a throttle or a blip part-way is
  // the normal way for a large backlog to end a tick. Whatever was read
  // before it must survive, or the same pages are fetched and thrown away
  // again on every tick.
  for (const [label, failure] of laterRequestFailures) {
    it(`keeps the pages already read when a later request fails with ${label}`, async () => {
      const first = [{ id: "gid://shopify/Order/1", updatedAt: "2026-09-10T00:00:00Z" }];
      const second = [{ id: "gid://shopify/Order/2", updatedAt: "2026-09-11T00:00:00Z" }];
      const { impl, calls } = stubFetch([
        ordersPage(first, { hasNextPage: true, endCursor: "cursor-page-2" }),
        ordersPage(second, { hasNextPage: true, endCursor: "cursor-page-3" }),
        failure(),
      ]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result).toEqual({
        kind: "ok",
        nodes: [...first, ...second],
        truncated: true,
        maxUpdatedAt: "2026-09-11T00:00:00Z",
        endCursor: "cursor-page-3",
      });
      expect(calls).toHaveLength(3);
      expect(variablesOf(calls[2]).cursor).toBe("cursor-page-3");
    });
  }

  it("still reports a failure on the first request when resuming from a cursor", async () => {
    const { impl } = stubFetch([jsonResponse({}, 503)]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl, {
      startCursor: "resume-here",
    });
    expect(result).toEqual({ kind: "transient", detail: "Shopify responded with HTTP 503" });
  });

  it("reports an auth failure on a later request as auth, not as a truncation", async () => {
    const first = [{ id: "gid://shopify/Order/1", updatedAt: "2026-09-10T00:00:00Z" }];
    const { impl } = stubFetch([
      ordersPage(first, { hasNextPage: true, endCursor: "cursor-page-2" }),
      jsonResponse({ errors: "unauthorized" }, 401),
    ]);
    expect(await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl)).toEqual({ kind: "auth" });
  });

  it("reports a GraphQL error on a later request as fatal, not as a truncation", async () => {
    const first = [{ id: "gid://shopify/Order/1", updatedAt: "2026-09-10T00:00:00Z" }];
    const { impl } = stubFetch([
      ordersPage(first, { hasNextPage: true, endCursor: "cursor-page-2" }),
      jsonResponse({ errors: [{ message: "Invalid cursor for current pagination sort" }] }),
    ]);
    expect(await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl)).toEqual({
      kind: "fatal",
      detail: "Invalid cursor for current pagination sort",
    });
  });

  it("prices the documented example query the way Shopify reports it", () => {
    // The GraphQL Admin API reference shows requestedQueryCost 3 for this one.
    expect(requestedQueryCost("{ products(first: 1) { edges { node { title } } } }")).toBe(3);
  });

  // An order with more line items than the query asks for is stored with the
  // first page only, and Shopify's pageInfo is what lets normalize mark it.
  it("asks whether each order has line items beyond the ones it fetched", async () => {
    const { impl, calls } = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    const [orders] = parseQueryFields(String(calls[0].body.query));
    const lineItems = orders.fields
      .find((field) => field.name === "nodes")
      ?.fields.find((field) => field.name === "lineItems");
    expect(lineItems?.pageSize).toBe(LINE_ITEMS);
    expect(LINE_ITEMS).toBe(35);
    const pageInfo = lineItems?.fields.find((field) => field.name === "pageInfo");
    expect(pageInfo?.fields.map((field) => field.name)).toContain("hasNextPage");
  });

  // The delivered state lives on each fulfillment (displayStatus), not on the
  // order. A list that comes back full may have more items beyond it, which
  // normalize reads as "not confirmed delivered".
  it("asks for each order's fulfillment display statuses, three at most", async () => {
    const { impl, calls } = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    const [orders] = parseQueryFields(String(calls[0].body.query));
    const fulfillments = orders.fields
      .find((field) => field.name === "nodes")
      ?.fields.find((field) => field.name === "fulfillments");
    expect(fulfillments?.pageSize).toBe(FULFILLMENTS_PER_ORDER);
    expect(FULFILLMENTS_PER_ORDER).toBe(3);
    expect(fulfillments?.fields.map((field) => field.name)).toEqual(["displayStatus"]);
  });

  it("prices a sized list of objects at least like a connection", () => {
    expect(requestedQueryCost("{ order(id: 1) { fulfillments(first: 3) { displayStatus } } }")).toBe(
      1 + 2 + 3,
    );
  });

  it("keeps the orders query inside Shopify's single query cost limit", async () => {
    const { impl, calls } = stubFetch([
      ordersPage([], { hasNextPage: false, endCursor: null }),
      ordersPage([], { hasNextPage: false, endCursor: null }),
    ]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl, { companies: true });
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    const cost = requestedQueryCost(String(calls[0].body.query));
    // Per order: the order itself, its cart attribute list, two price sets
    // of two objects each, the customer, the shipping address, the line item
    // connection and its pageInfo make 11 points, the purchasing entity and
    // its company location (3, the company fragment priced as an object by
    // this estimator) and the fulfillment list (3 slots, priced like a
    // connection, 5) make 19, plus 4 per line item slot (the item, its
    // property list and its price set). On top come 2 for the orders
    // connection and 1 for pageInfo. 798 of the 800 budget: a new field must
    // give points back. Without a companies scope the page is 783.
    expect(cost).toBe(3 + 5 * (19 + 4 * 35));
    expect(cost).toBe(798);
    expect(cost).toBeLessThanOrEqual(QUERY_COST_BUDGET);
    expect(requestedQueryCost(String(calls[1].body.query))).toBe(783);
  });

  it("reports a query Shopify refuses as too expensive as fatal, in Shopify's own words", async () => {
    const message = "Query cost is 7953, which exceeds the single query max cost limit (1000).";
    const { impl } = stubFetch([
      jsonResponse({
        errors: [{ message, extensions: { code: "MAX_COST_EXCEEDED", cost: 7953, maxCost: 1000 } }],
      }),
    ]);
    expect(await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl)).toEqual({
      kind: "fatal",
      detail: message,
    });
  });

  it("rejects deeper malformed order containers as transient", async () => {
    const bodies = [
      { data: { orders: {} } },
      { data: { orders: { nodes: null, pageInfo: { hasNextPage: false, endCursor: null } } } },
      { data: { orders: { nodes: [], pageInfo: "corrupt" } } },
      { data: { orders: { nodes: [], pageInfo: { hasNextPage: "yes" } } } },
    ];
    for (const body of bodies) {
      const { impl } = stubFetch([jsonResponse(body)]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result).toEqual({ kind: "transient", detail: "unexpected response shape" });
    }
  });

  it("requests with manual redirect handling and a timeout signal", async () => {
    const { impl, calls } = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an aborted request to a timeout transient", async () => {
    const impl = (async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as typeof fetch;
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result).toEqual({ kind: "transient", detail: "Shopify request timed out" });
  });

  it("rejects an invalid since timestamp without ever calling fetch", async () => {
    const badSince = ["2026-08-01 00:00:00", "not-a-date", "2026-08-01T00:00:00+02:00", ""];
    for (const since of badSince) {
      const { impl, calls } = stubFetch([]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, since, impl);
      expect(result).toEqual({ kind: "fatal", detail: "invalid since timestamp" });
      expect(calls).toHaveLength(0);
    }
  });

  it("classifies 401 and 403 as auth", async () => {
    for (const status of [401, 403]) {
      const { impl } = stubFetch([jsonResponse({ errors: "unauthorized" }, status)]);
      expect(await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl)).toEqual({ kind: "auth" });
    }
  });

  it("classifies 429 and 5xx as transient with the status in the detail", async () => {
    for (const status of [429, 500, 503]) {
      const { impl } = stubFetch([jsonResponse({}, status)]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result.kind).toBe("transient");
      if (result.kind === "transient") {
        expect(result.detail).toContain(String(status));
        expect(result.detail).not.toContain(TOKEN);
      }
    }
  });

  it("classifies any other non-2xx status as transient instead of parsing it", async () => {
    for (const status of [302, 400, 404]) {
      const { impl } = stubFetch([jsonResponse({ data: { orders: { nodes: [] } } }, status)]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result.kind).toBe("transient");
      if (result.kind === "transient") {
        expect(result.detail).toContain(String(status));
      }
    }
  });

  it("classifies a 2xx body without a data.orders object as transient", async () => {
    for (const body of [{}, { data: {} }, { data: { orders: "nope" } }]) {
      const { impl } = stubFetch([jsonResponse(body)]);
      const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
      expect(result).toEqual({ kind: "transient", detail: "unexpected response shape" });
    }
  });

  it("classifies a THROTTLED GraphQL error as transient via extensions.code", async () => {
    const { impl } = stubFetch([
      jsonResponse({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("transient");
  });

  it("does not treat THROTTLED inside a message as throttling", async () => {
    const { impl } = stubFetch([
      jsonResponse({ errors: [{ message: "field THROTTLED does not exist" }] }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result).toEqual({ kind: "fatal", detail: "field THROTTLED does not exist" });
  });

  it("classifies other GraphQL errors as fatal with the first message", async () => {
    const { impl } = stubFetch([
      jsonResponse({
        errors: [
          { message: "Field 'bogus' doesn't exist on type 'Order'" },
          { message: "second error" },
        ],
      }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result).toEqual({ kind: "fatal", detail: "Field 'bogus' doesn't exist on type 'Order'" });
  });

  it("classifies a network throw as transient", async () => {
    const { impl } = stubFetch([new Error("socket hang up")]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("transient");
    if (result.kind === "transient") {
      expect(result.detail).not.toContain(TOKEN);
    }
  });

  it("classifies invalid JSON as transient", async () => {
    const { impl } = stubFetch([
      new Response("<html>bad gateway page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("transient");
  });

  it("rejects an invalid shop domain without ever calling fetch", async () => {
    const badDomains = [
      "evil.example.com",
      "impact.myshopify.com.evil.com",
      "Impact-Rentals.myshopify.com",
      "-leading-dash.myshopify.com",
      "spaces here.myshopify.com",
      "",
    ];
    for (const domain of badDomains) {
      const { impl, calls } = stubFetch([]);
      const result = await fetchOrdersUpdatedSince(domain, TOKEN, SINCE, impl);
      expect(result).toEqual({ kind: "fatal", detail: "invalid shop domain" });
      expect(calls).toHaveLength(0);
    }
  });

  it("never leaks the token into a detail string, even when the response echoes it", async () => {
    const { impl } = stubFetch([
      jsonResponse({ errors: [{ message: `rejected token ${TOKEN} for shop` }] }),
    ]);
    const result = await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(result.kind).toBe("fatal");
    if (result.kind === "fatal") {
      expect(result.detail).not.toContain(TOKEN);
      expect(result.detail).toContain("rejected token");
    }
  });
});

// The order history import (src/server/sync/backfill.ts) pages through a
// store's orders by creation date, newest first, a few pages per cron tick.
describe("fetchOrderHistory", () => {
  const UNTIL = "2026-10-03T12:00:00.000Z";

  it("asks for orders created in the range, newest first, with the sync's order fields", async () => {
    const nodes = [{ id: "gid://shopify/Order/7", updatedAt: "2026-05-01T00:00:00Z" }];
    const { impl, calls } = stubFetch([ordersPage(nodes, { hasNextPage: false, endCursor: null })]);
    const result = await fetchOrderHistory(DOMAIN, TOKEN, { sinceIso: SINCE, untilIso: UNTIL }, impl, { maxPages: 20 });
    expect(result).toEqual({ kind: "ok", nodes, truncated: false, maxUpdatedAt: "2026-05-01T00:00:00Z", endCursor: null });
    const query = String(calls[0].body.query);
    expect(query).toContain("orders(first: 5,");
    expect(query).toContain("sortKey: CREATED_AT");
    expect(query).toContain("reverse: true");
    expect(query).toContain("lineItems(first: 35)");
    expect(query).toContain("fulfillments(first: 3) { displayStatus }");
    expect(variablesOf(calls[0])).toEqual({
      cursor: null,
      search: `created_at:>='${SINCE}' created_at:<'${UNTIL}'`,
    });
  });

  it("asks for every order created before the end of the range when there is no start", async () => {
    const { impl, calls } = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrderHistory(DOMAIN, TOKEN, { sinceIso: null, untilIso: UNTIL }, impl, { maxPages: 20 });
    expect(variablesOf(calls[0]).search).toBe(`created_at:<'${UNTIL}'`);
  });

  it("resumes from a cursor and stops after the page budget with the cursor to resume from", async () => {
    const script = Array.from({ length: 5 }, (_, i) =>
      ordersPage([{ id: `gid://shopify/Order/${i}`, updatedAt: "2026-05-01T00:00:00Z" }], {
        hasNextPage: true,
        endCursor: `history-${i}`,
      }),
    );
    const { impl, calls } = stubFetch(script);
    const result = await fetchOrderHistory(DOMAIN, TOKEN, { sinceIso: null, untilIso: UNTIL }, impl, {
      startCursor: "history-start",
      maxPages: 3,
    });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => variablesOf(call).cursor)).toEqual(["history-start", "history-0", "history-1"]);
    expect(result).toMatchObject({ kind: "ok", truncated: true, endCursor: "history-2" });
  });

  it("rejects a malformed range without ever calling fetch", async () => {
    for (const range of [
      { sinceIso: "2026-08-01", untilIso: UNTIL },
      { sinceIso: null, untilIso: "yesterday" },
      { sinceIso: "2026-08-01T00:00:00Z' OR id:>0 '", untilIso: UNTIL },
    ]) {
      const { impl, calls } = stubFetch([]);
      const result = await fetchOrderHistory(DOMAIN, TOKEN, range, impl, { maxPages: 20 });
      expect(result.kind).toBe("fatal");
      expect(calls).toHaveLength(0);
    }
  });

  it("costs exactly what the sync's orders query costs", async () => {
    const history = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrderHistory(DOMAIN, TOKEN, { sinceIso: null, untilIso: UNTIL }, history.impl, { maxPages: 20 });
    const sync = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, sync.impl);
    const cost = requestedQueryCost(String(history.calls[0].body.query));
    expect(cost).toBe(requestedQueryCost(String(sync.calls[0].body.query)));
    expect(cost).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });
});

// The purchase order prefill's full line item query (src/server/shopify/
// admin.ts fetchAllLineItems) under the same estimate and budget.
describe("ORDER_LINE_ITEMS_QUERY", () => {
  it("stays within the query cost budget", () => {
    const cost = requestedQueryCost(ORDER_LINE_ITEMS_QUERY);
    expect(cost).toBe(304);
    expect(cost).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });
});

function draftsPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): Response {
  return jsonResponse({ data: { draftOrders: { nodes, pageInfo } } });
}

// Draft orders (draft orders spec section 3.7): the same page loop as
// orders, over data.draftOrders, with its own page size and page cap.
describe("fetchDraftsUpdatedSince", () => {
  const draft = (i: number, updatedAt = `2026-09-${String(10 + (i % 18)).padStart(2, "0")}T00:00:00Z`) => ({
    id: `gid://shopify/DraftOrder/${i}`,
    updatedAt,
  });

  it("reads every open draft on the first draft sync", async () => {
    const nodes = [draft(1)];
    const { impl, calls } = stubFetch([draftsPage(nodes, { hasNextPage: false, endCursor: null })]);
    const result = await fetchDraftsUpdatedSince(DOMAIN, TOKEN, null, impl);
    expect(result).toEqual({ kind: "ok", nodes, truncated: false, maxUpdatedAt: nodes[0].updatedAt, endCursor: null });
    expect(FIRST_DRAFT_SEARCH).toBe("status:open OR status:invoice_sent");
    expect(variablesOf(calls[0])).toEqual({ cursor: null, search: FIRST_DRAFT_SEARCH });
    const query = String(calls[0].body.query);
    expect(query).toContain("draftOrders(first: 4,");
    expect(query).toContain("sortKey: UPDATED_AT");
    expect(query).toContain("query: $search");
    expect(query).toContain("lineItems(first: 35)");
    expect(query).toContain("... on PurchasingCompany { company { id name } location { id name } }");
    expect(query).toContain("countryCodeV2");
    expect(query).not.toContain("paymentTerms");
    expect(query).not.toMatch(/\bready\b/);
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("reads every draft updated in a later window, with no status filter", async () => {
    const { impl, calls } = stubFetch([draftsPage([], { hasNextPage: false, endCursor: null })]);
    await fetchDraftsUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(variablesOf(calls[0])).toEqual({ cursor: null, search: SEARCH });
  });

  it("resumes from a cursor with the search its chain belongs to", async () => {
    const { impl, calls } = stubFetch([draftsPage([draft(2)], { hasNextPage: false, endCursor: null })]);
    await fetchDraftsUpdatedSince(DOMAIN, TOKEN, null, impl, { startCursor: "resume-here" });
    expect(variablesOf(calls[0])).toEqual({ cursor: "resume-here", search: FIRST_DRAFT_SEARCH });
  });

  it("stops at 100 pages of 4 with the cursor to resume from", async () => {
    expect(DRAFTS_PER_PAGE).toBe(4);
    expect(MAX_DRAFT_PAGES).toBe(100);
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    const script = Array.from({ length: 102 }, (_, i) =>
      draftsPage([draft(i, new Date(base + i * 60000).toISOString())], { hasNextPage: true, endCursor: `d-${i}` }),
    );
    const { impl, calls } = stubFetch(script);
    const result = await fetchDraftsUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    expect(calls).toHaveLength(100);
    expect(result).toMatchObject({ kind: "ok", truncated: true, endCursor: "d-99" });
  });

  for (const [label, failure] of laterRequestFailures) {
    it(`keeps the drafts already read when a later request fails with ${label}`, async () => {
      const first = [draft(1, "2026-09-10T00:00:00Z")];
      const second = [draft(2, "2026-09-11T00:00:00Z")];
      const { impl } = stubFetch([
        draftsPage(first, { hasNextPage: true, endCursor: "d-2" }),
        draftsPage(second, { hasNextPage: true, endCursor: "d-3" }),
        failure(),
      ]);
      expect(await fetchDraftsUpdatedSince(DOMAIN, TOKEN, SINCE, impl)).toEqual({
        kind: "ok",
        nodes: [...first, ...second],
        truncated: true,
        maxUpdatedAt: "2026-09-11T00:00:00Z",
        endCursor: "d-3",
      });
    });
  }

  it("ends at the cursor it last used when a later page reports more pages without one", async () => {
    const { impl } = stubFetch([
      draftsPage([draft(1, "2026-09-10T00:00:00Z")], { hasNextPage: true, endCursor: "d-2" }),
      draftsPage([draft(2, "2026-09-30T00:00:00Z")], { hasNextPage: true, endCursor: null }),
    ]);
    expect(await fetchDraftsUpdatedSince(DOMAIN, TOKEN, SINCE, impl)).toMatchObject({
      kind: "ok",
      truncated: true,
      endCursor: "d-2",
    });
  });

  it("maps auth, fatal errors and an orders-shaped answer like the orders feed", async () => {
    expect(await fetchDraftsUpdatedSince(DOMAIN, TOKEN, SINCE, stubFetch([jsonResponse({}, 401)]).impl)).toEqual({
      kind: "auth",
    });
    const denied = jsonResponse({ errors: [{ message: `Access denied for draftOrders field. ${TOKEN}` }] });
    expect(await fetchDraftsUpdatedSince(DOMAIN, TOKEN, SINCE, stubFetch([denied]).impl)).toEqual({
      kind: "fatal",
      detail: "Access denied for draftOrders field. [redacted]",
    });
    const wrongRoot = ordersPage([], { hasNextPage: false, endCursor: null });
    expect(await fetchDraftsUpdatedSince(DOMAIN, TOKEN, SINCE, stubFetch([wrongRoot]).impl)).toEqual({
      kind: "transient",
      detail: "unexpected response shape",
    });
  });

  it("refuses a bad shop domain or since value before any request", async () => {
    const { impl, calls } = stubFetch([]);
    expect(await fetchDraftsUpdatedSince("evil.example.com", TOKEN, null, impl)).toEqual({
      kind: "fatal",
      detail: "invalid shop domain",
    });
    expect(await fetchDraftsUpdatedSince(DOMAIN, TOKEN, "2026-09-01' OR status:any '", impl)).toEqual({
      kind: "fatal",
      detail: "invalid since timestamp",
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps the drafts page inside the query cost budget", async () => {
    const { impl, calls } = stubFetch([draftsPage([], { hasNextPage: false, endCursor: null })]);
    await fetchDraftsUpdatedSince(DOMAIN, TOKEN, null, impl);
    const cost = requestedQueryCost(String(calls[0].body.query));
    // Per draft: the draft, its cart attribute list, the order it became,
    // the customer, the purchasing entity (1, plus 3 for the company
    // fragment as this estimator prices it), the shipping address, the
    // applied discount, three price sets of two objects each, the line item
    // connection and its pageInfo make 19, plus 4 per line item slot.
    expect(cost).toBe(3 + 4 * (19 + 4 * 35));
    expect(cost).toBe(639);
    expect(cost).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });
});

// The single draft, the link lookup, the tag read and the approve documents
// (src/server/shopify/admin.ts) under the same estimate and budget.
describe("draft order documents", () => {
  it("prices the single draft like one draft of the page", () => {
    expect(requestedQueryCost(DRAFT_ORDER_QUERY)).toBe(1 + 18 + 4 * 35);
    expect(requestedQueryCost(DRAFT_ORDER_QUERY)).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });

  it("keeps the approve mutation and its pre-check under budget", () => {
    // Shopify adds a base cost for a mutation; the selection is the draft
    // once more plus userErrors.
    expect(requestedQueryCost(APPROVE_DRAFT_MUTATION)).toBe(1 + (1 + 18 + 4 * 35) + 1);
    expect(requestedQueryCost(APPROVE_DRAFT_MUTATION) + 10).toBeLessThanOrEqual(QUERY_COST_BUDGET);
    expect(requestedQueryCost(DRAFT_BEFORE_APPROVE_QUERY)).toBe(1 + 1 + 2);
    expect(requestedQueryCost(STATUS_TAGS_QUERY)).toBeLessThanOrEqual(10);
  });

  it("keeps a chunk of the link lookup under budget even if Shopify prices every id", () => {
    // nodes(ids:) takes a list, not a page size, so the estimator cannot
    // multiply it. Priced here as one draft object (the draft and its order)
    // per id, which is what a list of objects costs.
    const perId = 1 + 1;
    expect(DRAFT_LINK_CHUNK).toBe(100);
    expect(DRAFT_LINK_CHUNK * perId + 1).toBeLessThanOrEqual(QUERY_COST_BUDGET);
    expect(DRAFT_LINKS_QUERY).toContain("nodes(ids: $ids)");
  });
});

// Company locations (comprehensive design section 2) under the same
// estimate and budget.
describe("company location documents", () => {
  it("prices a page of 50 locations and a single location", () => {
    // The connection (2) and pageInfo (1), plus per location the node, its
    // company and its shipping address.
    expect(requestedQueryCost(COMPANY_LOCATIONS_QUERY)).toBe(3 + 50 * 3);
    expect(requestedQueryCost(COMPANY_LOCATION_QUERY)).toBe(3);
    expect(requestedQueryCost(COMPANY_LOCATIONS_QUERY)).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });
});

describe("cancel documents", () => {
  it("prices the state read and the cancel", () => {
    // The order and its total (a price set of two objects); the mutation
    // with its job and its error list.
    expect(requestedQueryCost(ORDER_CANCEL_STATE_QUERY)).toBe(3);
    expect(requestedQueryCost(CANCEL_ORDER_MUTATION)).toBe(3);
  });
});
