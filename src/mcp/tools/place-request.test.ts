import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { seedLocation } from "@/server/desk/test-helpers";
import { CONFIRM_DETAILS_INSTRUCTION } from "../details";
import { NOW, WS, call, draftNode, fakeShop, principalFor, setupMcp, timeoutError, toolDeps } from "../test-helpers";
import { confirmPlaceRequest, findProducts, preparePlaceRequest } from "./place-request";

const ADDRESS = {
  address1: "100 Example Way",
  address2: "",
  city: "Harbor Point",
  province: "Georgia",
  provinceCode: "GA",
  zip: "30000",
  country: "United States",
  countryCode: "US",
  phone: "",
  company: "Example Rentals",
};

async function setup() {
  const db = await setupMcp();
  await seedLocation(db, WS, { shopifyLocationId: "101", name: "North Yard", companyId: "7", address: ADDRESS });
  await db.insert(schema.people).values({
    id: "p_jordan",
    workspaceId: WS,
    shopifyCustomerId: "301",
    name: "Jordan Vale",
    email: "jordan@example.com",
    companyContactId: "401",
    locationId: "101",
    firstSeenAt: NOW - 86400000,
    lastSeenAt: NOW - 1000,
  });
  return db;
}

const profiles = (companyId = "7") => ({
  customer: {
    id: "gid://shopify/Customer/301",
    companyContactProfiles: [
      {
        id: "gid://shopify/CompanyContact/401",
        company: { id: `gid://shopify/Company/${companyId}` },
        roleAssignments: { nodes: [{ companyLocation: { id: "gid://shopify/CompanyLocation/101", name: "North Yard" } }] },
      },
    ],
  },
});

const calculated = (total = "0.0") => ({
  draftOrderCalculate: {
    calculatedDraftOrder: {
      totalPriceSet: { shopMoney: { amount: total, currencyCode: "USD" } },
      lineItems: [{ title: "Business cards", quantity: 1, sku: "BC-1", variantTitle: null, originalUnitPriceSet: { shopMoney: { amount: total } } }],
    },
    userErrors: [],
  },
});

const created = (tags: string[]) => draftNode({ id: "gid://shopify/DraftOrder/40", legacyResourceId: "40", name: "#D40", tags });

const request = {
  for_person: "p_jordan",
  location: "North Yard",
  lines: [{ variant_id: "501", quantity: 1, personalization: [{ label: "Full Name", value: "Jordan Vale" }, { label: "Job Title", value: "Branch Lead" }] }],
  reason: "New hire",
};

// What prepare returns in confirm_details, and a confirm that repeats it
// after the person confirmed (owner decision 4, Oct 7).
const DETAILS = [
  { line: 1, label: "Full Name", value: "Jordan Vale" },
  { line: 1, label: "Job Title", value: "Branch Lead" },
];
const confirmed = (confirmationId: string) => ({
  confirmation_id: confirmationId,
  for_person: "Jordan Vale",
  location: "North Yard",
  details_confirmed: true,
  details: DETAILS,
});

describe("find_products", () => {
  it("lists active variants with their ids, and explains a missing products scope", async () => {
    const db = await setup();
    const shop = fakeShop({
      FindVariants: () => ({
        productVariants: {
          nodes: [
            { id: "gid://shopify/ProductVariant/501", legacyResourceId: "501", title: "Default Title", sku: "BC-1", displayName: "Business cards", product: { id: "p9", title: "Business cards", status: "ACTIVE" } },
            { id: "gid://shopify/ProductVariant/600", legacyResourceId: "600", title: "Old", sku: "X", displayName: "Old", product: { id: "p1", title: "Old item", status: "ARCHIVED" } },
          ],
        },
      }),
    });
    const { data } = await call(findProducts, { query: "business cards" }, toolDeps(db, principalFor(), { fetchImpl: shop.impl }));
    expect(data.products).toEqual([{ variant_id: "501", product: "Business cards", variant: null, sku: "BC-1" }]);
    const denied = fakeShop({ FindVariants: () => Response.json({ errors: [{ message: "Access denied for productVariants field. Required access: `read_products` access scope." }] }) });
    const refused = await call(findProducts, { query: "cards" }, toolDeps(db, principalFor(), { fetchImpl: denied.impl }));
    expect(refused.data.error.message).toContain("read_products");
  });
});

