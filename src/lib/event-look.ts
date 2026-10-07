// One look for activity entries (comprehensive desk design section 1): the
// drawer's timeline and the bell show the same glyph and tone for the same
// event. Tones carry meaning: approvals green, rejections and failed writes
// red, sync problems amber, purchase orders sent blue, everything else
// neutral. Pure, so the mapping is tested; src/components/event-icon.tsx
// turns a glyph into its Phosphor icon.

export type EventGlyph =
  | "note"
  | "status"
  | "approve"
  | "reject"
  | "order"
  | "request"
  | "po"
  | "po-sent"
  | "warning"
  | "shopify"
  | "completed"
  | "deleted"
  | "edit"
  | "cancelled";

export type EventTone = "slate" | "green" | "red" | "amber" | "blue";

export type EventLook = { glyph: EventGlyph; tone: EventTone };

function metaOf(meta: unknown): Record<string, unknown> {
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
}

export function eventLook(event: { type: string; meta?: unknown; source?: string | null }): EventLook {
  const meta = metaOf(event.meta);
  switch (event.type) {
    case "note":
      return { glyph: "note", tone: "slate" };
    case "order_new":
      return meta.kind === "draft" ? { glyph: "request", tone: "slate" } : { glyph: "order", tone: "slate" };
    case "po_draft":
      return { glyph: "po", tone: "slate" };
    case "po_sent":
      return { glyph: "po-sent", tone: "blue" };
    case "po_failed":
      return { glyph: "warning", tone: "red" };
    case "sync_error":
      return { glyph: "warning", tone: "amber" };
    case "shopify_write":
      return meta.ok === false ? { glyph: "warning", tone: "red" } : { glyph: "shopify", tone: "slate" };
    case "draft_completed":
      return { glyph: "completed", tone: "green" };
    case "draft_deleted":
      return { glyph: "deleted", tone: "amber" };
    case "draft_edited":
      return { glyph: "edit", tone: "slate" };
    case "order_cancelled":
      return { glyph: "cancelled", tone: "red" };
    case "status":
      if (meta.action === "approve") {
        return { glyph: "approve", tone: "green" };
      }
      if (meta.action === "reject") {
        return { glyph: "reject", tone: "red" };
      }
      // Cancel order from the desk, or Shopify's own cancellation
      // (comprehensive design section 2).
      if (meta.action === "cancel" || (event.source === "shopify" && meta.reason === "cancelled")) {
        return { glyph: "cancelled", tone: "red" };
      }
      if (event.source === "shopify" && (meta.reason === "completed" || meta.completed === true)) {
        return { glyph: "completed", tone: "green" };
      }
      return { glyph: "status", tone: "slate" };
    default:
      return { glyph: "status", tone: "slate" };
  }
}
