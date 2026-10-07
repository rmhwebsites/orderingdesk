// Normalizes Shopify Admin GraphQL order and draft order payloads into the
// flat shapes the app stores in orders.shopify (and orders.draft_snapshot).
// Pure data mapping: text passes through untouched (storage is JSON, not
// HTML; escaping is the renderer's job), unknown shapes degrade to
// defaults, and nodes without any usable id are skipped. Both shapes are
// built with keys in one fixed order: stored snapshots are compared by
// JSON.stringify equality.

import { FULFILLMENTS_PER_ORDER } from "./client";

// A cart attribute or a line item property, in Shopify's order. Keys that
// start with an underscore (_pdf, _pplr_preview) are kept: hiding them is a
// display decision.
export type Attribute = { key: string; value: string };

export type Item = {
  title: string;
  qty: number;
  price: string | null;
  sku: string;
  variant: string;
  // The line item's properties (customAttributes): personalization such as
  // a business card's name, preview image and PDF proof.
  props: Attribute[];
};

export type Shipping = {
  name: string;
  a1: string;
  a2: string;
  city: string;
  prov: string;
  zip: string;
  country: string;
};

export type NormalizedOrder = {
  kind: "order";
  shopifyOrderId: string;
  name: string;
  createdAt: number;
  customerName: string;
  email: string;
  // The customer's legacy id: the requester (design section 3), or "".
  customerId: string;
  total: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  // True only when Shopify confirmed delivery of the whole order (see
  // deliveredOf). The Shopify state mapping in status-sync.ts reads it.
  delivered: boolean;
  items: Item[];
  // True unless Shopify confirmed that items holds every line item on the
  // order. Anything built from items, such as a purchase order, must treat a
  // true value as a partial list.
  itemsTruncated: boolean;
  shipping: Shipping | null;
  tags: string;
  note: string;
  // "shopify_draft_order" for an order made from a draft.
  sourceName: string;
  // The order's cart attributes (customAttributes).
  attributes: Attribute[];
  // When Shopify cancelled the order (ms), or null (comprehensive design
  // section 2: the Shopify to app rule in status-sync.ts moves the card).
  cancelledAt: number | null;
  // The B2B purchasing entity's company location, as a legacy id (the
  // value of orders.location_id and locations.shopify_location_id), or null.
  locationId: string | null;
};

export type DraftStatus = "open" | "invoice_sent" | "completed";

export type NormalizedDraft = {
  kind: "draft";
  // legacyResourceId, else the gid tail.
  shopifyDraftId: string;
  // "#D12"
  name: string;
  status: DraftStatus;
  createdAt: number;
  completedAt: number | null;
  // The legacy id and name of the order the draft became.
  orderId: string | null;
  orderName: string | null;
  // displayName, else first and last name, else the shipping name.
  customerName: string;
  // The draft's email, else the customer's, lowercased.
  email: string;
  // The customer's legacy id: the requester (design section 3), or "".
  customerId: string;
  // The B2B purchasing company and location, else "".
  company: string;
  location: string;
  // The B2B company contact who placed it (legacy id), else "".
  contactId: string;
  attributes: Attribute[];
  discountCodes: string[];
  discount: { title: string; value: string; valueType: string } | null;
  subtotal: string;
  discounts: string;
  total: string;
  currency: string;
  items: (Item & { custom: boolean })[];
  itemsTruncated: boolean;
  shipping: (Shipping & { company: string; phone: string }) | null;
  // Joined with ", " like orders.
  tags: string;
  // note2
  note: string;
  poNumber: string;
  // The purchasing entity's company location, as a legacy id, or null.
  locationId: string | null;
};

// Caps on what a snapshot keeps from Shopify's free-form attributes.
export const ATTRIBUTES_MAX = 50;
export const ITEM_PROPS_MAX = 30;
export const ATTRIBUTE_KEY_MAX = 200;
export const ATTRIBUTE_VALUE_MAX = 2000;

// A snapshot stored before snapshots carried a kind reads as an order.
export function snapshotKind(snapshot: unknown): "draft" | "order" {
  return isDict(snapshot) && snapshot.kind === "draft" ? "draft" : "order";
}

