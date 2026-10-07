"use client";

// Cancel an order after approval (comprehensive design section 2), near the
// end of an order card's drawer. Managers and platform admins see it; the
// server enforces every rule again. Three steps: a reason (required, saved
// as a note), a review that says exactly what Shopify will and will not do,
// and the irreversible confirm, which follows the Approve step: focus lands
// on the question, a press within CONFIRM_ARM_MS of opening is ignored, and
// Escape or Back steps back. A failure stays in the step with focus on the
// message.

import { useEffect, useId, useRef, useState } from "react";
import { ProhibitIcon } from "@phosphor-icons/react/Prohibit";
import { NOTE_MAX } from "@/lib/limits";
import { InlineMessage, Section, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { focusSoon } from "@/components/settings/kit";
import { confirmArmed } from "./po-send-confirm";

const REASON_REQUIRED = "Give a reason (up to 4000 characters). It is saved as a note on the order.";
const WHAT_HAPPENS = "Shopify does not email the customer, restock items or refund anything. This cannot be undone.";

export type CancelPanelProps = {
  name: string;
  // A manager or platform admin.
  canCancel: boolean;
  // The card sits in the status linked to Shopify's cancelled state.
  cancelled: boolean;
  // Shopify has not confirmed it yet (no cancelledAt on the snapshot).
  pending: boolean;
  // Why Cancel order cannot be used (no cancelled status), or null.
  block: string | null;
  onCancel: (reason: string) => Promise<string | null>;
};

export function CancelOrderPanel({ name, canCancel, cancelled, pending, block, onCancel }: CancelPanelProps) {
  const id = useId();
  const [step, setStep] = useState<"idle" | "reason" | "confirm">("idle");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const openedAt = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (step === "reason") {
      fieldRef.current?.focus();
    }
    if (step === "confirm") {
      openedAt.current = Date.now();
      questionRef.current?.focus();
    }
  }, [step]);

  if (cancelled) {
    return (
      <Section title="Cancelled">
        <p className="text-sm text-ink">This order is cancelled in Shopify.</p>
        {pending ? (
          <div className="mt-3">
            <InlineMessage tone="warn">
              Shopify accepted the cancellation but has not confirmed it yet. Check the order in Shopify if this note stays.
            </InlineMessage>
          </div>
        ) : null}
      </Section>
    );
  }
  if (!canCancel) {
    return null;
  }

  function back(to: "idle" | "reason") {
    setError(null);
    setStep(to);
    focusSoon(() => (to === "idle" ? openRef.current : fieldRef.current));
  }

  function review() {
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > NOTE_MAX) {
      setError(REASON_REQUIRED);
      focusSoon(() => fieldRef.current);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function confirm() {
    if (busy || !confirmArmed(openedAt.current, Date.now())) {
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onCancel(reason.trim());
    if (!mounted.current) {
      return;
    }
    setBusy(false);
    if (failure) {
      setError(failure);
      focusSoon(() => errorRef.current);
    }
  }

  return (
    <Section title="Cancel order">
      {step === "idle" ? (
        <>
          <p className="text-sm text-ink-2">Cancels the order in Shopify. {WHAT_HAPPENS}</p>
          <div className="mt-3">
            <button
              ref={openRef}
              type="button"
              onClick={() => setStep("reason")}
              disabled={block !== null}
              aria-describedby={block ? `${id}-why` : undefined}
              className={ui.buttonDangerSecondary}
            >
              <ProhibitIcon size={16} aria-hidden />
              Cancel order
            </button>
          </div>
          {block ? (
            <p id={`${id}-why`} className="mt-2 text-sm text-ink-2">
              {block}
            </p>
          ) : null}
        </>
      ) : null}

      {step === "reason" ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              back("idle");
            }
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={`${id}-reason`} className={ui.label}>
            Reason (saved as a note on this order)
          </label>
          <p id={`${id}-help`} className="-mt-1 text-sm text-ink-2">
            Shopify keeps the first 255 characters as a staff note. The customer never sees it.
          </p>
          <textarea
            id={`${id}-reason`}
            ref={fieldRef}
            rows={3}
            required
            maxLength={NOTE_MAX}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (error === REASON_REQUIRED && event.target.value.trim().length > 0) {
                setError(null);
              }
            }}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
            aria-invalid={error ? true : undefined}
            className={ui.textarea}
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className={ui.errorText}>
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={ui.buttonPrimary}>
              Review cancellation
            </button>
            <button type="button" onClick={() => back("idle")} className={ui.buttonSecondary}>
              Keep the order
            </button>
          </div>
        </form>
      ) : null}

      {step === "confirm" ? (
        <div
          className="flex flex-col gap-3"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.stopPropagation();
              back("reason");
            }
          }}
        >
          <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm text-ink outline-none">
            <span className="font-semibold">Cancel order {name} in Shopify?</span> {WHAT_HAPPENS}
          </p>
          <blockquote className="whitespace-pre-wrap break-words rounded-panel bg-surface-2 px-3 py-2 text-sm text-ink">
            {reason.trim()}
          </blockquote>
          {error ? (
            <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2" data-tone="red">
            <button
              type="button"
              onClick={() => void confirm()}
              aria-busy={busy || undefined}
              aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
              className={ui.buttonDanger}
            >
              {busy ? <Spinner /> : <ProhibitIcon size={16} aria-hidden />}
              {busy ? "Cancelling" : "Cancel order in Shopify"}
            </button>
            <button type="button" onClick={() => back("reason")} disabled={busy} className={ui.buttonSecondary}>
              Back
            </button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
