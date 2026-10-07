// Cancel an order and edit a request through an AI app (comprehensive desk
// design sections 2 and 4): managers and platform admins, prepare then
// confirm, on Wave 1b's services (cancelOrder, loadRequestEditor and
// editRequest), which check everything again and send to Shopify once.
// prepare_cancel reads the order's cancel state (read only) and refuses an
// order that is not $0.00; prepare_edit_request turns line numbers and a
// location name into Wave 1b's edit body and stores it, so confirm sends
// exactly what was previewed (editRequest refuses a draft Shopify changed
// since, by its updatedAt). Relative imports only.

import * as z from "zod";
import { formatMoney } from "../../lib/format";
import { NOTE_MAX } from "../../lib/limits";
import { EDIT_LINES_MAX, EDIT_QUANTITY_MAX, parseEditBody, summarizeEdit, type EditRequestBody } from "../../lib/request-edit";
import { roleAtLeast } from "../../lib/roles";
import { CANCEL_COPY, cancelOrder, followCancellation } from "../../server/desk/cancel-order";
import { editRequest, followEdit, loadRequestEditor } from "../../server/desk/edit-request";
import { linkedStatus, shopifyAccess } from "../../server/desk/review";
import { failureText, fetchOrderCancelState } from "../../server/shopify/admin";
import { beginConfirm, cardState, finishAction, prepareAction, preparedResult, stateMatches } from "../actions";
import { plainText, untrusted } from "../output";
import { findCard, loadCardById } from "./cards";
import { confirmationInput, followDeps, orderInput, orderMismatch, refusal, reviewCtx, reviewDeps, textMismatch } from "./common";
import { CONFIRM_DESTRUCTIVE, PREPARE, defineTool, fail, ok } from "./define";

type CancelPayload = { order: string; reason: string; cancelledLabel: string };
type EditPayload = { order: string; body: EditRequestBody; changes: string[] };

export const prepareCancel = defineTool({
  name: "prepare_cancel",
  title: "Prepare a cancellation",
  description:
    "Previews cancelling one approved order in Shopify with a reason: no email to the customer, no restock, no refund, $0.00 orders only. Reads the order from Shopify and changes nothing; returns a confirmation for confirm_cancel.",
  minRole: "manager",
  needsWrite: true,
  counts: "read",
  annotations: PREPARE,
  input: z.object({ order: orderInput, reason: z.string().min(1).max(NOTE_MAX).describe("Why the order is cancelled; saved as a note") }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    if (!roleAtLeast(p.role, "manager")) {
      return fail("forbidden", CANCEL_COPY.forbidden);
    }
    const reason = args.reason.trim();
    if (reason.length === 0) {
      return fail("invalid_input", CANCEL_COPY.reason);
    }
    const card = await findCard(deps.db, p.workspaceId, args.order);
    if (!card) {
      return fail("not_found", `No order ${plainText(args.order, 64)} in this workspace.`);
    }
    const target = { kind: "order" as const, id: card.id };
    if (card.shopifyOrderId === null) {
      return fail("invalid_input", CANCEL_COPY.draft, target);
    }
    const cancelled = await linkedStatus(deps.db, p.workspaceId, "cancelled");
    if (!cancelled) {
      return fail("refused", CANCEL_COPY.noStatus, target);
    }
    if (card.statusKey === cancelled.key) {
      return fail("invalid_input", `${card.name} is already cancelled.`, target);
    }
    const granted = await shopifyAccess(deps.db, p.workspaceId, reviewDeps(deps));
    if (granted.kind !== "ok") {
      return refusal(granted.status, granted.error, target);
    }
    const { access } = granted;
    const read = await fetchOrderCancelState(access.shopDomain, access.token, `gid://shopify/Order/${card.shopifyOrderId}`, access.fetchImpl);
    if (read.kind !== "ok") {
      return fail("shopify_unavailable", `Could not read the order in Shopify (${plainText(failureText(read), 200)}). Nothing changed.`, target);
    }
    if (read.order === null) {
      return fail("refused", CANCEL_COPY.gone, target);
    }
    const warnings: string[] = [];
    if (read.order.cancelledAt !== null) {
      warnings.push("Shopify already shows this order cancelled; confirming only moves the card to Cancelled.");
    } else {
      const total = read.order.total;
      if (total === null || total.trim().length === 0 || Number(total) !== 0) {
        const amount = total ? formatMoney(total, read.order.currency) : "an amount Shopify did not report";
        return fail("refused", `This order totals ${amount}. Ordering Desk only cancels orders that total $0.00, because it never refunds. Cancel it in Shopify instead.`, target);
      }
      if (read.order.fulfillment === "FULFILLED" || read.order.fulfillment === "PARTIALLY_FULFILLED") {
        warnings.push("Items on this order are fulfilled; Shopify may refuse to cancel it.");
      }
    }
    const payload: CancelPayload = { order: card.name, reason, cancelledLabel: cancelled.label };
    const prepared = await prepareAction(deps.db, p, { tool: "cancel", targetId: card.id, payload, state: cardState(card) }, deps.now());
    return preparedResult(
      prepared,
      {
        summary: `Cancel order ${card.name} in Shopify: no email to the customer, no restock, no refund. Status becomes ${plainText(cancelled.label, 80)}.`,
        details: { order: card.name, reason: untrusted(reason) },
        warnings,
        confirm: { tool: "confirm_cancel", fields: { order: card.name, reason } },
      },
      target,
    );
  },
});