const COMPANY_LOCATION_GID = /^gid:\/\/shopify\/CompanyLocation\/([1-9]\d{0,19})$/;

// The legacy id of a company location gid ("gid://shopify/CompanyLocation/
// 101" -> "101"), or null for anything else. Shared with
// src/server/shopify/locations.ts and the edit service.
export function companyLocationIdOf(gid: unknown): string | null {
  return typeof gid === "string" ? (gid.match(COMPANY_LOCATION_GID)?.[1] ?? null) : null;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Accepts {data:{<root>:{nodes|edges}}} (a raw GraphQL response) or a bare
// nodes array (what the client hands over after pagination).
function extractNodes(payload: unknown, root: "orders" | "draftOrders"): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isDict(payload) || !isDict(payload.data)) {
    return [];
  }
  const container = payload.data[root];
  if (!isDict(container)) {
    return [];
  }
  return nodesOrEdges(container);
}

function nodesOrEdges(container: Dict): unknown[] {
  if (Array.isArray(container.nodes)) {
    return container.nodes;
  }
  if (Array.isArray(container.edges)) {
    return container.edges.map((edge) => (isDict(edge) ? edge.node : undefined));
  }
  return [];
}

function shopMoneyOf(priceSet: unknown): Dict | undefined {
  if (isDict(priceSet) && isDict(priceSet.shopMoney)) {
    return priceSet.shopMoney;
  }
  return undefined;
}

function amountOf(money: Dict | undefined): string | null {
  const amount = money?.amount;
  if (typeof amount === "string") {
    return amount;
  }
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return String(amount);
  }
  return null;
}

// legacyResourceId, else the numeric tail of the gid, else "".
function legacyIdOf(order: Dict): string {
  const legacy = order.legacyResourceId;
  if (typeof legacy === "string" && legacy.length > 0) {
    return legacy;
  }
  if (typeof legacy === "number" && Number.isFinite(legacy)) {
    return String(legacy);
  }
  const gid = order.id;
  if (typeof gid === "string" && gid.length > 0) {
    return gid.slice(gid.lastIndexOf("/") + 1);
  }
  return "";
}

// "PARTIALLY_REFUNDED" -> "partially refunded"
function statusText(value: unknown, fallback: string): string {
  const raw = str(value);
  return raw.length > 0 ? raw.toLowerCase().split("_").join(" ") : fallback;
}

// customAttributes as stored attributes: Shopify's order, entries without a
// key dropped, a missing value read as "", key and value capped, at most
// `max` entries.
function attributesOf(raw: unknown, max: number): Attribute[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Attribute[] = [];
  for (const entry of raw) {
    if (out.length >= max) {
      break;
    }
    if (!isDict(entry) || typeof entry.key !== "string" || entry.key.length === 0) {
      continue;
    }
    out.push({
      key: entry.key.slice(0, ATTRIBUTE_KEY_MAX),
      value: str(entry.value).slice(0, ATTRIBUTE_VALUE_MAX),
    });
  }
  return out;
}

function itemOf(item: Dict): Item {
  return {
    title: str(item.title),
    qty: typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : 1,
    price: amountOf(shopMoneyOf(item.originalUnitPriceSet)),
    sku: str(item.sku),
    variant: str(item.variantTitle),
    props: attributesOf(item.customAttributes, ITEM_PROPS_MAX),
  };
}

// A line item connection (nodes or edges) as stored items. Also used for
// the full line item list a purchase order prefill fetches
// (src/server/shopify/admin.ts fetchAllLineItems).
export function normalizeLineItems(connection: unknown): Item[] {
  const lineItems = isDict(connection) ? nodesOrEdges(connection) : [];
  return lineItems.filter(isDict).map(itemOf);
}

// The sync fetches one page of line items per order. Only an explicit "no
// next page" from Shopify counts as complete; a missing or malformed answer
// is treated as truncated.
function itemsTruncatedOf(order: Dict): boolean {
  const pageInfo = isDict(order.lineItems) ? order.lineItems.pageInfo : undefined;
  return !(isDict(pageInfo) && pageInfo.hasNextPage === false);
}

