// Status changes and notes through an AI app (comprehensive desk design
// section 4): staff and up, prepare then confirm, the same rules and
// services as the app (Wave 1a's checkStatusMove, changeOrderStatus,
// addOrderNote) and the same follow-ups after the answer. Relative imports
// only.

import * as z from "zod";
import { NOTE_MAX } from "../../lib/limits";
import { checkStatusMove } from "../../lib/status-rules";
import { followNote, followStatusChange } from "../../server/desk/follow";
import { addOrderNote, changeOrderStatus } from "../../server/desk/mutations";
import { beginConfirm, finishAction, prepareAction, preparedResult, stateMatches } from "../actions";
import { plainText, untrusted } from "../output";
import { findCard, loadCardById, statusRowsOf } from "./cards";
import { PO_NOTE, confirmationInput, followDeps, orderInput, orderMismatch, reviewCtx, textMismatch } from "./common";
import { CONFIRM_ADDITIVE, CONFIRM_DESTRUCTIVE, PREPARE, defineTool, fail, ok } from "./define";

type StatusPayload = { order: string; statusKey: string; statusLabel: string; fromLabel: string };
type NotePayload = { order: string; text: string };

export const prepareStatusChange = defineTool({
  name: "prepare_status_change",
  title: "Prepare a status change",
  description:
    "Previews moving one card to another status, with the app's own rules (Approve, Reject and Cancel have their own tools). Changes nothing; returns a confirmation for confirm_status_change.",
  minRole: "staff",
  needsWrite: true,
  counts: "read",
  annotations: PREPARE,
  input: z.object({ order: orderInput, status: z.string().min(1).max(80).describe("A status name or key from list_statuses") }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const card = await findCard(deps.db, p.workspaceId, args.order);
    if (!card) {
      return fail("not_found", `No order or request ${plainText(args.order, 64)} in this workspace.`);
    }
    const target = { kind: "order" as const, id: card.id };
    const rows = await statusRowsOf(deps.db, p.workspaceId);
    const wanted = args.status.trim().toLowerCase();
    const next = rows.find((row) => row.key === args.status.trim() || row.label.toLowerCase() === wanted);
    if (!next) {
      return fail("invalid_input", `No status is called "${plainText(args.status, 80)}". Statuses: ${rows.map((row) => row.label).join(", ")}.`, target);
    }
    const current = rows.find((row) => row.key === card.statusKey);
    if (next.key === card.statusKey) {
      return fail("invalid_input", `${card.name} is already ${next.label}.`, target);
    }
    const isDraft = card.shopifyOrderId === null;
    const check = checkStatusMove({ isDraft, role: p.role, current, target: next });
    if (!check.ok) {
      return fail(check.forbidden ? "forbidden" : "invalid_input", check.error, target);
    }
    const fromLabel = current?.label ?? card.statusKey;
    const payload: StatusPayload = { order: card.name, statusKey: next.key, statusLabel: next.label, fromLabel };
    const prepared = await prepareAction(deps.db, p, { tool: "status", targetId: card.id, payload, state: card.statusKey }, deps.now());
    const warnings = [
      ...(!isDraft && next.shopifyLink === "fulfilled" ? ["Moving an order here creates a fulfillment in Shopify (the customer is not emailed)."] : []),
      ...(!isDraft && next.triggersPo ? [PO_NOTE] : []),
    ];
    return preparedResult(
      prepared,
      {
        summary: `Change ${card.name} from ${plainText(fromLabel, 80)} to ${plainText(next.label, 80)}`,
        details: { order: card.name, from: plainText(fromLabel, 80), to: plainText(next.label, 80) },
        warnings,
        confirm: { tool: "confirm_status_change", fields: { order: card.name, status: plainText(next.label, 80) } },
      },
      target,
    );
  },
});

