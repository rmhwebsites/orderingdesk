"use client";

// The mandatory stop before a purchase order goes out: an in-page step that
// names the vendor and every address (To and copies), with Cancel and an
// explicit Send to vendor. It opens with focus on its question, never on
// the send, and ignores a send pressed in its first moment, so the press
// that opened it cannot also send. Used by the review modal (its Review
// and send) and by Retry and Send again in the drawer's history.
// useSendFlow drives it: a request id per
// confirmation (so a repeated tap or a retry after a lost answer never
// sends twice), new recipients shown again when they changed, and every
// outcome handed back.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import type { PoRecipients } from "@/lib/po";
import { newRequestId, recipientSummary, sendPo } from "@/lib/po-client";
import type { PoView } from "@/server/po/service";
import { InlineMessage } from "@/components/settings/kit";
import { ui } from "@/components/ui";

export type PendingSend = {
  poId: string;
  // "purchase order IMP-2026-0042", or the number it will get.
  label: string;
  vendorName: string;
  recipients: PoRecipients;
  resend: boolean;
  requestId: string;
  message: string | null;
};

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
  const focusState = useRef<StepFocusState | null>(null);
  const openedAt = useRef<number | null>(null);
  const summary = recipientSummary(pending.recipients);

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
      <p className="text-xs text-ink-2">The PDF is attached. Once it is sent, it cannot be taken back.</p>
      {pending.message ? <InlineMessage tone="warn">{pending.message}</InlineMessage> : null}
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
          disabled={busy}
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
}) {
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [busy, setBusy] = useState(false);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const start = useCallback((po: PoView, opts: { label: string; resend: boolean; recipients?: PoRecipients }) => {
    const recipients = opts.recipients ?? po.recipients;
    if (!recipients || !po.vendor) {
      return false;
    }
    setPending({
      poId: po.id,
      label: opts.label,
      vendorName: po.vendor.name,
      recipients,
      resend: opts.resend,
      requestId: newRequestId(),
      message: null,
    });
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
      case "recipients":
        // A fresh confirmation of the addresses the server has now.
        setPending({ ...pending, recipients: outcome.recipients, requestId: newRequestId(), message: outcome.message });
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
