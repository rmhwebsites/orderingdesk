// Work queue settings per workspace (comprehensive desk design section 1).
// Pure and shared: the schema takes the price display values from here, the
// server validates with them and the desk reads them.

// Totals and the Paid chip on the desk: auto hides them when nearly every
// card is $0, show and hide force it.
export const PRICE_DISPLAY_VALUES = ["auto", "show", "hide"] as const;
export type PriceDisplay = (typeof PRICE_DISPLAY_VALUES)[number];

export const AGE_AMBER_MAX = 60;
export const AGE_RED_MAX = 90;

export type QueueSettingsView = { ageAmberDays: number; ageRedDays: number; priceDisplay: PriceDisplay };

export const DEFAULT_QUEUE_SETTINGS: QueueSettingsView = { ageAmberDays: 2, ageRedDays: 4, priceDisplay: "auto" };

function wholeDays(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

// The whole setting, or what is wrong with it. Red must come after amber.
export function parseQueueSettings(body: unknown): QueueSettingsView | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "Send ageAmberDays, ageRedDays and priceDisplay";
  }
  const record = body as Record<string, unknown>;
  const amber = wholeDays(record.ageAmberDays, AGE_AMBER_MAX);
  if (amber === null) {
    return `Amber after must be a whole number of days from 1 to ${AGE_AMBER_MAX}`;
  }
  const red = wholeDays(record.ageRedDays, AGE_RED_MAX);
  if (red === null) {
    return `Red after must be a whole number of days from 1 to ${AGE_RED_MAX}`;
  }
  if (red <= amber) {
    return "Red must come after amber: pick more days for red";
  }
  const display = record.priceDisplay;
  if (typeof display !== "string" || !(PRICE_DISPLAY_VALUES as readonly string[]).includes(display)) {
    return "Show prices must be auto, show or hide";
  }
  return { ageAmberDays: amber, ageRedDays: red, priceDisplay: display as PriceDisplay };
}

// A total is a price when it is a number other than 0.
export function isPriced(total: string): boolean {
  const value = Number(total);
  return total.trim().length > 0 && Number.isFinite(value) && value !== 0;
}

// Auto shows prices only when more than this share of the loaded cards has
// one: a company store where nearly every order is $0 reads cleaner
// without them (comprehensive desk design section 1).
export const AUTO_PRICE_SHARE = 0.05;

export function pricesShown(mode: PriceDisplay, totals: readonly string[]): boolean {
  if (mode !== "auto") {
    return mode === "show";
  }
  if (totals.length === 0) {
    return false;
  }
  return totals.filter(isPriced).length / totals.length > AUTO_PRICE_SHARE;
}
