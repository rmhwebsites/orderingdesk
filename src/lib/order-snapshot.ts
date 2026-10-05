// Reads the stored Shopify snapshot (orders.shopify, written by the sync
// normalizer) for the order drawer: an order, or a draft order (draft
// orders spec section 4). Defensive like the server's summarize(): a
// malformed snapshot shows empty fields instead of breaking the drawer.

export type SnapshotProperty = { key: string; value: string };

export type SnapshotItem = {
  title: string;
  qty: number;
  price: string | null;
  sku: string;
  variant: string;
  // Line item properties (personalization), in Shopify's order.
  props: SnapshotProperty[];
  // A draft's custom line item (not a catalog product).
  custom: boolean;
};

export type SnapshotShipping = {
  name: string;
  // A draft's shipping company and phone ("" for orders).
  company: string;
  phone: string;
  a1: string;
  a2: string;
  city: string;
  prov: string;
  zip: string;
  country: string;
};

export type OrderSnapshot = {
  // A snapshot without a kind (stored before drafts) reads as an order.
  kind: "draft" | "order";
  name: string;
  // When Shopify created it (ms), or null.
  createdAt: number | null;
  customerName: string;
  email: string;
  total: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  items: SnapshotItem[];
  shipping: SnapshotShipping | null;
  tags: string[];
  note: string;
  // Draft fields ("" or null on an order).
  draftStatus: "open" | "invoice_sent" | "completed" | null;
  orderName: string | null;
  subtotal: string;
  discounts: string;
  discount: { title: string; value: string; valueType: string } | null;
  discountCodes: string[];
  poNumber: string;
};

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function propsOf(raw: unknown): SnapshotProperty[] {
  return Array.isArray(raw)
    ? raw
        .filter(isDict)
        .filter((entry) => typeof entry.key === "string" && entry.key.length > 0)
        .map((entry) => ({ key: str(entry.key), value: str(entry.value) }))
    : [];
}

export function readSnapshot(raw: unknown): OrderSnapshot {
  const s = isDict(raw) ? raw : {};
  const items = Array.isArray(s.items) ? s.items : [];
  const shipping = isDict(s.shipping) ? s.shipping : null;
  const kind = s.kind === "draft" ? "draft" : "order";
  const discount = isDict(s.discount) ? s.discount : null;
  return {
    kind,
    name: str(s.name),
    createdAt: typeof s.createdAt === "number" && Number.isFinite(s.createdAt) && s.createdAt > 0 ? s.createdAt : null,
    customerName: str(s.customerName),
    email: str(s.email),
    total: str(s.total),
    currency: str(s.currency),
    financialStatus: str(s.financialStatus),
    fulfillmentStatus: str(s.fulfillmentStatus),
    items: items.filter(isDict).map((item) => ({
      title: str(item.title),
      qty: typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 1,
      price: typeof item.price === "string" ? item.price : null,
      sku: str(item.sku),
      variant: str(item.variant),
      props: propsOf(item.props),
      custom: item.custom === true,
    })),
    shipping: shipping
      ? {
          name: str(shipping.name),
          company: str(shipping.company),
          phone: str(shipping.phone),
          a1: str(shipping.a1),
          a2: str(shipping.a2),
          city: str(shipping.city),
          prov: str(shipping.prov),
          zip: str(shipping.zip),
          country: str(shipping.country),
        }
      : null,
    tags: str(s.tags)
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    note: str(s.note),
    draftStatus:
      kind === "draft" ? (s.status === "invoice_sent" || s.status === "completed" ? s.status : "open") : null,
    orderName: typeof s.orderName === "string" && s.orderName.length > 0 ? s.orderName : null,
    subtotal: str(s.subtotal),
    discounts: str(s.discounts),
    discount: discount ? { title: str(discount.title), value: str(discount.value), valueType: str(discount.valueType) } : null,
    discountCodes: Array.isArray(s.discountCodes) ? s.discountCodes.filter((code): code is string => typeof code === "string") : [],
    poNumber: str(s.poNumber),
  };
}

// Sum of price x quantity in cents, as a decimal string; null when any item
// has no readable price (a partial sum would read as the real one).
export function itemsSubtotal(items: Array<Pick<SnapshotItem, "qty" | "price"> & Partial<SnapshotItem>>): string | null {
  if (items.length === 0) {
    return null;
  }
  let cents = 0;
  for (const item of items) {
    const price = item.price === null ? NaN : Number(item.price);
    if (!Number.isFinite(price)) {
      return null;
    }
    cents += Math.round(price * 100) * item.qty;
  }
  return (cents / 100).toFixed(2);
}

// The address as lines: name, company (a draft's), street, locality,
// country. The phone is not an address line.
export function shippingLines(shipping: Pick<SnapshotShipping, "name" | "a1" | "a2" | "city" | "prov" | "zip" | "country"> & { company?: string }): string[] {
  const locality = [shipping.city, shipping.prov, shipping.zip].filter((part) => part.length > 0).join(" ");
  return [shipping.name, shipping.company ?? "", shipping.a1, shipping.a2, locality, shipping.country].filter(
    (line) => line.length > 0,
  );
}

// Tone names (globals.css [data-tone]) for Shopify's own payment and
// fulfillment states, which the normalizer stores lowercased with spaces.
export function financialTone(status: string): string {
  if (status === "paid") {
    return "green";
  }
  if (["pending", "authorized", "partially paid", "expired"].includes(status)) {
    return "amber";
  }
  return "slate";
}

export function fulfillmentTone(status: string): string {
  if (status === "fulfilled") {
    return "green";
  }
  if (["unfulfilled", "partially fulfilled", "in progress", "on hold", "scheduled", "open"].includes(status)) {
    return "amber";
  }
  return "slate";
}
