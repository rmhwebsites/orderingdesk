"use client";

// The mandatory stop before a purchase order goes out: an in-page step that
// names the vendor and every address (To and copies) and shows what goes
// out (every line, the total, the ship-to and the notes), with Cancel and
// an explicit Send to vendor. The send carries the version of exactly that
// content (PoView.contentVersion), so the server sends nothing else: when
// the PO changed since the step opened (another manager saved it, the
// vendor was edited), it answers with the PO as it would go out now and the
// step shows that and asks again. It opens with focus on its question,
// never on the send, and ignores a send pressed in its first moment, so the
// press that opened it cannot also send. Used by the review modal (its
// Review and send) and by Retry and Review and send again in the drawer's
// history. useSendFlow drives it: a request id per confirmation (so a
// repeated tap or a retry after a lost answer never sends twice), what
// would go out now shown again when it changed, and every outcome handed
// back.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { costToCents, formatCents, lineTotalCents, type PoRecipients } from "@/lib/po";
import { newRequestId, recipientSummary, sendPo } from "@/lib/po-client";
import type { PoView } from "@/server/po/service";
import { InlineMessage } from "@/components/settings/kit";
import { ui } from "@/components/ui";

// What the step shows goes out, as the server last described the PO.
export type PendingContent = Pick<PoView, "lines" | "shipTo" | "notes" | "currency" | "subtotal">;

export type PendingSend = {
  poId: string;
  // "purchase order IMP-2026-0042", or the number it will get.
  label: string;
  vendorName: string;
  recipients: PoRecipients;
  content: PendingContent;
  // The PoView.contentVersion of that content; the send carries it.
  contentVersion: string;
  resend: boolean;
  requestId: string;
  message: string | null;
};

function contentOf(po: PoView): PendingContent {
  return { lines: po.lines, shipTo: po.shipTo, notes: po.notes, currency: po.currency, subtotal: po.subtotal };
}

// The step for this PO as it stands, or null when it has no vendor to send
// to.
export function pendingFromPo(po: PoView, opts: { label: string; resend: boolean }, requestId: string): PendingSend | null {
  if (!po.recipients || !po.vendor) {
    return null;
  }
  return {
    poId: po.id,
    label: opts.label,
    vendorName: po.vendor.name,
    recipients: po.recipients,
    content: contentOf(po),
    contentVersion: po.contentVersion,
    resend: opts.resend,
    requestId,
    message: null,
  };
}

// A fresh confirmation after the server refused this one: what would go out
// now (the PO it answered with) under a new request id, so the old
// confirmation can never send it. Without a PO in the answer only the
// recipients are replaced.
export function reconfirmPending(
  pending: PendingSend,
  answer: { recipients: PoRecipients; message: string; po: PoView | null },
  requestId: string,
): PendingSend {
  const po = answer.po;
  if (po && po.recipients && po.vendor) {
    return {
      ...pending,
      vendorName: po.vendor.name,
      recipients: po.recipients,
      content: contentOf(po),
      contentVersion: po.contentVersion,
      requestId,
      message: answer.message,
    };
  }
  return { ...pending, recipients: answer.recipients, requestId, message: answer.message };
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
}

