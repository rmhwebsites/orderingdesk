// Approve and Reject through an AI app (comprehensive desk design section
// 4): managers and platform admins, prepare then confirm, on the app's own
// services (src/server/desk/review.ts) with their own checks repeated at
// confirm time. prepare_approve reads the draft from Shopify (read only)
// and refuses anything but an open $0 draft. There is no proof warning
// (owner decision 4, Oct 7: personalization is confirmed by the person when
// the request is placed). Relative imports only.

import * as z from "zod";
import { broadcast, broadcastSync } from "../../server/broadcast";
import { formatMoney } from "../../lib/format";
import { NOTE_MAX } from "../../lib/limits";
import { requestFieldsOf } from "../../lib/request-fields";
import { roleAtLeast } from "../../lib/roles";
import { REVIEW_COPY, approveRequest, followApproval, followRejection, linkedStatus, rejectRequest, shopifyAccess } from "../../server/desk/review";
import { draftGid, failureText, fetchDraftForApprove } from "../../server/shopify/admin";
import { beginConfirm, cardState, finishAction, prepareAction, preparedResult, stateMatches } from "../actions";
import { personLabel, plainText, untrusted, NAME_MAX } from "../output";
import { findCard, loadCardById, type CardRow } from "./cards";
import { PO_NOTE, confirmationInput, followDeps, orderInput, orderMismatch, refusal, reviewCtx, reviewDeps, textMismatch } from "./common";
import { CONFIRM_DESTRUCTIVE, PREPARE, defineTool, fail, ok, type ToolDeps } from "./define";

type ApprovePayload = { order: string; approvedLabel: string };
type RejectPayload = { order: string; reason: string; rejectedLabel: string };

async function requestCard(deps: ToolDeps, ref: string): Promise<{ card: CardRow } | { error: ReturnType<typeof fail> }> {
  const p = deps.principal;
  if (!roleAtLeast(p.role, "manager")) {
    return { error: fail("forbidden", REVIEW_COPY.forbidden) };
  }
  const card = await findCard(deps.db, p.workspaceId, ref);
  if (!card) {
    return { error: fail("not_found", `No request ${plainText(ref, 64)} in this workspace.`) };
  }
  if (card.shopifyOrderId !== null) {
    return { error: fail("invalid_input", `${card.name} is already an order, so it cannot be approved or rejected.`, { kind: "order", id: card.id }) };
  }
  return { card };
}

// "For Employee Name" is a person's name only when it reads as one
// (personLabel, Decision 13): a typed email or phone number is left out, as
// get_order leaves it out.
function whoAndWhere(card: CardRow): { forPerson: string; location: string } {
  const fields = requestFieldsOf(card.shopify, card.draftSnapshot);
  return { forPerson: personLabel(fields.requestFor) ?? "", location: plainText(fields.branch || fields.location, NAME_MAX) };
}

export const prepareApprove = defineTool({
  name: "prepare_approve",
  title: "Prepare an approval",
  description:
    "Previews approving one request: Shopify completes its $0.00 draft and the card becomes that order. Reads the draft from Shopify and changes nothing; returns a confirmation for confirm_approve.",
  minRole: "manager",
  needsWrite: true,
  counts: "read",
  annotations: PREPARE,
  input: z.object({ order: orderInput }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const found = await requestCard(deps, args.order);
    if ("error" in found) {
      return found.error;
    }
    const { card } = found;
    const target = { kind: "order" as const, id: card.id };
    if (card.draftDeletedAt !== null || !card.shopifyDraftId) {
      return fail("refused", REVIEW_COPY.deleted, target);
    }
    const approved = await linkedStatus(deps.db, p.workspaceId, "draft_completed");
    if (!approved) {
      return fail("refused", REVIEW_COPY.noApprovedStatus, target);
    }
    const granted = await shopifyAccess(deps.db, p.workspaceId, reviewDeps(deps));
    if (granted.kind !== "ok") {
      return refusal(granted.status, granted.error, target);
    }
    const { access } = granted;
    const read = await fetchDraftForApprove(access.shopDomain, access.token, draftGid(card.shopifyDraftId), access.fetchImpl);
    if (read.kind !== "ok") {
      return fail("shopify_unavailable", `Could not read the draft in Shopify (${plainText(failureText(read), 200)}). Nothing changed.`, target);
    }
    if (read.draft === null) {
      return fail("refused", REVIEW_COPY.deleted, target);
    }
    if (read.draft.status === "COMPLETED") {
      return fail("refused", REVIEW_COPY.completedElsewhere, target);
    }
    const total = read.draft.total;
    if (total === null || total.trim().length === 0 || Number(total) !== 0) {
      const amount = total ? formatMoney(total, read.draft.currency) : "an amount Shopify did not report";
      return fail("refused", `Shopify reports ${amount} for this request. Ordering Desk only approves requests that total $0.00. Complete it in Shopify instead.`, target);
    }
    const { forPerson, location } = whoAndWhere(card);
    const payload: ApprovePayload = { order: card.name, approvedLabel: approved.label };
    const prepared = await prepareAction(deps.db, p, { tool: "approve", targetId: card.id, payload, state: cardState(card) }, deps.now());
    const warnings = [
      ...(read.draft.ready ? [] : ["Shopify is still calculating this draft; the confirm checks it again."]),
      ...(approved.triggersPo ? [PO_NOTE] : []),
    ];
    return preparedResult(
      prepared,
      {
        summary: `Approve request ${card.name}${forPerson ? ` for ${forPerson}` : ""}${location ? ` at ${location}` : ""}: Shopify completes the $0.00 draft and it becomes an order. Status becomes ${plainText(approved.label, 80)}.`,
        details: { order: card.name, for_person: forPerson || null, location: location || null, total: `0.00 ${read.draft.currency}` },
        warnings,
        confirm: { tool: "confirm_approve", fields: { order: card.name } },
      },
      target,
    );
  },
});

