import { describe, it, expect } from "vitest";
import { DRAFT_FOR_EDIT_QUERY, EDIT_DRAFT_MUTATION, fetchDraftForEdit, productsEnabled, updateDraftOrder } from "./admin";

// Editing a request (comprehensive design section 2): the fresh read and
// draftOrderUpdate, against a stubbed fetch.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_edit_docs_token_never_leak";
const DRAFT = "gid://shopify/DraftOrder/12";
const LONG = "x".repeat(2500);

type Call = { query: string; variables: Record<string, unknown> };

function stub(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const editNode = {
  id: DRAFT,
  name: "#D12",
  status: "OPEN",
  updatedAt: "2026-10-06T14:00:00Z",
  purchasingEntity: {
    __typename: "PurchasingCompany",
    company: { id: "gid://shopify/Company/7" },
    contact: { id: "gid://shopify/CompanyContact/31" },
    location: { id: "gid://shopify/CompanyLocation/101", name: "Buford HQ" },
  },
  shippingAddress: { firstName: "Casey", lastName: "Lin" },
  lineItems: {
    nodes: [
      {
        uuid: "u-1",
        custom: false,
        quantity: 2,
        title: "Hard Hat",
        sku: "HH-1",
        variantTitle: "White",
        variant: { id: "gid://shopify/ProductVariant/501" },
        customAttributes: [
          { key: "Full Name", value: "Casey Lin" },
          { key: "Office Address", value: "100 Example Way\r\nBuford, GA 30518" },
          { key: "Notes", value: LONG },
          { key: "Empty", value: null },
        ],
        appliedDiscount: null,
        priceOverride: null,
        components: [],
      },
      {
        uuid: "u-2",
        custom: true,
        quantity: 1,
        title: "Custom banner",
        sku: null,
        variantTitle: null,
        variant: null,
        customAttributes: [],
        appliedDiscount: { title: "Staff" },
        priceOverride: null,
        components: [{ uuid: "c-1" }],
      },
    ],
    pageInfo: { hasNextPage: false },
  },
};

describe("fetchDraftForEdit", () => {
  it("reads every line with its uuid, variant and attributes exactly, and the company location", async () => {
    const { impl, calls } = stub(() => ({ data: { draftOrder: editNode } }));
    expect(await fetchDraftForEdit(DOMAIN, TOKEN, DRAFT, impl)).toEqual({
      kind: "ok",
      draft: {
        name: "#D12",
        status: "OPEN",
        updatedAt: "2026-10-06T14:00:00Z",
        company: {
          companyGid: "gid://shopify/Company/7",
          companyId: "7",
          contactGid: "gid://shopify/CompanyContact/31",
          locationGid: "gid://shopify/CompanyLocation/101",
          locationId: "101",
          locationName: "Buford HQ",
        },
        recipient: { firstName: "Casey", lastName: "Lin" },
        lines: [
          {
            uuid: "u-1",
            variantId: "gid://shopify/ProductVariant/501",
            quantity: 2,
            title: "Hard Hat",
            variantTitle: "White",
            sku: "HH-1",
            custom: false,
            // Never capped or trimmed: a save sends these back exactly.
            attributes: [
              { key: "Full Name", value: "Casey Lin" },
              { key: "Office Address", value: "100 Example Way\r\nBuford, GA 30518" },
              { key: "Notes", value: LONG },
              { key: "Empty", value: "" },
            ],
            priced: false,
            bundle: false,
          },
          {
            uuid: "u-2",
            variantId: null,
            quantity: 1,
            title: "Custom banner",
            variantTitle: "",
            sku: "",
            custom: true,
            attributes: [],
            priced: true,
            bundle: true,
          },
        ],
        complete: true,
      },
    });
    expect(calls[0].query).toBe(DRAFT_FOR_EDIT_QUERY);
    expect(calls[0].variables).toEqual({ id: DRAFT });
  });

  it("reads a customer's own draft without a company, and null when Shopify has none", async () => {
    const plain = stub(() => ({
      data: { draftOrder: { ...editNode, purchasingEntity: { __typename: "Customer" }, lineItems: { nodes: [], pageInfo: { hasNextPage: true } } } },
    }));
    expect(await fetchDraftForEdit(DOMAIN, TOKEN, DRAFT, plain.impl)).toMatchObject({
      kind: "ok",
      draft: { company: null, lines: [], complete: false },
    });
    const gone = stub(() => ({ data: { draftOrder: null } }));
    expect(await fetchDraftForEdit(DOMAIN, TOKEN, DRAFT, gone.impl)).toEqual({ kind: "ok", draft: null });
  });
});

describe("updateDraftOrder", () => {
  it("sends the id and the input exactly, and returns the updated draft", async () => {
    const input = { lineItems: [{ uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 1, customAttributes: [] }] };
    const { impl, calls } = stub(() => ({ data: { draftOrderUpdate: { draftOrder: { id: DRAFT, name: "#D12" }, userErrors: [] } } }));
    expect(await updateDraftOrder(DOMAIN, TOKEN, DRAFT, input, impl)).toEqual({ kind: "ok", node: { id: DRAFT, name: "#D12" } });
    expect(calls[0].query).toBe(EDIT_DRAFT_MUTATION);
    expect(calls[0].variables).toEqual({ id: DRAFT, input });
  });

  it("answers Shopify's refusal in its own words", async () => {
    const { impl } = stub(() => ({
      data: { draftOrderUpdate: { draftOrder: null, userErrors: [{ field: ["lineItems"], message: "Quantity is invalid" }] } },
    }));
    expect(await updateDraftOrder(DOMAIN, TOKEN, DRAFT, { lineItems: [] }, impl)).toEqual({ kind: "refused", detail: "Quantity is invalid" });
  });
});

describe("productsEnabled", () => {
  it("needs read_products or write_products to read variant ids", () => {
    expect(productsEnabled(["read_products"])).toBe(true);
    expect(productsEnabled(["write_products"])).toBe(true);
    expect(productsEnabled(["write_draft_orders"])).toBe(false);
    expect(productsEnabled(null)).toBe(false);
  });
});