function SendContent({ content, labelId }: { content: PendingContent; labelId: string }) {
  const subtotal = content.subtotal === null ? null : costToCents(content.subtotal);
  return (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-ink-2">Total</dt>
        <dd className="text-ink">
          <span className="font-mono tabular-nums">{subtotal === null ? "Not priced" : formatCents(subtotal, content.currency)}</span>
          <span className="text-ink-2">, {plural(content.lines.length, "line")}</span>
        </dd>
        <dt className="text-ink-2">Ship to</dt>
        <dd className="break-words text-ink">
          {content.shipTo.length > 0
            ? content.shipTo.map((line, index) => (
                <span key={index} className="block">
                  {line}
                </span>
              ))
            : "No ship-to address"}
        </dd>
        {content.notes ? (
          <>
            <dt className="text-ink-2">Notes</dt>
            <dd className="whitespace-pre-line break-words text-ink">{content.notes}</dd>
          </>
        ) : null}
      </dl>
      <div className="flex flex-col gap-1.5">
        <p id={labelId} className="text-xs font-medium text-ink-2">
          Lines
        </p>
        <ol aria-labelledby={labelId} className="flex flex-col divide-y divide-line rounded-panel border border-line bg-surface text-sm">
          {content.lines.map((line, index) => {
            const unit = line.unitCost === null ? null : costToCents(line.unitCost);
            const total = lineTotalCents(line);
            return (
              <li key={index} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2">
                <span className="min-w-0 break-words text-ink">
                  {line.description}
                  {line.sku ? <span className="ml-2 font-mono text-xs text-ink-2">{line.sku}</span> : null}
                </span>
                <span className="ml-auto font-mono text-xs tabular-nums text-ink-2">
                  {unit === null ? `${line.quantity} × Not priced` : `${line.quantity} × ${formatCents(unit, content.currency)}`}
                  <span className="ml-2 text-sm text-ink">{total === null ? "" : formatCents(total, content.currency)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

// A send pressed sooner than this after the step opened (or after a new
// confirmation replaced it) is ignored: a double click that opened the
// step must not land on its send button.
export const CONFIRM_ARM_MS = 400;

export function confirmArmed(openedAt: number | null, now: number): boolean {
  return openedAt !== null && now - openedAt >= CONFIRM_ARM_MS;
}

type StepFocusState = { busy: boolean; requestId: string };

// Where focus goes as the step changes. When it opens, and for every new
// confirmation (new recipients), focus lands on the question, never on the
// irreversible send: the WAI-ARIA practice for an action that cannot be
// undone, and so a double or held Enter from the button that opened the
// step cannot send. When the same send settles and the step stays open (a
// message to read, then send again), focus goes back to its send button,
// which was disabled while sending.
export function confirmFocus(previous: StepFocusState | null, next: StepFocusState): "question" | "send" | null {
  if (previous === null || previous.requestId !== next.requestId) {
    return "question";
  }
  return previous.busy && !next.busy ? "send" : null;
}

export function SendConfirm({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: PendingSend;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const questionId = useId();
  const linesId = useId();
  const focusState = useRef<StepFocusState | null>(null);
  const openedAt = useRef<number | null>(null);
  const summary = recipientSummary(pending.recipients);
  // A line without a cost cannot go out (the server refuses it too).
  const sendable = pending.content.lines.length > 0 && pending.content.subtotal !== null;

  // Every confirmation (the first, or new recipients) arms the send anew.
  useEffect(() => {
    openedAt.current = Date.now();
  }, [pending.requestId]);

  useEffect(() => {
    const next = { busy, requestId: pending.requestId };
    const target = confirmFocus(focusState.current, next);
    focusState.current = next;
    if (target === "question") {
      questionRef.current?.focus();
    } else if (target === "send") {
      confirmRef.current?.focus();
    }
  }, [busy, pending.requestId]);

  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="flex flex-col gap-3 rounded-panel border border-line-strong bg-surface-2 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p ref={questionRef} id={questionId} tabIndex={-1} className="text-sm font-semibold text-ink outline-none">
        {pending.resend ? `Send ${pending.label} again to ${pending.vendorName}?` : `Send ${pending.label} to ${pending.vendorName}?`}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-ink-2">To</dt>
        <dd className="break-all text-ink">{summary.to}</dd>
        <dt className="text-ink-2">Copies</dt>
        <dd className="break-all text-ink">{summary.copies}</dd>
      </dl>
      <SendContent content={pending.content} labelId={linesId} />
      <p className="text-xs text-ink-2">
        This is exactly what goes out, with the PDF attached. Once it is sent, it cannot be taken back.
      </p>
      {pending.message ? <InlineMessage tone="warn">{pending.message}</InlineMessage> : null}
      {!sendable ? (
        <InlineMessage tone="bad">A line has no unit cost, so this cannot be sent. Cancel and enter every cost first.</InlineMessage>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={() => {
            if (confirmArmed(openedAt.current, Date.now())) {
              onConfirm();
            }
          }}
          disabled={busy || !sendable}
          aria-describedby={questionId}
          className={ui.buttonPrimary}
        >
          <PaperPlaneTiltIcon size={16} aria-hidden />
          {busy ? "Sending" : pending.resend ? "Send again" : "Send to vendor"}
        </button>
      </div>
    </div>
  );
}

const OFFLINE =
  "Could not reach the server, so it is not known whether it went out. Send again to check: the same request never sends twice.";

export function useSendFlow(handlers: {
  onSent: (po: PoView, resend: boolean) => void;
  // Nothing was sent by this request, or the send failed; po is how it
  // stands now and message says what happened.
  onSettled: (po: PoView, message: string | null) => void;
  // Nothing was sent: the PO changed since the step opened. The step now
  // shows po (what would go out now) and asks again.
  onChanged?: (po: PoView) => void;
}) {
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [busy, setBusy] = useState(false);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const start = useCallback((po: PoView, opts: { label: string; resend: boolean }) => {
    const next = pendingFromPo(po, opts, newRequestId());
    if (!next) {
      return false;
    }
    setPending(next);
    return true;
  }, []);

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(async () => {
    if (!pending || busy) {
      return;
    }
    setBusy(true);
    const outcome = await sendPo(pending.poId, {
      requestId: pending.requestId,
      recipients: pending.recipients,
      contentVersion: pending.contentVersion,
      resend: pending.resend,
    });
    setBusy(false);
    switch (outcome.kind) {
      case "sent":
        setPending(null);
        handlersRef.current.onSent(outcome.po, pending.resend);
        return;
      case "unchanged":
        setPending(null);
        handlersRef.current.onSettled(
          outcome.po,
          outcome.po.state === "failed"
            ? outcome.po.lastError
            : outcome.reason === "already-sent"
              ? "This purchase order was already sent. Nothing more went out."
              : null,
        );
        return;
      case "reconfirm":
        // A fresh confirmation of what the server would send now.
        setPending(reconfirmPending(pending, outcome, newRequestId()));
        if (outcome.po) {
          handlersRef.current.onChanged?.(outcome.po);
        }
        return;
      case "busy":
      case "failed":
        setPending(null);
        handlersRef.current.onSettled(outcome.po, outcome.message);
        return;
      case "error":
        setPending({ ...pending, message: outcome.message });
        return;
      case "offline":
        setPending({ ...pending, message: OFFLINE });
        return;
    }
  }, [pending, busy]);

  return { pending, busy, start, cancel, confirm };
}