export const confirmApprove = defineTool({
  name: "confirm_approve",
  title: "Confirm an approval",
  description: "Approves the request prepared by prepare_approve, once: Shopify completes the $0.00 draft and the card becomes the order. Repeat the request number exactly as the preview showed it.",
  minRole: "manager",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_DESTRUCTIVE,
  input: z.object({ confirmation_id: confirmationInput, order: orderInput }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const start = await beginConfirm<ApprovePayload>(deps, { id: args.confirmation_id, tool: "approve", echo: (stored) => orderMismatch(args.order, stored.order) });
    if (!start.ok) {
      return start.outcome;
    }
    const { action, payload } = start;
    const card = await loadCardById(deps.db, p.workspaceId, action.targetId);
    if (!card) {
      await finishAction(deps.db, action.id, "failed", "not_found");
      return fail("not_found", `${payload.order} is no longer in this workspace.`);
    }
    const target = { kind: "order" as const, id: card.id };
    if (!(await stateMatches(action, cardState(card)))) {
      await finishAction(deps.db, action.id, "failed", "changed");
      return fail("changed", `${payload.order} changed since the preview. Prepare the approval again to see it as it is now.`, target);
    }
    const result = await approveRequest(deps.db, reviewCtx(p, card.id), reviewDeps(deps));
    switch (result.kind) {
      case "approved":
        await finishAction(deps.db, action.id, "done", "ok");
        deps.after(() => followApproval(deps.db, deps.env, p.workspaceId, card.id, result.follow, followDeps(deps)));
        return ok(
          {
            done: true,
            order: result.orderName,
            from_request: payload.order,
            status: plainText(payload.approvedLabel, 80),
            purchase_order: result.triggersPo ? PO_NOTE : null,
            message: `Approved. ${payload.order} is now order ${result.orderName}.`,
          },
          target,
        );
      case "completed-in-shopify":
        await finishAction(deps.db, action.id, "done", "completed_in_shopify");
        deps.after(() => followApproval(deps.db, deps.env, p.workspaceId, card.id, result.follow, followDeps(deps)));
        return ok({ done: true, order: result.orderName, message: result.message }, target);
      case "already-approved":
        await finishAction(deps.db, action.id, "done", "unchanged");
        return ok({ done: true, order: result.orderName, message: "It was already approved." }, target);
      case "refused": {
        await finishAction(deps.db, action.id, "failed", "refused");
        const deleted = result.deleted;
        if (deleted) {
          deps.after(async () => {
            await broadcastSync(deps.env, p.workspaceId, { addedOrderIds: [], updatedOrderIds: [deleted.orderId] });
            await broadcast(deps.env, p.workspaceId, { kind: "order.activity", event: deleted.event });
          });
        }
        return refusal(result.status, result.error, target);
      }
      case "forbidden":
        await finishAction(deps.db, action.id, "failed", "forbidden");
        return fail("forbidden", result.error, target);
      case "not-found":
        await finishAction(deps.db, action.id, "failed", "not_found");
        return fail("not_found", `${payload.order} is no longer in this workspace.`, target);
    }
  },
});

