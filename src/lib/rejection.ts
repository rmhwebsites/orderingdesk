import type { EventView } from "../server/desk/shapes";

// The newest Reject decision in a timeline: Reject saves its reason as a
// note marked rejectReason. The review panel quotes it with who and when.
export function rejectionOf(timeline: readonly EventView[]): EventView | null {
  let newest: EventView | null = null;
  for (const event of timeline) {
    const meta = typeof event.meta === "object" && event.meta !== null ? (event.meta as Record<string, unknown>) : {};
    if (event.type === "note" && meta.rejectReason === true && (newest === null || event.createdAt > newest.createdAt)) {
      newest = event;
    }
  }
  return newest;
}
