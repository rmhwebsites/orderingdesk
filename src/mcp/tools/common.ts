// Shared by the MCP write tools: the context the desk services take (the
// person's live role and "via" the app, so their entries say source ai),
// Shopify deps, echo sentences, refusal mapping and the confirm inputs.
// Relative imports only.

import * as z from "zod";
import type { ReviewContext, ReviewDeps } from "../../server/desk/review";
import { sameOrderNumber, sameText } from "../echo";
import { plainText } from "../output";
import type { Principal } from "../types";
import { fail, type ToolDeps, type ToolOutcome } from "./define";

export const PO_NOTE = "This status starts a purchase order. Create and send it in Ordering Desk; purchase orders are never sent automatically.";

export function reviewCtx(p: Principal, orderId: string): ReviewContext {
  return { workspaceId: p.workspaceId, orderId, userId: p.userId, role: p.role, via: { client: p.client } };
}

export function reviewDeps(deps: ToolDeps): ReviewDeps {
  return { env: deps.env, now: deps.now, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
}

export function followDeps(deps: ToolDeps): { fetchImpl?: typeof fetch; now: () => number; sleep?: (ms: number) => Promise<void> } {
  return { now: deps.now, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
}

export function orderMismatch(given: string, stored: string): string | null {
  return sameOrderNumber(given, stored) ? null : `This confirmation is for ${stored}, not ${plainText(given, 64)}.`;
}

export function textMismatch(what: string, given: string, stored: string): string | null {
  return sameText(given, stored) ? null : `The ${what} does not match the preview.`;
}

// A desk service's refusal: 502 means Shopify did not answer.
export function refusal(status: number, error: string, target?: { kind: "order"; id: string }): ToolOutcome {
  return fail(status >= 500 ? "shopify_unavailable" : "refused", error, target);
}

export const orderInput = z.string().min(1).max(64).describe("An order number like #1024 or a request number like #D19");
export const confirmationInput = z.string().min(1).max(64).describe("confirmation_id from the matching prepare tool");
