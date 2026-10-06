// Display formatting for the desk. Pure functions; times take an optional
// IANA time zone so tests are deterministic (the browser's own zone
// otherwise).

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string): Intl.NumberFormat | null {
  const cached = moneyFormatters.get(currency);
  if (cached) {
    return cached;
  }
  try {
    const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    moneyFormatters.set(currency, formatter);
    return formatter;
  } catch {
    return null;
  }
}

// "120.00" + "CAD" -> "CA$120.00". Anything unreadable comes back as the
// raw text, so nothing is ever hidden or shown as a wrong number.
export function formatMoney(amount: string, currency: string): string {
  if (amount.trim().length === 0) {
    return "";
  }
  const value = Number(amount);
  const formatter = moneyFormatter(currency);
  if (!Number.isFinite(value) || !formatter) {
    return `${amount} ${currency}`.trim();
  }
  return formatter.format(value);
}

export function formatDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(ms);
}

export function formatTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(ms);
}

export function formatDateTime(ms: number, timeZone?: string): string {
  return `${formatDate(ms, timeZone)}, ${formatTime(ms, timeZone)}`;
}

// "just now", "4 min ago", "3 h ago", then a short date ("Sep 30", with the
// year when it is not this year).
export function relativeTime(ms: number, now: number, timeZone?: string): string {
  const elapsed = now - ms;
  if (elapsed < 45000) {
    return "just now";
  }
  if (elapsed < 3600000) {
    return `${Math.max(1, Math.round(elapsed / 60000))} min ago`;
  }
  if (elapsed < 86400000) {
    return `${Math.floor(elapsed / 3600000)} h ago`;
  }
  const sameYear =
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(ms) ===
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(now);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone,
  }).format(ms);
}

export function sentenceCase(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

const SHOP_DOMAIN = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/;
const LEGACY_ID = /^[0-9]+$/;

// https://admin.shopify.com/store/<handle>/orders/<legacy order id>, where
// handle is the shop domain without .myshopify.com. Null when there is no
// connected shop or the id is not a Shopify order number, so the link is
// left out rather than pointing somewhere wrong.
export function shopifyAdminOrderUrl(shopDomain: string | null, legacyOrderId: string): string | null {
  return adminUrl(shopDomain, "orders", legacyOrderId);
}

// The same for a draft order: .../draft_orders/<legacy draft id>.
export function shopifyAdminDraftUrl(shopDomain: string | null, legacyDraftId: string | null): string | null {
  return adminUrl(shopDomain, "draft_orders", legacyDraftId);
}

function adminUrl(shopDomain: string | null, section: "orders" | "draft_orders", legacyId: string | null): string | null {
  const match = typeof shopDomain === "string" ? shopDomain.toLowerCase().match(SHOP_DOMAIN) : null;
  if (!match || legacyId === null || !LEGACY_ID.test(legacyId)) {
    return null;
  }
  return `https://admin.shopify.com/store/${match[1]}/${section}/${legacyId}`;
}

// "Casey Lin" -> "CL"; no name: the email's first letter. Uppercase, at
// most two letters, "?" when there is nothing to use.
export function initials(name: string | null | undefined, email: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter((word) => word.length > 0);
  const letters = words.length > 0 ? words.slice(0, 2).map((word) => word.charAt(0)) : [email.trim().charAt(0)];
  const text = letters.join("").toUpperCase();
  return text.length > 0 ? text : "?";
}

// "Oct 5" this year, "Oct 5, 2025" otherwise: a list's date column.
export function formatDay(ms: number, now: number, timeZone?: string): string {
  const year = (value: number) => new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: year(ms) === year(now) ? undefined : "numeric",
    timeZone,
  }).format(ms);
}
