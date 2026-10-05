import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SHOPIFY_API_VERSION,
  fetchOrdersUpdatedSince,
  mintAccessToken,
  resetServedVersionNotice,
  shopifyGraphql,
  testShopConnection,
} from "./client";

// The client credentials grant (platform amendment section 3) and the
// generic Admin GraphQL request the Shopify stage builds on. Stubbed fetch
// only: nothing here reaches Shopify.

const DOMAIN = "impact-rentals.myshopify.com";
const CLIENT_ID = "client-id-4f1e";
const CLIENT_SECRET = "shpss_client_secret_never_leak_77ab";
const MINTED = "shpat_minted_access_token_never_leak_19c2";
const TOKEN = "shpat_graphql_token_never_leak_5d0e";

type Call = { url: string; init: RequestInit };

function stub(script: Array<Response | Error | (() => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const minted = (overrides: Record<string, unknown> = {}) =>
  json({
    access_token: MINTED,
    scope: "read_orders,write_orders,read_customers",
    expires_in: 86399,
    ...overrides,
  });

function detailOf(result: { kind: string }): string {
  return "detail" in result ? String((result as { detail: unknown }).detail) : "";
}

describe("mintAccessToken", () => {
  it("posts the form-encoded client credentials grant with the usual protections", async () => {
    const { impl, calls } = stub([minted()]);
    const result = await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl);
    expect(result).toEqual({
      kind: "ok",
      accessToken: MINTED,
      scopes: ["read_orders", "write_orders", "read_customers"],
      expiresInSeconds: 86399,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://${DOMAIN}/admin/oauth/access_token`);
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    // A redirect would re-send the secret to whatever host it names.
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a host outside the myshopify.com allowlist before any request", async () => {
    for (const domain of ["evil.example.com", "impact.myshopify.com.evil.io", "IMPACT.myshopify.com", ""]) {
      const { impl, calls } = stub([]);
      expect(await mintAccessToken(domain, CLIENT_ID, CLIENT_SECRET, impl)).toEqual({
        kind: "fatal",
        detail: "invalid shop domain",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("reads a refusal as rejected, in Shopify's words", async () => {
    for (const status of [400, 401, 403]) {
      const { impl } = stub([
        json(
          {
            error: "shop_not_permitted",
            error_description: "Client credentials cannot be performed on this shop.",
          },
          status,
        ),
      ]);
      const result = await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl);
      expect(result.kind, String(status)).toBe("rejected");
      expect(detailOf(result)).toContain("shop_not_permitted");
      expect(detailOf(result)).toContain("Client credentials cannot be performed on this shop.");
    }
    // No JSON body at all still reads as a refusal with a plain detail.
    const { impl } = stub([new Response("nope", { status: 401 })]);
    const bare = await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl);
    expect(bare).toEqual({ kind: "rejected", detail: "Shopify responded with HTTP 401" });
  });

  it("answers a 404 as no store at this address", async () => {
    const { impl } = stub([json({ errors: "Not Found" }, 404)]);
    expect(await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl)).toEqual({ kind: "no-store" });
  });

  it("treats throttles, server errors, redirects, timeouts and network failures as transient", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const failures: Array<Response | Error> = [
      json({}, 429),
      json({}, 503),
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      timeout,
      new Error("getaddrinfo ENOTFOUND"),
    ];
    for (const failure of failures) {
      const { impl } = stub([failure]);
      const result = await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl);
      expect(result.kind, String(failure)).toBe("transient");
      expect(detailOf(result).length).toBeGreaterThan(0);
    }
  });

  it("treats a malformed token response as transient", async () => {
    const bodies = [
      minted({ access_token: "" }),
      minted({ access_token: 42 }),
      minted({ expires_in: "soon" }),
      minted({ expires_in: 0 }),
      minted({ expires_in: -5 }),
      new Response("<html>gateway</html>", { status: 200 }),
      json(["not", "an", "object"]),
    ];
    for (const body of bodies) {
      const { impl } = stub([body]);
      expect((await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl)).kind).toBe("transient");
    }
  });

  it("accepts a missing scope readback as no scopes", async () => {
    const { impl } = stub([minted({ scope: undefined })]);
    expect(await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl)).toMatchObject({
      kind: "ok",
      scopes: [],
    });
  });

  it("never puts the client secret or the minted token into a detail", async () => {
    const echoes: Array<Response | Error> = [
      json({ error: "invalid_client", error_description: `bad secret ${CLIENT_SECRET}` }, 400),
      new Error(`connect failed with ${CLIENT_SECRET}`),
      json({ access_token: MINTED, expires_in: "x", scope: MINTED }),
    ];
    for (const echo of echoes) {
      const { impl } = stub([echo]);
      const serialized = JSON.stringify(await mintAccessToken(DOMAIN, CLIENT_ID, CLIENT_SECRET, impl));
      expect(serialized).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(MINTED);
    }
  });
});

describe("shopifyGraphql", () => {
  const QUERY = "query Probe($id: ID!) { order(id: $id) { id } }";
  const VARIABLES = { id: "gid://shopify/Order/1" };

  it("posts the document and variables with the token, never following a redirect", async () => {
    const { impl, calls } = stub([json({ data: { order: { id: "gid://shopify/Order/1" } } })]);
    const result = await shopifyGraphql(DOMAIN, TOKEN, QUERY, VARIABLES, impl);
    expect(result).toEqual({ kind: "ok", data: { order: { id: "gid://shopify/Order/1" } } });
    expect(calls[0].url).toBe(`https://${DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: QUERY, variables: VARIABLES });
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a host outside the allowlist before any request", async () => {
    const { impl, calls } = stub([]);
    expect(await shopifyGraphql("evil.example.com", TOKEN, QUERY, VARIABLES, impl)).toEqual({
      kind: "fatal",
      detail: "invalid shop domain",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps auth, throttles, server errors and garbled bodies", async () => {
    const cases: Array<[Response | Error, string]> = [
      [json({}, 401), "auth"],
      [json({}, 403), "auth"],
      [json({}, 429), "transient"],
      [json({}, 502), "transient"],
      [json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }), "transient"],
      [json({ errors: [{ message: "Field 'nope' doesn't exist on type 'Order'" }] }), "fatal"],
      [new Response("<html></html>", { status: 200 }), "transient"],
      [json({ data: null }), "transient"],
      [new Error("socket hang up"), "transient"],
    ];
    for (const [response, kind] of cases) {
      const { impl } = stub([response]);
      expect((await shopifyGraphql(DOMAIN, TOKEN, QUERY, VARIABLES, impl)).kind, String(response)).toBe(kind);
    }
  });

  it("reports a GraphQL error in Shopify's words without the token", async () => {
    const { impl } = stub([json({ errors: [{ message: `Access denied for ${TOKEN}` }] })]);
    const result = await shopifyGraphql(DOMAIN, TOKEN, QUERY, VARIABLES, impl);
    expect(result).toEqual({ kind: "fatal", detail: "Access denied for [redacted]" });
  });
});

// The pinned Admin API version and the served-version diagnostic (draft
// orders spec section 3.1): Shopify answers an unsupported version with an
// older fallback, so a mismatch is logged, once per isolate.
describe("Admin API version", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetServedVersionNotice();
  });

  const served = (version: string | null, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: version === null ? { "content-type": "application/json" } : { "content-type": "application/json", "X-Shopify-API-Version": version },
    });
  const ok = { data: { order: { id: "gid://shopify/Order/1" } } };

  it("pins 2026-10", () => {
    expect(SHOPIFY_API_VERSION).toBe("2026-10");
  });

  it("logs the version Shopify served when it differs, once per isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = stub([served("2025-10", ok), served("2025-10", ok)]);
    await shopifyGraphql(DOMAIN, TOKEN, "query { shop { name } }", {}, impl);
    await shopifyGraphql(DOMAIN, TOKEN, "query { shop { name } }", {}, impl);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[shopify] {"apiVersionServed":"2025-10"}');
  });

  it("logs nothing when Shopify serves the pinned version or sends no header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = stub([served("2026-10", ok), served(null, ok)]);
    await shopifyGraphql(DOMAIN, TOKEN, "query { shop { name } }", {}, impl);
    await shopifyGraphql(DOMAIN, TOKEN, "query { shop { name } }", {}, impl);
    expect(warn).not.toHaveBeenCalled();
  });

  it("checks the served version on the sync's pages and the connection test too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = { data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, "2026-09-01T00:00:00.000Z", stub([served("2026-01", page)]).impl);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('[shopify] {"apiVersionServed":"2026-01"}');
    resetServedVersionNotice();
    const shop = { data: { shop: { name: "Impact" }, currentAppInstallation: { accessScopes: [] } } };
    await testShopConnection(DOMAIN, TOKEN, stub([served("2025-10", shop)]).impl);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe('[shopify] {"apiVersionServed":"2025-10"}');
  });
});