export const confirmStatusChange = defineTool({
  name: "confirm_status_change",
  title: "Confirm a status change",
  description: "Carries out a status change prepared by prepare_status_change, once. Repeat the order and status exactly as the preview showed them.",
  minRole: "staff",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_DESTRUCTIVE,
  input: z.object({ confirmation_id: confirmationInput, order: orderInput, status: z.string().min(1).max(80) }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const start = await beginConfirm<StatusPayload>(deps, {
      id: args.confirmation_id,
      tool: "status",
      echo: (stored) => orderMismatch(args.order, stored.order) ?? textMismatch("status", args.status, stored.statusLabel),
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
    if (!(await stateMatches(action, card.statusKey))) {
      await finishAction(deps.db, action.id, "failed", "changed");
      return fail("changed", `${card.name} changed status since the preview. Prepare the change again.`, target);
    }
    const result = await changeOrderStatus(deps.db, reviewCtx(p, card.id), { statusKey: payload.statusKey });
    switch (result.kind) {
      case "changed": {
        await finishAction(deps.db, action.id, "done", "ok");
        const change = { event: result.event, order: result.order };
        deps.after(() => followStatusChange(deps.db, deps.env, p.workspaceId, change, followDeps(deps)));
        return ok({ done: true, order: card.name, status: plainText(payload.statusLabel, 80), purchase_order: result.triggersPo ? PO_NOTE : null }, target);
      }
      case "unchanged":
        await finishAction(deps.db, action.id, "done", "unchanged");
        return ok({ done: true, order: card.name, status: plainText(payload.statusLabel, 80), message: "It already had that status." }, target);
      case "forbidden":
        await finishAction(deps.db, action.id, "failed", "forbidden");
        return fail("forbidden", result.error, target);
      case "invalid":
        await finishAction(deps.db, action.id, "failed", "invalid_input");
        return fail("invalid_input", result.error, target);
      case "not-found":
        await finishAction(deps.db, action.id, "failed", "not_found");
        return fail("not_found", `${payload.order} is no longer in this workspace.`, target);
    }
  },
});

export const prepareAddNote = defineTool({
  name: "prepare_add_note",
  title: "Prepare a note",
  description: "Previews adding a note to one card's timeline. Changes nothing; returns a confirmation for confirm_add_note.",
  minRole: "staff",
  needsWrite: true,
  counts: "read",
  annotations: PREPARE,
  input: z.object({ order: orderInput, note: z.string().min(1).max(NOTE_MAX).describe("The note, as it should appear in the timeline") }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const text = args.note.trim();
    if (text.length === 0) {
      return fail("invalid_input", `A note must be 1 to ${NOTE_MAX} characters.`);
    }
    const card = await findCard(deps.db, p.workspaceId, args.order);
    if (!card) {
      return fail("not_found", `No order or request ${plainText(args.order, 64)} in this workspace.`);
    }
    const target = { kind: "order" as const, id: card.id };
    const payload: NotePayload = { order: card.name, text };
    const prepared = await prepareAction(deps.db, p, { tool: "note", targetId: card.id, payload, state: "" }, deps.now());
    return preparedResult(
      prepared,
      { summary: `Add a note to ${card.name}`, details: { note: untrusted(text) }, confirm: { tool: "confirm_add_note", fields: { order: card.name, note: text } } },
      target,
    );
  },
});

export const confirmAddNote = defineTool({
  name: "confirm_add_note",
  title: "Confirm a note",
  description: "Adds the note prepared by prepare_add_note, once. Repeat the order and the note exactly as the preview showed them.",
  minRole: "staff",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_ADDITIVE,
  input: z.object({ confirmation_id: confirmationInput, order: orderInput, note: z.string().min(1).max(NOTE_MAX) }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const start = await beginConfirm<NotePayload>(deps, {
      id: args.confirmation_id,
      tool: "note",
      echo: (stored) => orderMismatch(args.order, stored.order) ?? textMismatch("note", args.note, stored.text),
    });
    if (!start.ok) {
      return start.outcome;
    }
    const { action, payload } = start;
    const card = await loadCardById(deps.db, p.workspaceId, action.targetId);
    if (!card || !(await stateMatches(action, ""))) {
      await finishAction(deps.db, action.id, "failed", "not_found");
      return fail("not_found", `${payload.order} is no longer in this workspace.`);
    }
    const target = { kind: "order" as const, id: card.id };
    const result = await addOrderNote(deps.db, reviewCtx(p, card.id), { text: payload.text });
    if (result.kind !== "added") {
      await finishAction(deps.db, action.id, "failed", result.kind);
      return result.kind === "invalid" ? fail("invalid_input", result.error, target) : fail("not_found", `${payload.order} is no longer in this workspace.`, target);
    }
    await finishAction(deps.db, action.id, "done", "ok");
    deps.after(() => followNote(deps.db, deps.env, p.workspaceId, result.event, followDeps(deps)));
    return ok({ done: true, order: card.name }, target);
  },
});
