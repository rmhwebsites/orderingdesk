import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { EDIT_COPY } from "@/lib/request-edit";
import { EDIT_REFUSALS, editRequest, loadRequestEditor } from "./edit-request";
import { REVIEW_COPY, REVIEW_READY_TRIES, type ReviewDeps } from "./review";
import { openTestDb, seedDraft, seedDraftStatuses, seedLocation, seedOrder, seedWorkspace } from "./test-helpers";

// Editing a request before approval (comprehensive design section 2)
// against the real migrations and a stubbed Shopify. draftOrderUpdate never
// reaches a real store.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_edit_token_never_leak";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-06T15:00:00.000Z");
const MANAGER = "u_manager";
const DRAFT_GID = "gid://shopify/DraftOrder/12";
const UPDATED = "2026-10-06T14:00:00Z";
const SCOPES = ["read_orders", "write_orders", "read_customers", "write_draft_orders", "read_products", "read_companies"];

const address = (city: string, zip: string, address1: string) => ({
  address1,
  address2: "",
  city,
  province: "Georgia",
  provinceCode: "GA",
  zip,
  country: "United States",
  countryCode: "US",
  phone: "",
  company: "Example Rentals",
});

type ShopLine = {
  uuid: string;
  variantId: string | null;
  quantity: number;
  title: string;
  variantTitle: string;
  sku: string;
  attributes: { key: string; value: string }[];
  custom?: boolean;
  priced?: boolean;
  bundle?: boolean;
};
type ShopDraft = {
  exists: boolean;
  status: string;
  updatedAt: string;
  b2b: boolean;
  contact: boolean;
  locationId: string;
  lines: ShopLine[];
  total: string;
  ready: boolean;
  more: boolean;
};
type Call = { op: string; variables: Record<string, unknown> };

const LINES: ShopLine[] = [
  {
    uuid: "u-1",
    variantId: "gid://shopify/ProductVariant/501",
    quantity: 2,
    title: "Hard Hat",
    variantTitle: "White",
    sku: "HH-1",
    attributes: [
      { key: "Full Name", value: "Casey Lin" },
      { key: "_pdf", value: "https://cdn.shopify.com/s/files/1/proof.pdf" },
      { key: "Office Address", value: "100 Example Way\r\nBuford, GA 30518" },
    ],
  },
  { uuid: "u-2", variantId: "gid://shopify/ProductVariant/502", quantity: 1, title: "Safety Vest", variantTitle: "L", sku: "SV-L", attributes: [] },
];
const NAMES: Record<string, string> = { "101": "Buford HQ", "102": "Mableton" };