export const confirmCancel = defineTool({
  name: "confirm_cancel",
  title: "Confirm a cancellation",
  description: "Cancels the order prepared by prepare_cancel in Shopify, once. Repeat the order number and the reason exactly as the preview showed them.",
  minRole: "manager",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_DESTRUCTIVE,
  input: z.object({ confirmation_id: confirmationInput, order: orderInput, reason: z.string().min(1).max(NOTE_MAX) }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const start = await beginConfirm<CancelPayload>(deps, {
      id: args.confirmation_id,
      tool: "cancel",
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
      return fail("changed", `${payload.order} changed since the preview. Prepare the cancellation again.`, target);
    }
    const result = await cancelOrder(deps.db, reviewCtx(p, card.id), { reason: payload.reason }, reviewDeps(deps));
    switch (result.kind) {
      case "cancelled":
        await finishAction(deps.db, action.id, "done", "ok");
        deps.after(() => followCancellation(deps.db, deps.env, p.workspaceId, card.id, result, followDeps(deps)));
        return ok({ done: true, order: card.name, status: plainText(payload.cancelledLabel, 80), confirmed_by_shopify: result.confirmed }, target);
      case "cancelled-in-shopify":
        await finishAction(deps.db, action.id, "done", "cancelled_in_shopify");
        deps.after(() => followCancellation(deps.db, deps.env, p.workspaceId, card.id, result, followDeps(deps)));
        return ok({ done: true, order: card.name, message: result.message }, target);
      case "already-cancelled":
        await finishAction(deps.db, action.id, "done", "unchanged");
        return ok({ done: true, order: card.name, message: "It was already cancelled." }, target);
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

export const prepareEditRequest = defineTool({
  name: "prepare_edit_request",
  title: "Prepare a request edit",
  description:
    "Previews editing one request before approval: change a line's quantity (0 removes the line, one line must stay) and switch the ship-to among the company's locations. No new items, sizes or personalization. Reads the draft from Shopify and changes nothing; returns a confirmation for confirm_edit_request.",
  minRole: "manager",
  needsWrite: true,
  counts: "read",
  annotations: PREPARE,
  input: z
    .object({
      order: orderInput,
      changes: z
        .array(z.object({ line: z.number().int().min(1).max(EDIT_LINES_MAX).describe("The line number get_order lists"), quantity: z.number().int().min(0).max(EDIT_QUANTITY_MAX) }).strict())
        .max(EDIT_LINES_MAX),
      ship_to: z.string().min(1).max(80).optional().describe("A company location name or id from list_locations"),
    })
    .strict(),
  async run(args, deps) {
    const p = deps.principal;
    if (!roleAtLeast(p.role, "manager")) {
      return fail("forbidden", "Only a manager can edit requests.");
    }
    const card = await findCard(deps.db, p.workspaceId, args.order);
    if (!card) {
      return fail("not_found", `No request ${plainText(args.order, 64)} in this workspace.`);
    }
    const target = { kind: "order" as const, id: card.id };
    if (card.shopifyOrderId !== null) {
      return fail("invalid_input", `${card.name} is already an order; only requests are edited.`, target);
    }
    const loaded = await loadRequestEditor(deps.db, reviewCtx(p, card.id), reviewDeps(deps));
    if (loaded.kind === "not-found") {
      return fail("not_found", `No request ${card.name} in this workspace.`, target);
    }
    if (loaded.kind === "forbidden") {
      return fail("forbidden", loaded.error, target);
    }
    if (loaded.kind === "refused") {
      return refusal(loaded.status, loaded.error, target);
    }
    const { editor } = loaded;
    const quantities = new Map(editor.lines.map((line) => [line.uuid, line.quantity]));
    const seen = new Set<number>();
    for (const change of args.changes) {
      const line = editor.lines[change.line - 1];
      if (!line) {
        return fail("invalid_input", `There is no line ${change.line}; this request has ${editor.lines.length} lines.`, target);
      }
      if (seen.has(change.line)) {
        return fail("invalid_input", `Line ${change.line} is listed twice.`, target);
      }
      seen.add(change.line);
      if (change.quantity === 0) {
        quantities.delete(line.uuid);
      } else {
        quantities.set(line.uuid, change.quantity);
      }
    }
    let locationId: string | null = null;
    if (args.ship_to) {
      const wanted = args.ship_to.trim().toLowerCase();
      const found = editor.locations.find((option) => option.shopifyLocationId === args.ship_to!.trim() || option.name.toLowerCase() === wanted);
      if (!found) {
        return fail("invalid_input", `Unknown company location. Locations: ${editor.locations.map((option) => option.name).join(", ")}.`, target);
      }
      locationId = found.shopifyLocationId !== editor.locationId ? found.shopifyLocationId : null;
    }
    const parsed = parseEditBody({
      updatedAt: editor.updatedAt,
      lines: editor.lines.filter((line) => quantities.has(line.uuid)).map((line) => ({ uuid: line.uuid, quantity: quantities.get(line.uuid) })),
      locationId,
    });
    if ("error" in parsed) {
      return fail("invalid_input", parsed.error, target);
    }
    const summary = summarizeEdit(editor, parsed);
    if (summary.changes.length === 0) {
      return fail("invalid_input", "Nothing would change.", target);
    }
    const changes = summary.changes.map((change) => plainText(change, 300));
    const payload: EditPayload = { order: card.name, body: parsed, changes };
    const prepared = await prepareAction(deps.db, p, { tool: "edit", targetId: card.id, payload, state: cardState(card) }, deps.now());
    return preparedResult(
      prepared,
      {
        summary: `Edit request ${card.name}: ${changes.join("; ")}`,
        details: {
          order: card.name,
          before: { lines: summary.before.lines.map((line) => plainText(line, 200)), ship_to: plainText(summary.before.shipTo, 120) },
          after: { lines: summary.after.lines.map((line) => plainText(line, 200)), ship_to: plainText(summary.after.shipTo, 120) },
        },
        confirm: { tool: "confirm_edit_request", fields: { order: card.name } },
      },
      target,
    );
  },
});

export const confirmEditRequest = defineTool({
  name: "confirm_edit_request",
  title: "Confirm a request edit",
  description: "Saves the edit prepared by prepare_edit_request to Shopify, once. Repeat the request number exactly as the preview showed it.",
  minRole: "manager",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_DESTRUCTIVE,
  input: z.object({ confirmation_id: confirmationInput, order: orderInput }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const start = await beginConfirm<EditPayload>(deps, { id: args.confirmation_id, tool: "edit", echo: (stored) => orderMismatch(args.order, stored.order) });
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
      return fail("changed", `${payload.order} changed since the preview. Prepare the edit again.`, target);
    }
    const result = await editRequest(deps.db, reviewCtx(p, card.id), payload.body, reviewDeps(deps));
    switch (result.kind) {
      case "edited":
        await finishAction(deps.db, action.id, "done", "ok");
        deps.after(() => followEdit(deps.db, deps.env, p.workspaceId, card.id, result, followDeps(deps)));
        return ok({ done: true, order: card.name, changes: payload.changes, warning: result.warning ? plainText(result.warning, 300) : null }, target);
      case "unchanged":
        await finishAction(deps.db, action.id, "done", "unchanged");
        return ok({ done: true, order: card.name, message: "Shopify already had these quantities and ship-to." }, target);
      case "refused": {
        const stale = "editor" in result && result.editor !== undefined;
        await finishAction(deps.db, action.id, "failed", stale ? "changed" : "refused");
        return stale ? fail("changed", `${result.error} Prepare the edit again.`, target) : refusal(result.status, result.error, target);
      }
      case "invalid":
        await finishAction(deps.db, action.id, "failed", "invalid_input");
        return fail("invalid_input", result.error, target);
      case "forbidden":
        await finishAction(deps.db, action.id, "failed", "forbidden");
        return fail("forbidden", result.error, target);
      case "not-found":
        await finishAction(deps.db, action.id, "failed", "not_found");
        return fail("not_found", `${payload.order} is no longer in this workspace.`, target);
    }
  },
});
