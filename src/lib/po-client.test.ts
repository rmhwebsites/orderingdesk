import { describe, it, expect } from "vitest";
import { interpretSendResponse, poDateLine, poStateChip, recipientSummary } from "./po-client";

const po = { id: "po1", state: "sent", number: "IMP-2026-0001" };
const recipients = { to: ["orders@vendor.example"], cc: ["office@impact.example"] };

describe("interpretSendResponse", () => {
  it("reads every answer the send route gives", () => {
    expect(interpretSendResponse(200, { po })).toEqual({ kind: "sent", po });
    expect(interpretSendResponse(200, { po, unchanged: "already-sent" })).toEqual({ kind: "unchanged", po, reason: "already-sent" });
    expect(interpretSendResponse(400, { error: "Confirm who", recipients })).toEqual({ kind: "reconfirm", recipients, message: "Confirm who", po: null });
    expect(interpretSendResponse(409, { error: "Changed", recipients })).toEqual({ kind: "reconfirm", recipients, message: "Changed", po: null });
    expect(interpretSendResponse(409, { error: "Being sent", po })).toEqual({ kind: "busy", message: "Being sent", po });
    // The recipients or the content changed since the review: the PO as it
    // would go out now comes back for a fresh confirmation.
    const fresh = { ...po, state: "draft", notes: "Changed", recipients, contentVersion: "2.abc" };
    expect(interpretSendResponse(409, { error: "Content changed", recipients, contentVersion: "2.abc", po: fresh })).toEqual({
      kind: "reconfirm",
      recipients,
      message: "Content changed",
      po: fresh,
    });
    expect(interpretSendResponse(400, { error: "Confirm what", recipients, contentVersion: "2.abc", po: fresh })).toEqual({
      kind: "reconfirm",
      recipients,
      message: "Confirm what",
      po: fresh,
    });
    expect(interpretSendResponse(502, { error: "The email was not sent: refused", po })).toEqual({
      kind: "failed",
      message: "The email was not sent: refused",
      po,
    });
    expect(interpretSendResponse(400, { error: "Enter a unit cost" })).toEqual({ kind: "error", message: "Enter a unit cost" });
    expect(interpretSendResponse(404, null)).toEqual({ kind: "error", message: "This purchase order is not available to you. Reload the page." });
    expect(interpretSendResponse(500, null)).toEqual({ kind: "error", message: "Something went wrong (HTTP 500). Nothing was sent twice; try again." });
  });
});

describe("recipientSummary", () => {
  it("names the vendor address and the copies in plain words", () => {
    expect(recipientSummary(recipients)).toEqual({ to: "orders@vendor.example", copies: "office@impact.example" });
    expect(recipientSummary({ to: ["a@x.example"], cc: [] })).toEqual({ to: "a@x.example", copies: "No copies" });
    expect(recipientSummary({ to: ["a@x.example"], cc: ["b@x.example", "c@x.example"] }).copies).toBe("b@x.example, c@x.example");
  });
});

describe("poStateChip and poDateLine", () => {
  const base = { sendCount: 0, sentAt: null, createdAt: Date.UTC(2026, 9, 1, 12), updatedAt: Date.UTC(2026, 9, 2, 12) };

  it("labels each state on its semantic tone", () => {
    expect(poStateChip({ ...base, state: "draft" })).toEqual({ tone: "slate", label: "Draft" });
    expect(poStateChip({ ...base, state: "sending" })).toEqual({ tone: "blue", label: "Sending" });
    expect(poStateChip({ ...base, state: "sent", sendCount: 1 })).toEqual({ tone: "green", label: "Sent" });
    expect(poStateChip({ ...base, state: "sent", sendCount: 3 })).toEqual({ tone: "green", label: "Sent 3 times" });
    expect(poStateChip({ ...base, state: "failed" })).toEqual({ tone: "red", label: "Not sent" });
  });

  it("says when, in words", () => {
    expect(poDateLine({ ...base, state: "draft" }, "UTC")).toBe("started Oct 1, 2026");
    expect(poDateLine({ ...base, state: "failed" }, "UTC")).toBe("last tried Oct 2, 2026");
    expect(poDateLine({ ...base, state: "sending" }, "UTC")).toBe("sending now");
    expect(poDateLine({ ...base, state: "sent", sentAt: Date.UTC(2026, 9, 3, 12), sendCount: 1 }, "UTC")).toBe("sent Oct 3, 2026");
  });
});