// A store with draft #D12. EditDraft applies its input like Shopify would;
// totalAfterEdit and readyAfterEdit say what Shopify reports afterwards.
function fakeShop(
  initial: Partial<ShopDraft> = {},
  opts: {
    totalAfterEdit?: string;
    readyAfterEdit?: boolean;
    handle?: Partial<Record<string, (call: Call) => Response | Promise<Response>>>;
  } = {},
) {
  const state: ShopDraft = {
    exists: true,
    status: "OPEN",
    updatedAt: UPDATED,
    b2b: true,
    contact: true,
    locationId: "101",
    lines: LINES.map((line) => ({ ...line, attributes: [...line.attributes] })),
    total: "0.0",
    ready: true,
    more: false,
    ...initial,
  };
  const calls: Call[] = [];
  const location = () => ({ id: `gid://shopify/CompanyLocation/${state.locationId}`, name: NAMES[state.locationId] ?? "Elsewhere" });
  const editNode = () => ({
    id: DRAFT_GID,
    name: "#D12",
    status: state.status,
    updatedAt: state.updatedAt,
    purchasingEntity: state.b2b
      ? {
          __typename: "PurchasingCompany",
          company: { id: "gid://shopify/Company/7" },
          contact: state.contact ? { id: "gid://shopify/CompanyContact/31" } : null,
          location: location(),
        }
      : { __typename: "Customer" },
    shippingAddress: { firstName: "Casey", lastName: "Lin" },
    lineItems: {
      nodes: state.lines.map((line) => ({
        uuid: line.uuid,
        custom: line.custom ?? false,
        quantity: line.quantity,
        title: line.title,
        sku: line.sku,
        variantTitle: line.variantTitle,
        variant: line.variantId ? { id: line.variantId } : null,
        customAttributes: line.attributes,
        appliedDiscount: line.priced ? { title: "Staff" } : null,
        priceOverride: null,
        components: line.bundle ? [{ uuid: "c-1" }] : [],
      })),
      pageInfo: { hasNextPage: state.more },
    },
  });
  const fullNode = () => ({
    id: DRAFT_GID,
    legacyResourceId: "12",
    name: "#D12",
    status: state.status,
    createdAt: "2026-10-05T10:00:00Z",
    updatedAt: state.updatedAt,
    email: "jordan@example.com",
    tags: [],
    customAttributes: [],
    purchasingEntity: state.b2b
      ? { __typename: "PurchasingCompany", company: { id: "gid://shopify/Company/7", name: "Example Rentals" }, location: location() }
      : { __typename: "Customer" },
    totalPriceSet: { shopMoney: { amount: state.total, currencyCode: "USD" } },
    lineItems: {
      nodes: state.lines.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        sku: line.sku,
        variantTitle: line.variantTitle,
        custom: false,
        customAttributes: line.attributes,
        originalUnitPriceSet: { shopMoney: { amount: "0.0" } },
      })),
      pageInfo: { hasNextPage: false },
    },
  });
  const applyEdit = (input: Record<string, unknown>) => {
    const items = input.lineItems as { uuid: string; quantity: number; customAttributes: { key: string; value: string }[] }[];
    state.lines = items.map((item) => ({
      ...(state.lines.find((line) => line.uuid === item.uuid) as ShopLine),
      quantity: item.quantity,
      attributes: item.customAttributes,
    }));
    const entity = input.purchasingEntity as { purchasingCompany?: { companyLocationId: string } } | undefined;
    if (entity?.purchasingCompany) {
      state.locationId = entity.purchasingCompany.companyLocationId.split("/").pop() as string;
    }
    state.updatedAt = "2026-10-06T15:00:05Z";
    state.total = opts.totalAfterEdit ?? state.total;
    state.ready = opts.readyAfterEdit ?? true;
  };
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "unknown";
    const call = { op, variables: body.variables };
    calls.push(call);
    const custom = opts.handle?.[op];
    if (custom) {
      return custom(call);
    }
    switch (op) {
      case "DraftForEdit":
        return Response.json({ data: { draftOrder: state.exists ? editNode() : null } });
      case "EditDraft":
        applyEdit(call.variables.input as Record<string, unknown>);
        return Response.json({ data: { draftOrderUpdate: { draftOrder: fullNode(), userErrors: [] } } });
      case "DraftOrderById":
        return Response.json({ data: { draftOrder: state.exists ? fullNode() : null } });
      case "DraftBeforeApprove":
        return Response.json({
          data: {
            draftOrder: {
              id: DRAFT_GID,
              name: "#D12",
              status: state.status,
              ready: state.ready,
              completedAt: null,
              order: null,
              totalPriceSet: { shopMoney: { amount: state.total, currencyCode: "USD" } },
            },
          },
        });
      default:
        throw new Error("unexpected Shopify request: " + op);
    }
  }) as typeof fetch;
  return { impl, calls, state, applyEdit, ops: () => calls.map((call) => call.op) };
}

async function setup(opts: { scopes?: string[]; deleted?: boolean } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedDraftStatuses(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes: opts.scopes ?? SCOPES,
  });
  await seedDraft(db, WS, { id: "d1", draftId: "12", name: "#D12", draftDeletedAt: opts.deleted ? NOW - 5000 : null });
  await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ", address: address("Buford", "30518", "100 Example Way") });
  await seedLocation(db, WS, { shopifyLocationId: "102", name: "Mableton", address: address("Mableton", "30126", "5 Example Rd") });
  await seedLocation(db, WS, { shopifyLocationId: "103", name: "Other Co Yard", companyId: "8", address: address("Athens", "30601", "9 Example Ln") });
  await seedLocation(db, WS, { shopifyLocationId: "104", name: "Closed Yard", active: false, address: address("Athens", "30601", "1 Example Ct") });
  await seedLocation(db, WS, { shopifyLocationId: "105", name: "No Address" });
  return db;
}