// Fulfillment display statuses that mean the customer has the goods.
const DELIVERED_DISPLAY = new Set(["DELIVERED", "PICKED_UP"]);

// Delivered means: Shopify reports the order FULFILLED as a whole, and every
// fulfillment that was not canceled (at least one) shows DELIVERED or
// PICKED_UP. The query asks for FULFILLMENTS_PER_ORDER fulfillments; a list
// that comes back full may continue past them, so it never confirms
// delivery. Anything missing or malformed reads as not delivered.
function deliveredOf(order: Dict): boolean {
  if (order.displayFulfillmentStatus !== "FULFILLED") {
    return false;
  }
  const list = order.fulfillments;
  if (!Array.isArray(list) || list.length === 0 || list.length >= FULFILLMENTS_PER_ORDER) {
    return false;
  }
  const live = list.filter((item) => !(isDict(item) && item.displayStatus === "CANCELED"));
  return (
    live.length > 0 &&
    live.every((item) => isDict(item) && typeof item.displayStatus === "string" && DELIVERED_DISPLAY.has(item.displayStatus))
  );
}

function fullName(first: unknown, last: unknown): string {
  return [str(first), str(last)].filter((part) => part.length > 0).join(" ");
}

function shippingOf(order: Dict): Shipping | null {
  const address = order.shippingAddress;
  if (!isDict(address)) {
    return null;
  }
  const fallbackName = fullName(address.firstName, address.lastName);
  return {
    name: str(address.name) || fallbackName,
    a1: str(address.address1),
    a2: str(address.address2),
    city: str(address.city),
    prov: str(address.provinceCode),
    zip: str(address.zip),
    // countryCode is deprecated; read for nodes shaped before the switch.
    country: str(address.countryCodeV2) || str(address.countryCode),
  };
}

// The purchasing entity's company location as a legacy id; null for a
// customer's own (D2C) order or draft, or a shape this code does not know.
function purchasingLocationIdOf(raw: Dict): string | null {
  const entity = isDict(raw.purchasingEntity) ? raw.purchasingEntity : undefined;
  const location = entity && isDict(entity.location) ? entity.location : undefined;
  return companyLocationIdOf(location?.id);
}

function normalizeOne(raw: unknown): NormalizedOrder | null {
  if (!isDict(raw)) {
    return null;
  }
  const shopifyOrderId = legacyIdOf(raw);
  if (shopifyOrderId.length === 0) {
    return null;
  }

  const customer = isDict(raw.customer) ? raw.customer : undefined;
  const customerName = str(customer?.displayName) || fullName(customer?.firstName, customer?.lastName);

  const money = shopMoneyOf(raw.currentTotalPriceSet) ?? shopMoneyOf(raw.totalPriceSet);

  return {
    kind: "order",
    shopifyOrderId,
    name: str(raw.name),
    createdAt: timeOf(raw.createdAt) ?? 0,
    customerName,
    email: (str(raw.email) || str(customer?.email)).toLowerCase(),
    customerId: customer ? legacyIdOf(customer) : "",
    total: amountOf(money) ?? "0",
    currency: str(money?.currencyCode) || "USD",
    financialStatus: statusText(raw.displayFinancialStatus, ""),
    fulfillmentStatus: statusText(raw.displayFulfillmentStatus, "unfulfilled"),
    delivered: deliveredOf(raw),
    items: normalizeLineItems(raw.lineItems),
    itemsTruncated: itemsTruncatedOf(raw),
    shipping: shippingOf(raw),
    tags: tagsOf(raw.tags),
    note: str(raw.note),
    sourceName: str(raw.sourceName),
    attributes: attributesOf(raw.customAttributes, ATTRIBUTES_MAX),
    cancelledAt: timeOf(raw.cancelledAt),
    locationId: purchasingLocationIdOf(raw),
  };
}

