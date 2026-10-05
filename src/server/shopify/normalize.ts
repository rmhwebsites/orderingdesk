// Normalizes Shopify Admin GraphQL order payloads into the flat shape the app
// stores in orders.shopify. Pure data mapping: text passes through untouched
// (storage is JSON, not HTML; escaping is the renderer's job), unknown shapes
// degrade to defaults, and orders without any usable id are skipped.

import { FULFILLMENTS_PER_ORDER } from "./client";

export type NormalizedOrder = {
  shopifyOrderId: string;
  name: string;
  createdAt: number;
  customerName: string;
  email: string;
  total: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  // True only when Shopify confirmed delivery of the whole order (see
  // deliveredOf). The Shopify state mapping in status-sync.ts reads it.
  delivered: boolean;
  items: { title: string; qty: number; price: string | null; sku: string; variant: string }[];
  // True unless Shopify confirmed that items holds every line item on the
  // order. Anything built from items, such as a purchase order, must treat a
  // true value as a partial list.
  itemsTruncated: boolean;
  shipping: {
    name: string;
    a1: string;
    a2: string;
    city: string;
    prov: string;
    zip: string;
    country: string;
  } | null;
  tags: string;
  note: string;
};

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Accepts {data:{orders:{nodes|edges}}} (a raw GraphQL response) or a bare
// nodes array (what the client hands over after pagination).
function extractNodes(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isDict(payload) || !isDict(payload.data)) {
    return [];
  }
  const orders = payload.data.orders;
  if (!isDict(orders)) {
    return [];
  }
  return nodesOrEdges(orders);
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

function orderIdOf(order: Dict): string {
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

function itemsOf(order: Dict): NormalizedOrder["items"] {
  return normalizeLineItems(order.lineItems);
}

// A line item connection (nodes or edges) as stored items. Also used for
// the full line item list a purchase order prefill fetches
// (src/server/shopify/admin.ts fetchAllLineItems).
export function normalizeLineItems(connection: unknown): NormalizedOrder["items"] {
  const lineItems = isDict(connection) ? nodesOrEdges(connection) : [];
  return lineItems.filter(isDict).map((item) => ({
    title: str(item.title),
    qty: typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : 1,
    price: amountOf(shopMoneyOf(item.originalUnitPriceSet)),
    sku: str(item.sku),
    variant: str(item.variantTitle),
  }));
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

function shippingOf(order: Dict): NormalizedOrder["shipping"] {
  const address = order.shippingAddress;
  if (!isDict(address)) {
    return null;
  }
  const fallbackName = [str(address.firstName), str(address.lastName)]
    .filter((part) => part.length > 0)
    .join(" ");
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

function normalizeOne(raw: unknown): NormalizedOrder | null {
  if (!isDict(raw)) {
    return null;
  }
  const shopifyOrderId = orderIdOf(raw);
  if (shopifyOrderId.length === 0) {
    return null;
  }

  const customer = isDict(raw.customer) ? raw.customer : undefined;
  const customerName =
    str(customer?.displayName) ||
    [str(customer?.firstName), str(customer?.lastName)]
      .filter((part) => part.length > 0)
      .join(" ");

  const money = shopMoneyOf(raw.currentTotalPriceSet) ?? shopMoneyOf(raw.totalPriceSet);
  const parsedCreatedAt = Date.parse(str(raw.createdAt));

  return {
    shopifyOrderId,
    name: str(raw.name),
    createdAt: Number.isNaN(parsedCreatedAt) ? 0 : parsedCreatedAt,
    customerName,
    email: (str(raw.email) || str(customer?.email)).toLowerCase(),
    total: amountOf(money) ?? "0",
    currency: str(money?.currencyCode) || "USD",
    financialStatus: statusText(raw.displayFinancialStatus, ""),
    fulfillmentStatus: statusText(raw.displayFulfillmentStatus, "unfulfilled"),
    delivered: deliveredOf(raw),
    items: itemsOf(raw),
    itemsTruncated: itemsTruncatedOf(raw),
    shipping: shippingOf(raw),
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string").join(", ")
      : str(raw.tags),
    note: str(raw.note),
  };
}

export function normalizeOrders(payload: unknown): NormalizedOrder[] {
  const result: NormalizedOrder[] = [];
  for (const node of extractNodes(payload)) {
    const normalized = normalizeOne(node);
    if (normalized) {
      result.push(normalized);
    }
  }
  return result;
}