const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const deps = (impl: typeof fetch): ReviewDeps => ({ env, fetchImpl: impl, now: () => NOW, sleep: async () => undefined });
const ctx = (role: "manager" | "staff" | "platform" = "manager", orderId = "d1") => ({ workspaceId: WS, orderId, userId: MANAGER, role });
const body = (overrides: Record<string, unknown> = {}) => ({ updatedAt: UPDATED, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102", ...overrides });

async function card(db: Db) {
  return (await db.select().from(schema.orders).where(eq(schema.orders.id, "d1")))[0];
}

function timeline(db: Db) {
  return db.select().from(schema.events).where(eq(schema.events.orderId, "d1"));
}

const timeout = (): Response => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

describe("loadRequestEditor", () => {
  it("reads the draft fresh and lists the company's active locations that have an address", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await loadRequestEditor(db, ctx(), deps(shop.impl))).toEqual({
      kind: "editor",
      editor: {
        updatedAt: UPDATED,
        lines: [
          { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 2 },
          { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
        ],
        locationId: "101",
        locationName: "Buford HQ",
        locations: [
          { shopifyLocationId: "101", name: "Buford HQ", address: "100 Example Way, Buford GA 30518, US" },
          { shopifyLocationId: "102", name: "Mableton", address: "5 Example Rd, Mableton GA 30126, US" },
        ],
      },
    });
    expect(shop.ops()).toEqual(["DraftForEdit"]);
  });

  it("is for managers, on requests Shopify still has, with the scopes it needs", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await loadRequestEditor(db, ctx("staff"), deps(shop.impl))).toEqual({ kind: "forbidden", error: EDIT_REFUSALS.forbidden });
    expect(await loadRequestEditor(db, ctx("manager", "nope"), deps(shop.impl))).toEqual({ kind: "not-found" });
    await seedOrder(db, WS, { id: "o1", name: "#1234" });
    expect(await loadRequestEditor(db, ctx("manager", "o1"), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "This request is already order #1234, so it cannot be edited.",
    });
    expect(await loadRequestEditor(await setup({ deleted: true }), ctx(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: REVIEW_COPY.deleted,
    });
    expect(await loadRequestEditor(await setup({ scopes: ["read_orders", "read_products"] }), ctx(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: REVIEW_COPY.draftsOff,
    });
    expect(await loadRequestEditor(await setup({ scopes: ["read_orders", "write_draft_orders"] }), ctx(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: EDIT_REFUSALS.products,
    });
    expect(shop.calls).toEqual([]);
  });

  it("refuses drafts it cannot keep exactly, and follows Shopify's state", async () => {
    const db = await setup();
    const cases: Array<[Partial<ShopDraft>, string]> = [
      [{ more: true }, EDIT_REFUSALS.tooMany],
      [{ lines: [{ ...LINES[0], custom: true, variantId: null }] }, EDIT_REFUSALS.custom],
      [{ lines: [{ ...LINES[0], priced: true }] }, EDIT_REFUSALS.priced],
      [{ lines: [{ ...LINES[0], bundle: true }] }, EDIT_REFUSALS.bundle],
      [{ lines: [{ ...LINES[0], variantId: null }] }, EDIT_REFUSALS.noVariant],
      [{ status: "COMPLETED" }, EDIT_REFUSALS.completed],
      [{ status: "WHATEVER" }, REVIEW_COPY.unknownState],
    ];
    for (const [initial, error] of cases) {
      expect(await loadRequestEditor(db, ctx(), deps(fakeShop(initial).impl)), error).toEqual({ kind: "refused", status: 409, error });
    }
  });

  it("marks the card deleted when Shopify no longer has the draft", async () => {
    const db = await setup();
    expect(await loadRequestEditor(db, ctx(), deps(fakeShop({ exists: false }).impl))).toMatchObject({
      kind: "refused",
      status: 409,
      error: REVIEW_COPY.deleted,
      deleted: { orderId: "d1" },
    });
    expect((await card(db)).draftDeletedAt).toBe(NOW);
  });
});

describe("editRequest", () => {
  it("sends the complete line list once, every attribute kept, with the new location and its address", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await editRequest(db, ctx(), body(), deps(shop.impl))).toMatchObject({
      kind: "edited",
      warning: null,
      event: {
        type: "draft_edited",
        text: "Edited the request: Hard Hat (White): quantity 2 to 1; Removed Safety Vest (L); Ship to Mableton instead of Buford HQ",
        actorId: MANAGER,
        source: "app",
      },
    });
    expect(shop.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftBeforeApprove"]);
    expect(shop.calls[1].variables).toEqual({
      id: DRAFT_GID,
      input: {
        lineItems: [{ uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 1, customAttributes: LINES[0].attributes }],
        purchasingEntity: {
          purchasingCompany: {
            companyId: "gid://shopify/Company/7",
            companyContactId: "gid://shopify/CompanyContact/31",
            companyLocationId: "gid://shopify/CompanyLocation/102",
          },
        },
        shippingAddress: {
          address1: "5 Example Rd",
          city: "Mableton",
          company: "Example Rentals",
          countryCode: "US",
          provinceCode: "GA",
          zip: "30126",
          firstName: "Casey",
          lastName: "Lin",
        },
      },
    });
    const row = await card(db);
    expect(row.locationId).toBe("102");
    expect((row.shopify as { items: { qty: number }[] }).items.map((item) => item.qty)).toEqual([1]);
    const entries = await timeline(db);
    expect(entries.map((event) => [event.type, event.actorId])).toEqual([["draft_edited", MANAGER]]);
    expect(entries[0].meta).toMatchObject({
      changes: ["Hard Hat (White): quantity 2 to 1", "Removed Safety Vest (L)", "Ship to Mableton instead of Buford HQ"],
    });
  });

  it("keeps the location for a quantity change, and sends only the lines for a customer's own draft", async () => {
    const db = await setup();
    const b2b = fakeShop();
    expect((await editRequest(db, ctx(), body({ locationId: null }), deps(b2b.impl))).kind).toBe("edited");
    expect(b2b.calls[1].variables.input).toEqual({
      lineItems: [{ uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 1, customAttributes: LINES[0].attributes }],
      purchasingEntity: {
        purchasingCompany: {
          companyId: "gid://shopify/Company/7",
          companyContactId: "gid://shopify/CompanyContact/31",
          companyLocationId: "gid://shopify/CompanyLocation/101",
        },
      },
    });
    const other = await setup();
    const plain = fakeShop({ b2b: false });
    const both = [
      { uuid: "u-1", quantity: 3 },
      { uuid: "u-2", quantity: 1 },
    ];
    expect((await editRequest(other, ctx(), body({ locationId: null, lines: both }), deps(plain.impl))).kind).toBe("edited");
    expect(plain.calls[1].variables.input).toEqual({
      lineItems: [
        { uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 3, customAttributes: LINES[0].attributes },
        { uuid: "u-2", variantId: "gid://shopify/ProductVariant/502", quantity: 1, customAttributes: [] },
      ],
    });
  });

  it("refuses a save when the draft changed since the editor opened, handing back the fresh editor", async () => {
    const db = await setup();
    const shop = fakeShop({ updatedAt: "2026-10-06T14:30:00Z" });
    expect(await editRequest(db, ctx(), body(), deps(shop.impl))).toMatchObject({
      kind: "refused",
      status: 409,
      error: EDIT_REFUSALS.stale,
      editor: { updatedAt: "2026-10-06T14:30:00Z" },
    });
    expect(shop.ops()).toEqual(["DraftForEdit"]);
  });

  it("refuses lines that are gone and locations the company cannot ship to", async () => {
    const db = await setup();
    const cases: Array<[Record<string, unknown>, Partial<ShopDraft>, string]> = [
      [{ lines: [{ uuid: "u-9", quantity: 1 }] }, {}, EDIT_REFUSALS.unknownLine],
      [{ locationId: "103" }, {}, EDIT_REFUSALS.location],
      [{ locationId: "104" }, {}, EDIT_REFUSALS.location],
      [{ locationId: "999" }, {}, EDIT_REFUSALS.location],
      [{ locationId: "105" }, {}, "Shopify has no shipping address for No Address. Add one to that location in Shopify, then try again."],
      [{ locationId: "102" }, { contact: false }, EDIT_REFUSALS.noContact],
      [{ locationId: "102" }, { b2b: false }, EDIT_REFUSALS.location],
    ];
    for (const [overrides, initial, error] of cases) {
      const shop = fakeShop(initial);
      expect(await editRequest(db, ctx(), body(overrides), deps(shop.impl)), error).toMatchObject({ kind: "refused", status: 409, error });
      expect(shop.ops()).toEqual(["DraftForEdit"]);
    }
  });

  it("answers unchanged when nothing changed, sending nothing", async () => {
    const db = await setup();
    const shop = fakeShop();
    const same = [
      { uuid: "u-1", quantity: 2 },
      { uuid: "u-2", quantity: 1 },
    ];
    expect(await editRequest(db, ctx(), body({ lines: same, locationId: "101" }), deps(shop.impl))).toEqual({ kind: "unchanged" });
    expect(shop.ops()).toEqual(["DraftForEdit"]);
  });

  it("checks the body and the role before asking Shopify", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await editRequest(db, ctx(), body({ lines: [] }), deps(shop.impl))).toEqual({ kind: "invalid", error: EDIT_COPY.keepOne });
    expect(await editRequest(db, ctx("staff"), body(), deps(shop.impl))).toEqual({ kind: "forbidden", error: EDIT_REFUSALS.forbidden });
    expect(shop.calls).toEqual([]);
  });

  it("changes nothing when Shopify refuses", async () => {
    const db = await setup();
    const before = await card(db);
    const shop = fakeShop(
      {},
      {
        handle: {
          EditDraft: () =>
            Response.json({ data: { draftOrderUpdate: { draftOrder: null, userErrors: [{ field: ["lineItems"], message: "Quantity is invalid." }] } } }),
        },
      },
    );
    expect(await editRequest(db, ctx(), body(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify did not save the changes: Quantity is invalid. Nothing changed.",
    });
    expect(await card(db)).toEqual(before);
    expect(await timeline(db)).toEqual([]);
  });

  it("reports Shopify's own words when it answers the edit with an error, after reading the draft", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const db = await setup();
      const before = await card(db);
      const invalid = fakeShop(
        {},
        { handle: { EditDraft: () => Response.json({ errors: [{ message: "Variable $input of type DraftOrderInput! was provided invalid value." }] }) } },
      );
      expect(await editRequest(db, ctx(), body(), deps(invalid.impl))).toEqual({
        kind: "refused",
        status: 409,
        error: "Shopify did not save the changes: Variable $input of type DraftOrderInput! was provided invalid value. Nothing changed.",
      });
      expect(invalid.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftForEdit"]);
      expect(await card(db)).toEqual(before);
      expect(await timeline(db)).toEqual([]);

      // A rejected token is Shopify's answer too, not a missing one.
      const denied = fakeShop({}, { handle: { EditDraft: () => new Response("", { status: 401 }) } });
      expect(await editRequest(await setup(), ctx(), body(), deps(denied.impl))).toEqual({
        kind: "refused",
        status: 409,
        error: "Shopify did not save the changes: Shopify rejected the access token. Nothing changed.",
      });
      expect(denied.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftForEdit"]);

      // The draft moved meanwhile without the edit: no promise that nothing changed.
      const moved = fakeShop(
        {},
        {
          handle: {
            EditDraft: () => {
              moved.state.updatedAt = "2026-10-06T15:00:09Z";
              return Response.json({ errors: [{ message: "Internal error. Looks like something went wrong on our end." }] });
            },
          },
        },
      );
      expect(await editRequest(await setup(), ctx(), body(), deps(moved.impl))).toEqual({
        kind: "refused",
        status: 409,
        error:
          "Shopify did not save the changes: Internal error. Looks like something went wrong on our end. Check the request in Shopify before editing it again.",
      });

      // An internal error that ran anyway: the read finds the edit, so it counts.
      const ran = fakeShop(
        {},
        {
          handle: {
            EditDraft: (call) => {
              ran.applyEdit(call.variables.input as Record<string, unknown>);
              return Response.json({ errors: [{ message: "Internal error. Looks like something went wrong on our end." }] });
            },
          },
        },
      );
      const landed = await setup();
      expect(await editRequest(landed, ctx(), body(), deps(ran.impl))).toMatchObject({ kind: "edited", warning: null });
      expect(ran.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftForEdit", "DraftOrderById", "DraftBeforeApprove"]);
      expect((await card(landed)).locationId).toBe("102");

      // Ids and the failure kind only, never Shopify's words or the token.
      const logged = warn.mock.calls.map((call) => String(call[0]));
      const line = (failure: string) => "[edit] " + JSON.stringify({ workspaceId: WS, orderRowId: "d1", shopifyDraftId: "12", failure });
      expect(logged).toEqual([line("fatal"), line("auth"), line("fatal")]);
      expect(logged.join(" ")).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads after a timeout and never sends the edit twice", async () => {
    const db = await setup();
    const landed = fakeShop(
      {},
      {
        handle: {
          EditDraft: (call) => {
            landed.applyEdit(call.variables.input as Record<string, unknown>);
            return timeout();
          },
        },
      },
    );
    expect(await editRequest(db, ctx(), body(), deps(landed.impl))).toMatchObject({ kind: "edited" });
    expect(landed.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftForEdit", "DraftOrderById", "DraftBeforeApprove"]);
    expect((await card(db)).locationId).toBe("102");

    const other = await setup();
    const lost = fakeShop({}, { handle: { EditDraft: timeout } });
    expect(await editRequest(other, ctx(), body(), deps(lost.impl))).toEqual({
      kind: "refused",
      status: 502,
      error: EDIT_REFUSALS.noAnswerUnchanged,
    });
    expect(lost.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftForEdit"]);
    expect(await timeline(other)).toEqual([]);
  });

  it("warns when Shopify totals the edited request above $0.00, or is still calculating it", async () => {
    const db = await setup();
    const priced = fakeShop({}, { totalAfterEdit: "12.00" });
    expect(await editRequest(db, ctx(), body(), deps(priced.impl))).toMatchObject({
      kind: "edited",
      warning: "Shopify now totals this request at $12.00. Approve needs $0.00, so complete it in Shopify or edit it again.",
    });
    const other = await setup();
    const busy = fakeShop({}, { readyAfterEdit: false });
    expect(await editRequest(other, ctx(), body(), deps(busy.impl))).toMatchObject({ kind: "edited", warning: EDIT_REFUSALS.calculating });
    expect(busy.ops().filter((op) => op === "DraftBeforeApprove")).toHaveLength(1 + REVIEW_READY_TRIES);
  });

  it("records source ai and the app when edited through an AI app", async () => {
    const db = await setup();
    const result = await editRequest(db, { ...ctx(), via: { client: "claude-code" } }, body(), deps(fakeShop().impl));
    expect(result).toMatchObject({ kind: "edited", event: { type: "draft_edited", source: "ai" } });
    const entry = (await timeline(db)).find((event) => event.type === "draft_edited");
    expect(entry?.source).toBe("ai");
    expect(entry?.meta).toMatchObject({ ai: { client: "claude-code" } });
  });
});
