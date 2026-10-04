// How long a status label may be. Every status is written to its Shopify
// order as one tag, STATUS_TAG_PREFIX plus the label (src/server/shopify/
// status-sync.ts), and Shopify allows SHOPIFY_TAG_MAX characters per order
// tag, so a label may use what the prefix leaves. Shared by the statuses
// service and the Settings form. Relative imports only (none needed here):
// the sync engine bundles status-sync.ts into the custom worker.

export const STATUS_TAG_PREFIX = "Ordering Desk: ";
export const SHOPIFY_TAG_MAX = 40;
export const STATUS_LABEL_MAX = SHOPIFY_TAG_MAX - STATUS_TAG_PREFIX.length;