export const prepareReject = defineTool({
  name: "prepare_reject",
  title: "Prepare a rejection",
  description: "Previews rejecting one request with a reason, which is saved as a note. Nobody is emailed and nothing is deleted. Changes nothing; returns a confirmation for confirm_reject.",
  minRole: "manager",
  needsWrite: true,
  counts: "read",
  annotations: PREPARE,
  input: z.object({ order: orderInput, reason: z.string().min(1).max(NOTE_MAX).describe("Why the request is rejected") }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const reason = args.reason.trim();
    if (reason.length === 0) {
      return fail("invalid_input", REVIEW_COPY.reason);
    }
    const found = await requestCard(deps, args.order);
    if ("error" in found) {
      return found.error;
    }
    const { card } = found;
    const target = { kind: "order" as const, id: card.id };
    const rejected = await linkedStatus(deps.db, p.workspaceId, "draft_rejected");
    if (!rejected) {
      return fail("refused", REVIEW_COPY.noRejectedStatus, target);
    }
    if (card.statusKey === rejected.key) {
      return fail("invalid_input", `${card.name} is already rejected.`, target);
    }
    const payload: RejectPayload = { order: card.name, reason, rejectedLabel: rejected.label };
    const prepared = await prepareAction(deps.db, p, { tool: "reject", targetId: card.id, payload, state: cardState(card) }, deps.now());
    return preparedResult(
      prepared,
      {
        summary: `Reject request ${card.name}: status becomes ${plainText(rejected.label, 80)} and the reason is saved as a note. Shopify gets only the status tag; nobody is emailed.`,
        details: { order: card.name, reason: untrusted(reason) },
        confirm: { tool: "confirm_reject", fields: { order: card.name, reason } },
      },
      target,
    );
  },
});

export const confirmReject = defineTool({
  name: "confirm_reject",
  title: "Confirm a rejection",
  description: "Rejects the request prepared by prepare_reject, once. Repeat the request number and the reason exactly as the preview showed them.",
  minRole: "manager",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_DESTRUCTIVE,
  input: z.object({ confirmation_id: confirmationInput, order: orderInput, reason: z.string().min(1).max(NOTE_MAX) }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const start = await beginConfirm<RejectPayload>(deps, {
      id: args.confirmation_id,
      tool: "reject",
      echo: (stored) => orderMismatch(args.order, stored.order) ?? textMismatch("reason", args.reason, stored.reason),
    });
    if (!start.ok) {
      return start.outcome;
    }
    const { action, payload } = start;
    const card = await loadCardById(deps.db, p.workspaceId, action.targetId);
    if (!card) {
      await finishAction(deps.db, action.id, "failed", "not_found");
      return fail("not_found", `${payload.order} is no longer in this workspace.`);
    }
    const target = { kind: "order" as const, id: card.id };
    if (!(await stateMatches(action, cardState(card)))) {
      await finishAction(deps.db, action.id, "failed", "changed");
      return fail("changed", `${payload.order} changed since the preview. Prepare the rejection again.`, target);
    }
    const result = await rejectRequest(deps.db, reviewCtx(p, card.id), { reason: payload.reason }, { now: deps.now });
    switch (result.kind) {
      case "rejected":
        await finishAction(deps.db, action.id, "done", "ok");
        deps.after(() => followRejection(deps.db, deps.env, p.workspaceId, card.id, result, followDeps(deps)));
        return ok({ done: true, order: card.name, status: plainText(payload.rejectedLabel, 80) }, target);
      case "unchanged":
        await finishAction(deps.db, action.id, "done", "unchanged");
        return ok({ done: true, order: card.name, message: "It was already rejected." }, target);
      case "invalid":
        await finishAction(deps.db, action.id, "failed", "invalid_input");
        return fail("invalid_input", result.error, target);
      case "refused":
        await finishAction(deps.db, action.id, "failed", "refused");
        return refusal(result.status, result.error, target);
      case "forbidden":
        await finishAction(deps.db, action.id, "failed", "forbidden");
        return fail("forbidden", result.error, target);
      case "not-found":
        await finishAction(deps.db, action.id, "failed", "not_found");
        return fail("not_found", `${payload.order} is no longer in this workspace.`, target);
    }
  },
});