// An ISO timestamp as ms, or null when it does not parse.
function timeOf(value: unknown): number | null {
  const parsed = Date.parse(str(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function tagsOf(tags: unknown): string {
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string").join(", ") : str(tags);
}

export function normalizeOrders(payload: unknown): NormalizedOrder[] {
  const result: NormalizedOrder[] = [];
  for (const node of extractNodes(payload, "orders")) {
    const normalized = normalizeOne(node);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}

function draftStatusOf(value: unknown): DraftStatus {
  switch (value) {
    case "INVOICE_SENT":
      return "invoice_sent";
    case "COMPLETED":
      return "completed";
    default:
      return "open";
  }
}

function normalizeDraftOne(raw: unknown): NormalizedDraft | null {
  if (!isDict(raw)) {
    return null;
  }
  const shopifyDraftId = legacyIdOf(raw);
  if (shopifyDraftId.length === 0) {
    return null;
  }
  const order = isDict(raw.order) ? raw.order : undefined;
  const orderId = order ? legacyIdOf(order) : "";
  const customer = isDict(raw.customer) ? raw.customer : undefined;
  const shipping = shippingOf(raw);
  const address = isDict(raw.shippingAddress) ? raw.shippingAddress : undefined;
  const entity = isDict(raw.purchasingEntity) ? raw.purchasingEntity : undefined;
  const company = entity && isDict(entity.company) ? entity.company : undefined;
  const location = entity && isDict(entity.location) ? entity.location : undefined;
  const contact = entity && isDict(entity.contact) ? entity.contact : undefined;
  const applied = isDict(raw.appliedDiscount) ? raw.appliedDiscount : undefined;
  const total = shopMoneyOf(raw.totalPriceSet);
  const lineItems = isDict(raw.lineItems) ? nodesOrEdges(raw.lineItems) : [];

  return {
    kind: "draft",
    shopifyDraftId,
    name: str(raw.name),
    status: draftStatusOf(raw.status),
    createdAt: timeOf(raw.createdAt) ?? 0,
    completedAt: timeOf(raw.completedAt),
    orderId: orderId.length > 0 ? orderId : null,
    orderName: order && str(order.name).length > 0 ? str(order.name) : null,
    customerName:
      str(customer?.displayName) || fullName(customer?.firstName, customer?.lastName) || (shipping?.name ?? ""),
    email: (str(raw.email) || str(customer?.email)).toLowerCase(),
    customerId: customer ? legacyIdOf(customer) : "",
    company: str(company?.name),
    location: str(location?.name),
    contactId: contact ? legacyIdOf(contact) : "",
    attributes: attributesOf(raw.customAttributes, ATTRIBUTES_MAX),
    discountCodes: Array.isArray(raw.discountCodes)
      ? raw.discountCodes.filter((code): code is string => typeof code === "string")
      : [],
    discount: applied
      ? {
          title: str(applied.title),
          value:
            typeof applied.value === "number" && Number.isFinite(applied.value) ? String(applied.value) : str(applied.value),
          valueType: str(applied.valueType),
        }
      : null,
    subtotal: amountOf(shopMoneyOf(raw.subtotalPriceSet)) ?? "0",
    discounts: amountOf(shopMoneyOf(raw.totalDiscountsSet)) ?? "0",
    total: amountOf(total) ?? "0",
    currency: str(total?.currencyCode) || "USD",
    items: lineItems.filter(isDict).map((item) => ({ ...itemOf(item), custom: item.custom === true })),
    itemsTruncated: itemsTruncatedOf(raw),
    shipping: shipping ? { ...shipping, company: str(address?.company), phone: str(address?.phone) } : null,
    tags: tagsOf(raw.tags),
    note: str(raw.note2),
    poNumber: str(raw.poNumber),
    locationId: purchasingLocationIdOf(raw),
  };
}

// Accepts a nodes array or a raw {data:{draftOrders}} response, like
// normalizeOrders.
export function normalizeDrafts(payload: unknown): NormalizedDraft[] {
  const result: NormalizedDraft[] = [];
  for (const node of extractNodes(payload, "draftOrders")) {
    const normalized = normalizeDraftOne(node);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}
