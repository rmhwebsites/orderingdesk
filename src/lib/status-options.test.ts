import { describe, it, expect } from "vitest";
import type { StatusView } from "@/server/desk/shapes";
import { statusOptionsFor } from "./status-options";

// Which statuses a card's status control offers (draft orders spec section
// 11.5 with section 18 item 5). The server enforces the same rules
// (changeOrderStatus); this keeps impossible choices out of the list.

const status = (key: string, sort: number, shopifyLink: StatusView["shopifyLink"] = null): StatusView => ({
  key,
  label: key.charAt(0).toUpperCase() + key.slice(1),
  color: "slate",
  sort,
  triggersPo: false,
  shopifyLink,
  closed: false,
});

const STATUSES = [
  status("new", 0),
  status("processing", 1),
  status("approved", 2, "draft_completed"),
  status("shipped", 3, "fulfilled"),
  status("delivered", 4, "delivered"),
  status("issue", 5),
  status("rejected", 6, "draft_rejected"),
];
const keys = (list: StatusView[]) => list.map((entry) => entry.key);

describe("statusOptionsFor", () => {
  it("offers a request only the statuses with no Shopify link, plus its own", () => {
    const result = statusOptionsFor({ kind: "draft", role: "staff", currentKey: "new", statuses: STATUSES });
    expect(keys(result.options)).toEqual(["new", "processing", "issue"]);
    expect(result).toMatchObject({ disabled: false, hint: null });
    const rejected = statusOptionsFor({ kind: "draft", role: "manager", currentKey: "rejected", statuses: STATUSES });
    expect(keys(rejected.options)).toEqual(["new", "processing", "issue", "rejected"]);
    expect(rejected.disabled).toBe(false);
  });

  it("locks a rejected request for staff, saying who can reopen it", () => {
    expect(statusOptionsFor({ kind: "draft", role: "staff", currentKey: "rejected", statuses: STATUSES })).toMatchObject({
      disabled: true,
      hint: "Only a manager can reopen a rejected request.",
    });
    expect(statusOptionsFor({ kind: "draft", role: "platform", currentKey: "rejected", statuses: STATUSES }).disabled).toBe(false);
  });

  it("offers an order every status but Rejected, unless it already sits there", () => {
    expect(keys(statusOptionsFor({ kind: "order", role: "staff", currentKey: "new", statuses: STATUSES }).options)).toEqual([
      "new",
      "processing",
      "approved",
      "shipped",
      "delivered",
      "issue",
    ]);
    expect(
      keys(statusOptionsFor({ kind: "order", role: "staff", currentKey: "rejected", statuses: STATUSES }).options),
    ).toContain("rejected");
  });
});
