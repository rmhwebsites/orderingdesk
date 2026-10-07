// One address formatter for every place the desk shows an address
// (comprehensive design section 2): the drawer's ship-to, the list's
// Branch column, the purchase order modal and its send step, the vendor
// email and the PO PDF. A Shopify B2B company location reads as its name
// (bold where the surface can show weight), then the address lines; with
// no location, the address alone, recipient first, exactly as before.
// Pure and import-free: the cron bundle, the PDF renderer, emails and
// client components all use it.

export type LocationAddress = {
  address1: string;
  address2: string;
  city: string;
  province: string;
  provinceCode: string;
  zip: string;
  country: string;
  countryCode: string;
  phone: string;
  company: string;
};

// A snapshot's shipping address (src/lib/order-snapshot.ts and the
// normalizer's Shipping), with a draft's company and phone when present.
export type ShippingLike = {
  name?: string;
  company?: string;
  phone?: string;
  a1: string;
  a2: string;
  city: string;
  prov: string;
  zip: string;
  country: string;
};

// heading: the location name, or null without a location.
export type AddressBlockModel = { heading: string | null; lines: string[]; phone: string | null };

const FIELDS = [
  "address1",
  "address2",
  "city",
  "province",
  "provinceCode",
  "zip",
  "country",
  "countryCode",
  "phone",
  "company",
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmpty(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function locality(city: string, region: string, zip: string): string {
  return [city.trim(), region.trim(), zip.trim()].filter((part) => part.length > 0).join(" ");
}

// The JSON stored in locations.address, read defensively; null when it is
// not an object or has no address line at all.
export function readLocationAddress(raw: unknown): LocationAddress | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const address = Object.fromEntries(FIELDS.map((field) => [field, text(record[field])])) as LocationAddress;
  return address.address1 || address.address2 || address.city || address.zip ? address : null;
}

export function locationAddressLines(address: LocationAddress): string[] {
  return nonEmpty([
    address.address1,
    address.address2,
    locality(address.city, address.provinceCode || address.province, address.zip),
    address.countryCode || address.country,
  ]);
}

// withRecipient: the name and company lines first (an address shown on its
// own); without, the street lines only (under a location heading).
export function shippingAddressLines(shipping: ShippingLike, opts: { withRecipient: boolean }): string[] {
  const recipient = opts.withRecipient ? [shipping.name ?? "", shipping.company ?? ""] : [];
  return nonEmpty([...recipient, shipping.a1, shipping.a2, locality(shipping.city, shipping.prov, shipping.zip), shipping.country]);
}

export function addressBlock(input: {
  locationName?: string | null;
  locationAddress?: LocationAddress | null;
  shipping?: ShippingLike | null;
}): AddressBlockModel | null {
  const heading = text(input.locationName);
  const shipping = input.shipping ?? null;
  if (heading.length > 0) {
    const own = shipping ? shippingAddressLines(shipping, { withRecipient: false }) : [];
    const lines = own.length > 0 ? own : input.locationAddress ? locationAddressLines(input.locationAddress) : [];
    const phone = (own.length > 0 ? text(shipping?.phone) : text(input.locationAddress?.phone)) || null;
    return { heading, lines, phone };
  }
  if (!shipping) {
    return null;
  }
  return { heading: null, lines: shippingAddressLines(shipping, { withRecipient: true }), phone: text(shipping.phone) || null };
}

// A purchase order's stored ship-to (one line per row): the first line is
// who or where it goes to, the rest the address.
export function addressBlockFromLines(lines: readonly string[]): AddressBlockModel | null {
  const kept = nonEmpty([...lines]);
  if (kept.length === 0) {
    return null;
  }
  return { heading: kept[0], lines: kept.slice(1), phone: null };
}

// The block as plain lines, heading first (the PO ship-to field, plain text).
export function addressBlockLines(block: AddressBlockModel | null): string[] {
  if (!block) {
    return [];
  }
  return block.heading ? [block.heading, ...block.lines] : [...block.lines];
}

// The address lines on one line ("100 Example Way, Buford GA 30518, US").
export function oneLineAddress(block: AddressBlockModel | null): string {
  return block ? block.lines.join(", ") : "";
}

// What a card calls its place: the synced location name, else the
// request's own branch field (a cart attribute or the draft's location).
export function placeLabel(locationName: string | null | undefined, fallback: string): string {
  return text(locationName) || text(fallback);
}
