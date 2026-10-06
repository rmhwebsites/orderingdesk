// Work queue settings per workspace (comprehensive desk design section 1).
// Pure and shared: the schema takes the price display values from here, the
// server validates with them and the desk reads them.

// Totals and the Paid chip on the desk: auto hides them when nearly every
// card is $0, show and hide force it.
export const PRICE_DISPLAY_VALUES = ["auto", "show", "hide"] as const;
export type PriceDisplay = (typeof PRICE_DISPLAY_VALUES)[number];
