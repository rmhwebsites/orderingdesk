import { describe, it, expect } from "vitest";
import type { StatusView } from "@/server/desk/shapes";
import { checkStatusMove, planBulkMove } from "./status-rules";

const status = (label: string, shopifyLink: string | null = null) => ({ label, shopifyLink });

describe("checkStatusMove", () => {
  it("lets a request move between unlinked statuses, staff included", () => {
    expect(checkStatusMove({ isDraft: true, role: "staff", current: status("New"), target: status("On Hold") })).toEqual({ ok: true });
  });

  it("keeps a request out of fulfilled, delivered, Draft approved and Draft rejected statuses", () => {
    const move = (target: { label: string; shopifyLink: string | null }) =>
      checkStatusMove({ isDraft: true, role: "manager", current: status("New"), target });
    expect(move(status("Shipped", "fulfilled"))).toEqual({
      ok: false,
      forbidden: false,
      error: "A draft cannot be marked Shipped until it is approved and becomes an order.",
    });
    expect(move(status("Delivered", "delivered"))).toMatchObject({ ok: false });
    expect(move(status("Approved", "draft_completed"))).toEqual({
      ok: false,
      forbidden: false,
      error: "Use Approve to approve this request. It creates the order in Shopify.",
    });
    expect(move(status("Rejected", "draft_rejected"))).toEqual({
      ok: false,
      forbidden: false,
      error: "Use Reject to reject this request. It asks for a reason.",
    });
  });

  it("lets only a manager reopen a rejected request", () => {
    const current = status("Rejected", "draft_rejected");
    expect(checkStatusMove({ isDraft: true, role: "staff", current, target: status("New") })).toEqual({
      ok: false,
      forbidden: true,
      error: "Only a manager can reopen a rejected request.",
    });
    expect(checkStatusMove({ isDraft: true, role: "manager", current, target: status("New") })).toEqual({ ok: true });
  });

  it("keeps an order out of Rejected and lets it go anywhere else", () => {
    expect(checkStatusMove({ isDraft: false, role: "staff", current: status("New"), target: status("Rejected", "draft_rejected") })).toEqual({
      ok: false,
      forbidden: false,
      error: "Rejected is for requests that are still drafts.",
    });
    expect(checkStatusMove({ isDraft: false, role: "staff", current: status("New"), target: status("Shipped", "fulfilled") })).toEqual({ ok: true });
  });
});

describe("planBulkMove", () => {
  it("says which selected cards will stay, and why", () => {
    const statuses: StatusView[] = [
      { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
      { key: "shipped", label: "Shipped", color: "violet", sort: 1, triggersPo: false, shopifyLink: "fulfilled", closed: false },
    ];
    const plan = planBulkMove(
      [
        { id: "o1", name: "#1001", customerName: "Jordan Vale", kind: "order", statusKey: "new" },
        { id: "d1", name: "#D12", customerName: "Casey Lin", kind: "draft", statusKey: "new" },
        { id: "o2", name: "#1002", customerName: "Sam Ortiz", kind: "order", statusKey: "shipped" },
      ],
      statuses[1],
      statuses,
      "staff",
    );
    expect(plan.map((row) => [row.card.id, row.stays])).toEqual([
      ["o1", null],
      ["d1", "A draft cannot be marked Shipped until it is approved and becomes an order."],
      ["o2", "Already in Shipped."],
    ]);
  });
});
