// Items and sizes over a set of cards (employee and location pages). Pure.

export const ITEMS_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export type ItemTotal = { title: string; variant: string; quantity: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Quantities per item title and size (variant), case folded, most ordered
// first, at most max entries.
export function itemTotals(snapshots: readonly unknown[], max: number): ItemTotal[] {
  const totals = new Map<string, ItemTotal>();
  for (const snapshot of snapshots) {
    const items = isRecord(snapshot) && Array.isArray(snapshot.items) ? snapshot.items.filter(isRecord) : [];
    for (const item of items) {
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (title.length === 0) {
        continue;
      }
      const variant = typeof item.variant === "string" ? item.variant.trim() : "";
      const quantity = typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 1;
      const key = `${title.toLowerCase()}\n${variant.toLowerCase()}`;
      const entry = totals.get(key) ?? { title, variant, quantity: 0 };
      entry.quantity += quantity;
      totals.set(key, entry);
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.quantity - a.quantity || a.title.localeCompare(b.title) || a.variant.localeCompare(b.variant))
    .slice(0, max);
}
