import { describe, it, expect } from "vitest";
import {
  CALCULATE_REQUEST_MUTATION,
  CONTACT_PROFILES_QUERY,
  DRAFT_BY_MARKER_QUERY,
  FIND_VARIANTS_QUERY,
  PLACE_REQUEST_MUTATION,
  calculateRequest,
  createRequestDraft,
  fetchContactProfiles,
  findDraftByMarker,
  findVariants,
  markerTag,
} from "./requests";

const SHOP = "example-rentals.myshopify.com";
const TOKEN = "shpat_requests_never_leak";

function stub(answer: (variables: Record<string, unknown>) => Response) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return answer(body.variables);
  }) as typeof fetch;
  return { impl, calls };
}

describe("Shopify documents for placing a request", () => {
  it("name their operations", () => {
    expect(FIND_VARIANTS_QUERY).toContain("query FindVariants($query: String!)");
    expect(CONTACT_PROFILES_QUERY).toContain("query ContactOfCustomer($id: ID!)");
    expect(CALCULATE_REQUEST_MUTATION).toContain("mutation CalculateRequest($input: DraftOrderInput!)");
    expect(PLACE_REQUEST_MUTATION).toContain("mutation PlaceRequest($input: DraftOrderInput!)");
    expect(DRAFT_BY_MARKER_QUERY).toContain("query DraftByMarker($query: String!)");
  });

  it("find variants by words, keeping legacy ids and whether the product is active", async () => {
    const { impl, calls } = stub(() =>
      Response.json({
        data: {
          productVariants: {
            nodes: [
              { id: "gid://shopify/ProductVariant/501", legacyResourceId: "501", title: "Default Title", sku: "BC-1", displayName: "Business cards", product: { id: "gid://shopify/Product/9", title: "Business cards", status: "ACTIVE" } },
              { id: "gid://shopify/ProductVariant/502", legacyResourceId: "502", title: "L", sku: "SV-L", displayName: "Safety Vest - L", product: { id: "gid://shopify/Product/10", title: "Safety Vest", status: "DRAFT" } },
            ],
          },
        },
      }),
    );
    expect(await findVariants(SHOP, TOKEN, "business cards", impl)).toEqual({
      kind: "ok",
      variants: [
        { variantId: "501", product: "Business cards", variant: "", sku: "BC-1", active: true },
        { variantId: "502", product: "Safety Vest", variant: "L", sku: "SV-L", active: false },
      ],
    });
    expect(calls[0].variables).toEqual({ query: "business cards" });
  });

  it("read a customer's company contact profiles with their location roles", async () => {
    const { impl, calls } = stub(() =>
      Response.json({
        data: {
          customer: {
            id: "gid://shopify/Customer/301",
            companyContactProfiles: [
              { id: "gid://shopify/CompanyContact/401", company: { id: "gid://shopify/Company/7" }, roleAssignments: { nodes: [{ companyLocation: { id: "gid://shopify/CompanyLocation/101", name: "North Yard" } }] } },
            ],
          },
        },
      }),
    );
    expect(await fetchContactProfiles(SHOP, TOKEN, "301", impl)).toEqual({
      kind: "ok",
      profiles: [{ contactId: "401", companyId: "7", locationIds: ["101"] }],
    });
    expect(calls[0].variables).toEqual({ id: "gid://shopify/Customer/301" });
    const none = stub(() => Response.json({ data: { customer: null } }));
    expect(await fetchContactProfiles(SHOP, TOKEN, "999", none.impl)).toEqual({ kind: "ok", profiles: null });
  });

  it("calculate a draft without creating it, and pass userErrors back as refused", async () => {
    const input = { lineItems: [{ variantId: "gid://shopify/ProductVariant/501", quantity: 1 }] };
    const { impl, calls } = stub(() =>
      Response.json({
        data: {
          draftOrderCalculate: {
            calculatedDraftOrder: {
              totalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
              lineItems: [{ title: "Business cards", quantity: 1, sku: "BC-1", variantTitle: null, originalUnitPriceSet: { shopMoney: { amount: "0.0" } } }],
            },
            userErrors: [],
          },
        },
      }),
    );
    expect(await calculateRequest(SHOP, TOKEN, input, impl)).toEqual({
      kind: "ok",
      calculated: { total: "0.0", currency: "USD", lines: [{ title: "Business cards", variant: "", sku: "BC-1", quantity: 1, unitPrice: "0.0" }] },
    });
    expect(calls[0].variables).toEqual({ input });
    const refused = stub(() => Response.json({ data: { draftOrderCalculate: { calculatedDraftOrder: null, userErrors: [{ field: ["purchasingEntity"], message: "Contact has no role at this location" }] } } }));
    expect(await calculateRequest(SHOP, TOKEN, input, refused.impl)).toEqual({ kind: "refused", detail: "Contact has no role at this location" });
  });

  it("create the draft once and return it in the sync's selection", async () => {
    const node = { id: "gid://shopify/DraftOrder/40", name: "#D40" };
    const { impl, calls } = stub(() => Response.json({ data: { draftOrderCreate: { draftOrder: node, userErrors: [] } } }));
    expect(await createRequestDraft(SHOP, TOKEN, { tags: ["via AI"] }, impl)).toEqual({ kind: "ok", node });
    expect(calls).toHaveLength(1);
    expect(PLACE_REQUEST_MUTATION).toContain("purchasingEntity");
  });

  it("look a draft up by its marker tag, refusing anything that is not a marker", async () => {
    const marker = markerTag("0123456789abcdef");
    expect(marker).toBe("od-ai-0123456789abcdef");
    const { impl, calls } = stub(() => Response.json({ data: { draftOrders: { nodes: [{ id: "gid://shopify/DraftOrder/40" }] } } }));
    expect(await findDraftByMarker(SHOP, TOKEN, marker, impl)).toEqual({ kind: "ok", node: { id: "gid://shopify/DraftOrder/40" } });
    expect(calls[0].variables).toEqual({ query: 'tag:"od-ai-0123456789abcdef"' });
    const never = stub(() => Response.json({}));
    expect(await findDraftByMarker(SHOP, TOKEN, 'x" OR status:open', never.impl)).toMatchObject({ kind: "fatal" });
    expect(never.calls).toEqual([]);
  });
});
