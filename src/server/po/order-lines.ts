// The lines a new purchase order starts from (the review modal's prefill).
// The sync stores at most 35 line items per order and marks a partial list
// (itemsTruncated; anything but an explicit false counts as partial). A PO
// is never prefilled from a partial list: the full list is read from
// Shopify on demand, and when that fails the prefill is refused with the
// reason, and the modal blocks Send to vendor until it loads (the reviewer
// may still type lines and save a draft).

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { orders } from "@/db/schema";
import { readSnapshot } from "@/lib/order-snapshot";
import { linesFromOrderItems, PO_LINES_MAX, type PoLine } from "@/lib/po";
import { isRecord } from "@/server/desk/shapes";
import { failureText, fetchAllLineItems } from "@/server/shopify/admin";
import { PO_NEEDS_ORDER } from "./service";
import { getAccessToken } from "@/server/shopify/token";

export type OrderLinesResult =
  | { kind: "ok"; lines: PoLine[]; source: "stored" | "shopify" }
  | { kind: "not-found" }
  // A request that is still a draft has no order lines to buy (409).
  | { kind: "draft"; error: string }
  | { kind: "unavailable"; error: string };

const PARTIAL = "This order has more items than Ordering Desk stores";

export async function orderLinesForPo(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  input: { workspaceId: string; orderId: string },
  opts?: { fetchImpl?: typeof fetch },
): Promise<OrderLinesResult> {
  const rows = await db
    .select({ shopify: orders.shopify, shopifyOrderId: orders.shopifyOrderId })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.workspaceId, input.workspaceId)))
    .limit(1);
  const order = rows[0];
  if (!order) {
    return { kind: "not-found" };
  }
  if (order.shopifyOrderId === null) {
    return { kind: "draft", error: PO_NEEDS_ORDER };
  }
  const complete = isRecord(order.shopify) && order.shopify.itemsTruncated === false;
  if (complete) {
    return { kind: "ok", lines: linesFromOrderItems(readSnapshot(order.shopify).items), source: "stored" };
  }

  const token = await getAccessToken(db, env, input.workspaceId, opts);
  if (token.kind !== "ok") {
    const reason =
      token.kind === "unavailable"
        ? token.reason === "disabled"
          ? "the store is disconnected"
          : "no Shopify store is connected"
        : token.kind === "transient"
          ? token.detail
          : token.kind === "rejected"
            ? `Shopify rejected the store credentials (${token.detail})`
            : "the store credentials cannot be read";
    return { kind: "unavailable", error: `${PARTIAL}, and the full list could not be read: ${reason}.` };
  }
  const result = await fetchAllLineItems(token.shopDomain, token.token, `gid://shopify/Order/${order.shopifyOrderId}`, opts?.fetchImpl);
  if (result.kind !== "ok") {
    return { kind: "unavailable", error: `${PARTIAL}, and the full list could not be read from Shopify: ${failureText(result)}.` };
  }
  if (result.items === null) {
    return { kind: "unavailable", error: "Shopify no longer has this order, so its full item list cannot be read." };
  }
  if (!result.complete || result.items.length > PO_LINES_MAX) {
    return {
      kind: "unavailable",
      error: `This order has more items than one purchase order holds (${PO_LINES_MAX} lines). Type the lines for this vendor instead.`,
    };
  }
  return { kind: "ok", lines: linesFromOrderItems(result.items), source: "shopify" };
}
