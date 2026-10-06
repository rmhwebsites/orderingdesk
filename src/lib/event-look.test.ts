import { describe, it, expect } from "vitest";
import { eventLook } from "./event-look";

// One look per event for the drawer timeline and the bell (comprehensive
// desk design section 1).
describe("eventLook", () => {
  it("colors decisions, failures and sends by what they mean", () => {
    expect(eventLook({ type: "status", meta: { action: "approve" }, source: "app" })).toEqual({ glyph: "approve", tone: "green" });
    expect(eventLook({ type: "status", meta: { action: "reject" }, source: "app" })).toEqual({ glyph: "reject", tone: "red" });
    expect(eventLook({ type: "shopify_write", meta: { ok: false }, source: "system" })).toEqual({ glyph: "warning", tone: "red" });
    expect(eventLook({ type: "po_failed", meta: null, source: "system" })).toEqual({ glyph: "warning", tone: "red" });
    expect(eventLook({ type: "sync_error", meta: null, source: "system" })).toEqual({ glyph: "warning", tone: "amber" });
    expect(eventLook({ type: "po_sent", meta: null, source: "app" })).toEqual({ glyph: "po-sent", tone: "blue" });
  });

  it("keeps everyday entries neutral", () => {
    expect(eventLook({ type: "note", meta: null, source: "app" })).toEqual({ glyph: "note", tone: "slate" });
    expect(eventLook({ type: "status", meta: { from: "new", to: "shipped" }, source: "app" })).toEqual({ glyph: "status", tone: "slate" });
    expect(eventLook({ type: "order_new", meta: { kind: "draft" }, source: "shopify" })).toEqual({ glyph: "request", tone: "slate" });
    expect(eventLook({ type: "order_new", meta: null, source: "shopify" })).toEqual({ glyph: "order", tone: "slate" });
    expect(eventLook({ type: "po_draft", meta: null, source: "app" })).toEqual({ glyph: "po", tone: "slate" });
    expect(eventLook({ type: "shopify_write", meta: { ok: true }, source: "system" })).toEqual({ glyph: "shopify", tone: "slate" });
  });

  it("shows a completion in Shopify as an approval and a deleted draft as a warning", () => {
    expect(eventLook({ type: "status", meta: { reason: "completed" }, source: "shopify" })).toEqual({ glyph: "completed", tone: "green" });
    expect(eventLook({ type: "draft_completed", meta: null, source: "shopify" })).toEqual({ glyph: "completed", tone: "green" });
    expect(eventLook({ type: "draft_deleted", meta: null, source: "shopify" })).toEqual({ glyph: "deleted", tone: "amber" });
    // A type added later still gets a neutral look.
    expect(eventLook({ type: "something_new", meta: null, source: "app" })).toEqual({ glyph: "status", tone: "slate" });
  });
});