describe("placing a request through an AI app", () => {
  it("previews a $0 request for the person at the location, returns every personalization detail to confirm, and builds the exact draft it will send", async () => {
    const db = await setup();
    const shop = fakeShop({ ContactOfCustomer: () => profiles(), CalculateRequest: () => calculated() });
    const { data } = await call(preparePlaceRequest, request, toolDeps(db, principalFor(), { fetchImpl: shop.impl }));
    expect(data.preview.summary).toBe(
      "Place a request for Jordan Vale at North Yard: 1 x Business cards. Total $0.00. It ships to North Yard and waits for approval like any request.",
    );
    expect(data.warnings).toEqual([]);
    expect(data.confirm_details).toEqual({ instruction: CONFIRM_DETAILS_INSTRUCTION, details: DETAILS });
    // details_confirmed is never pre-filled: it is set only after the person confirms.
    expect(data.confirm_with).toEqual({ tool: "confirm_place_request", confirmation_id: data.confirmation_id, for_person: "Jordan Vale", location: "North Yard", details: DETAILS });
    const input = shop.calls.find((entry) => entry.op === "CalculateRequest")!.variables.input as Record<string, any>;
    expect(input.purchasingEntity).toEqual({
      purchasingCompany: { companyId: "gid://shopify/Company/7", companyContactId: "gid://shopify/CompanyContact/401", companyLocationId: "gid://shopify/CompanyLocation/101" },
    });
    expect(input.lineItems).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/501",
        quantity: 1,
        customAttributes: [
          { key: "Full Name", value: "Jordan Vale" },
          { key: "Job Title", value: "Branch Lead" },
        ],
      },
    ]);
    expect(input.customAttributes).toEqual([
      { key: "For Employee Name", value: "Jordan Vale" },
      { key: "Ship to Branch", value: "North Yard" },
      { key: "Reason for Request", value: "New hire" },
    ]);
    expect(input.shippingAddress).toMatchObject({ address1: "100 Example Way", city: "Harbor Point", countryCode: "US", firstName: "Jordan", lastName: "Vale" });
    // Exactly the AI tag and the marker: no Proof needed tag (owner decision 4).
    expect(input.tags).toEqual(["via AI", expect.stringMatching(/^od-ai-[0-9a-f]{16}$/)]);
  });

  it("returns phone, email and address details verbatim, exactly as Shopify will get them", async () => {
    const db = await setup();
    const shop = fakeShop({ ContactOfCustomer: () => profiles(), CalculateRequest: () => calculated() });
    const card = {
      ...request,
      lines: [
        {
          variant_id: "501",
          quantity: 1,
          personalization: [
            { label: "Mobile Phone", value: "+15555550123" },
            { label: "Email", value: "jordan@example.com" },
            { label: "Office Address", value: "100 Example Way,   Harbor Point" },
          ],
        },
      ],
    };
    const { data } = await call(preparePlaceRequest, card, toolDeps(db, principalFor(), { fetchImpl: shop.impl }));
    const sent = (shop.calls.find((entry) => entry.op === "CalculateRequest")!.variables.input as { lineItems: { customAttributes: { key: string; value: string }[] }[] }).lineItems[0]
      .customAttributes;
    expect(data.confirm_details.details).toEqual(sent.map((field) => ({ line: 1, label: field.key, value: field.value })));
    expect(data.confirm_details.details).toEqual([
      { line: 1, label: "Mobile Phone", value: "+15555550123" },
      { line: 1, label: "Email", value: "jordan@example.com" },
      { line: 1, label: "Office Address", value: "100 Example Way, Harbor Point" },
    ]);
  });

  it("creates the draft once on confirm, writes the card and a via AI entry, and announces it after the answer", async () => {
    const db = await setup();
    let marker = "";
    const shop = fakeShop({
      ContactOfCustomer: () => profiles(),
      CalculateRequest: (variables) => {
        marker = ((variables.input as { tags: string[] }).tags[1]);
        return calculated();
      },
      PlaceRequest: () => ({ draftOrderCreate: { draftOrder: created(["via AI", marker]), userErrors: [] } }),
    });
    const afterWork: (() => Promise<unknown>)[] = [];
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl, after: (work) => afterWork.push(work) });
    const prepared = (await call(preparePlaceRequest, request, deps)).data;
    const done = await call(confirmPlaceRequest, { ...confirmed(prepared.confirmation_id), for_person: "jordan vale" }, deps);
    expect(done.data).toMatchObject({ done: true, request: "#D40" });
    expect(done.data).not.toHaveProperty("proof_needed");
    expect(shop.ops().filter((op) => op === "PlaceRequest")).toHaveLength(1);
    const card = (await db.select().from(schema.orders).where(and(eq(schema.orders.workspaceId, WS), eq(schema.orders.shopifyDraftId, "40"))))[0];
    expect(card).toBeDefined();
    const placed = (await db.select().from(schema.events).where(and(eq(schema.events.orderId, card.id), eq(schema.events.type, "request_placed"))))[0];
    expect(placed).toMatchObject({ source: "ai", text: "Placed this request for Jordan Vale at North Yard" });
    expect(afterWork).toHaveLength(1);
  });

  // Owner decision 4 (Oct 7): the confirm carries the person's confirmation
  // and the details, bound by the action's content hash. A refusal keeps the
  // confirmation usable and sends nothing.
  it("refuses a confirm without the person's confirmation of the details, or with other details, and sends nothing", async () => {
    const db = await setup();
    const shop = fakeShop({ ContactOfCustomer: () => profiles(), CalculateRequest: () => calculated() });
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl });
    const prepared = (await call(preparePlaceRequest, request, deps)).data;
    const base = { confirmation_id: prepared.confirmation_id, for_person: "Jordan Vale", location: "North Yard" };
    const unconfirmed = await call(confirmPlaceRequest, { ...base, details: DETAILS }, deps);
    expect(unconfirmed.data.error).toMatchObject({ code: "mismatch", retryable: false });
    expect(unconfirmed.data.error.message).toContain("ask them to confirm the details are correct");
    expect((await call(confirmPlaceRequest, base, deps)).data.error).toMatchObject({ code: "mismatch" });
    const changed = await call(confirmPlaceRequest, { ...base, details_confirmed: true, details: [DETAILS[0], { ...DETAILS[1], value: "Branch Manager" }] }, deps);
    expect(changed.data.error).toMatchObject({ code: "mismatch" });
    expect(changed.data.error.message).toContain("The personalization details do not match the preview.");
    expect((await call(confirmPlaceRequest, { ...base, details_confirmed: true, details: [DETAILS[0]] }, deps)).data.error).toMatchObject({ code: "mismatch" });
    expect((await call(confirmPlaceRequest, { ...base, details_confirmed: true, details: [DETAILS[1], DETAILS[0]] }, deps)).data.error).toMatchObject({ code: "mismatch" });
    expect(shop.ops()).not.toContain("PlaceRequest");
    expect((await db.select().from(schema.aiActions))[0]).toMatchObject({ status: "pending" });
    expect(await db.select().from(schema.aiUsage).where(eq(schema.aiUsage.kind, "mcp_change"))).toEqual([]);
  });

  it("needs no details for a request without personalization", async () => {
    const db = await setup();
    let marker = "";
    const shop = fakeShop({
      ContactOfCustomer: () => profiles(),
      CalculateRequest: (variables) => {
        marker = (variables.input as { tags: string[] }).tags[1];
        return calculated();
      },
      PlaceRequest: () => ({ draftOrderCreate: { draftOrder: created(["via AI", marker]), userErrors: [] } }),
    });
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl });
    const prepared = (await call(preparePlaceRequest, { ...request, lines: [{ variant_id: "501", quantity: 2 }] }, deps)).data;
    expect(prepared).not.toHaveProperty("confirm_details");
    expect(prepared.confirm_with).toEqual({ tool: "confirm_place_request", confirmation_id: prepared.confirmation_id, for_person: "Jordan Vale", location: "North Yard" });
    const done = await call(confirmPlaceRequest, { confirmation_id: prepared.confirmation_id, for_person: "Jordan Vale", location: "North Yard" }, deps);
    expect(done.data).toMatchObject({ done: true, request: "#D40" });
  });

  it("refuses a request that would not total $0.00, and a person who is not a contact of the location's company", async () => {
    const db = await setup();
    const priced = fakeShop({ ContactOfCustomer: () => profiles(), CalculateRequest: () => calculated("25.00") });
    const refused = await call(preparePlaceRequest, request, toolDeps(db, principalFor(), { fetchImpl: priced.impl }));
    expect(refused.data.error.message).toContain("would total $25.00");
    const stranger = fakeShop({ ContactOfCustomer: () => profiles("8") });
    const other = await call(preparePlaceRequest, request, toolDeps(db, principalFor(), { fetchImpl: stranger.impl }));
    expect(other.data.error.message).toContain("is not a contact of this company in Shopify");
    expect(await db.select().from(schema.aiActions)).toEqual([]);
  });

  it("after a timeout, finds the draft by its marker instead of sending again", async () => {
    const db = await setup();
    let marker = "";
    const shop = fakeShop({
      ContactOfCustomer: () => profiles(),
      CalculateRequest: (variables) => {
        marker = (variables.input as { tags: string[] }).tags[1];
        return calculated();
      },
      PlaceRequest: () => timeoutError(),
      DraftByMarker: (variables) => {
        expect(variables).toEqual({ query: `tag:"${marker}"` });
        return { draftOrders: { nodes: [created(["via AI", marker])] } };
      },
    });
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl, sleep: async () => undefined });
    const prepared = (await call(preparePlaceRequest, request, deps)).data;
    const done = await call(confirmPlaceRequest, confirmed(prepared.confirmation_id), deps);
    expect(done.data).toMatchObject({ done: true, request: "#D40" });
    expect(shop.ops().filter((op) => op === "PlaceRequest")).toHaveLength(1);
  });

  it("keeps an unanswered request unknown, and the same confirmation only looks it up again", async () => {
    const db = await setup();
    let marker = "";
    let shopifyHasIt = false;
    const shop = fakeShop({
      ContactOfCustomer: () => profiles(),
      CalculateRequest: (variables) => {
        marker = (variables.input as { tags: string[] }).tags[1];
        return calculated();
      },
      PlaceRequest: () => timeoutError(),
      DraftByMarker: () => ({ draftOrders: { nodes: shopifyHasIt ? [created(["via AI", marker])] : [] } }),
    });
    const deps = toolDeps(db, principalFor(), { fetchImpl: shop.impl, sleep: async () => undefined });
    const prepared = (await call(preparePlaceRequest, request, deps)).data;
    const confirm = confirmed(prepared.confirmation_id);
    const unknown = await call(confirmPlaceRequest, confirm, deps);
    expect(unknown.data.error).toMatchObject({ code: "unknown_outcome", retryable: true });
    expect((await db.select().from(schema.aiActions))[0]).toMatchObject({ status: "unknown" });
    shopifyHasIt = true;
    const later = await call(confirmPlaceRequest, confirm, toolDeps(db, principalFor(), { fetchImpl: shop.impl, now: () => NOW + 60000 }));
    expect(later.data).toMatchObject({ done: true, request: "#D40" });
    expect(shop.ops().filter((op) => op === "PlaceRequest")).toHaveLength(1);
  });

  it("is for managers, and refuses links in personalization", async () => {
    const db = await setup();
    expect((await call(preparePlaceRequest, request, toolDeps(db, principalFor("staff")))).data.error).toMatchObject({ code: "forbidden" });
    const linked = { ...request, lines: [{ variant_id: "501", quantity: 1, personalization: [{ label: "Website", value: "https://evil.example.com" }] }] };
    expect((await call(preparePlaceRequest, linked, toolDeps(db))).data.error).toMatchObject({ code: "invalid_input" });
    const blank = { ...request, lines: [{ variant_id: "501", quantity: 1, personalization: [{ label: "Job Title", value: "   " }] }] };
    expect((await call(preparePlaceRequest, blank, toolDeps(db))).data.error).toMatchObject({ code: "invalid_input" });
  });

  // Decision 13: a stored name that is Shopify's email fallback is no name
  // (personLabel), so it is neither shown nor sent as "For Employee Name".
  it("refuses a person whose stored name is only an email, without showing it", async () => {
    const db = await setup();
    await db.update(schema.people).set({ name: "jordan@example.com" }).where(eq(schema.people.id, "p_jordan"));
    const shop = fakeShop({});
    const { data } = await call(preparePlaceRequest, request, toolDeps(db, principalFor(), { fetchImpl: shop.impl }));
    expect(data.error).toMatchObject({ code: "refused" });
    expect(JSON.stringify(data)).not.toContain("jordan@example.com");
    expect(shop.ops()).toEqual([]);
  });
});
