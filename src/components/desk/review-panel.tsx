"use client";

// Approve and Reject on a request card (draft orders spec sections 9 and
// 11.3 with section 18 item 8). Managers and platform admins see the
// buttons; staff see who decides. The server enforces every rule again.
//
// Approve completes the draft in Shopify, which cannot be undone, so its
// in-page confirmation follows the purchase order send step rather than the
// settings ConfirmStep: focus lands on the question (never on the button
// that commits), and a press within CONFIRM_ARM_MS of opening is ignored,
// so a double click or a held Enter on Approve cannot create the order.
// Escape or Cancel closes it and focus returns to Approve. A failure stays
// in the step, announced, with focus on the message.
//
// Reject opens a small form: the reason is required (it becomes a note),
// focus starts in it, and Escape or Cancel returns focus to Reject.

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { NOTE_MAX } from "@/lib/limits";
import { ui } from "@/components/ui";
import { InlineMessage } from "@/components/kit";
import { focusSoon } from "@/components/settings/kit";
import { confirmArmed } from "./po-send-confirm";
import { ShopifyLink } from "./request-parts";

const REASON_REQUIRED = "Give a reason (up to 4000 characters). It is saved as a note.";

function ApproveConfirm({
  name,
  email,
  onConfirm,
  onCancel,
}: {
  name: string;
  email: string;
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const questionRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const openedAt = useRef<number | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    openedAt.current = Date.now();
    questionRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function confirm() {
    if (busy || !confirmArmed(openedAt.current, Date.now())) {
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onConfirm();
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
    <div
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm text-ink outline-none">
        <span className="font-semibold">Approve request {name}?</span> Shopify completes the draft at $0.00 and creates
        the order, the same as Mark as paid. Shopify may email its order confirmation to {email || "the requester"}, as
        Mark as paid does.
      </p>
      {error ? (
        <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
          className={ui.buttonPrimary}
        >
          <CheckCircleIcon size={16} aria-hidden />
          {busy ? "Approving..." : "Approve and create order"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RejectForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (reason: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const id = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    fieldRef.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit() {
    if (busy) {
      return;
    }
    if (reason.trim().length === 0 || reason.trim().length > NOTE_MAX) {
      setError(REASON_REQUIRED);
      focusSoon(() => fieldRef.current);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onSubmit(reason);
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
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={`${id}-reason`} className={ui.label}>
        Reason (saved as a note on this request)
      </label>
      <p id={`${id}-help`} className="-mt-1 text-sm text-ink-2">
        The draft stays in Shopify with the tag Ordering Desk: Rejected. Nobody is emailed.
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
        aria-describedby={`${id}-help ${id}-count${error ? ` ${id}-error` : ""}`}
        aria-invalid={error ? true : undefined}
        className={ui.textarea}
      />
      <p id={`${id}-count`} className="text-xs tabular-nums text-ink-2">
        {reason.length.toLocaleString("en-US")} of {NOTE_MAX.toLocaleString("en-US")} characters
      </p>
      {error ? (
        <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2" data-tone="red">
        <button type="submit" disabled={busy} className={ui.buttonDanger}>
          <XCircleIcon size={16} aria-hidden />
          {busy ? "Rejecting..." : "Reject request"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export type ReviewPanelProps = {
  name: string;
  email: string;
  // A manager or platform admin.
  canReview: boolean;
  // The card sits in the status Reject uses.
  rejected: boolean;
  // Why Approve or Reject cannot be used right now (null when it can).
  approveBlock: string | null;
  rejectBlock: string | null;
  // The total is not exactly 0: Approve is not offered; the draft is
  // completed in Shopify instead (url: the draft in Shopify admin).
  completeInShopify: { url: string | null } | null;
  onApprove: () => Promise<string | null>;
  onReject: (reason: string) => Promise<string | null>;
};

export function ReviewPanel({
  name,
  email,
  canReview,
  rejected,
  approveBlock,
  rejectBlock,
  completeInShopify,
  onApprove,
  onReject,
}: ReviewPanelProps) {
  const id = useId();
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const title = rejected ? "This request was rejected" : "Waiting for review";
  const approveWhyShown = approveBlock !== null && !completeInShopify;
  // One reason line when both buttons are blocked for the same reason.
  const rejectWhyId = approveWhyShown && rejectBlock === approveBlock ? `${id}-approve-why` : `${id}-reject-why`;
  const rejectWhyShown = rejectBlock !== null && !rejected && rejectWhyId === `${id}-reject-why`;
  const lead = !canReview
    ? rejected
      ? "Only a manager can approve it or move it out of Rejected."
      : "Waiting for a manager to approve or reject."
    : rejected
      ? "A manager can still approve it."
      : completeInShopify
        ? "Reject asks for a reason and saves it as a note."
        : "Approve creates the order in Shopify. Reject asks for a reason and saves it as a note.";

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mb-5 rounded-panel border border-line bg-surface-2 p-4"
    >
      <h3 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="font-display text-sm font-semibold text-ink outline-none">
        {title}
      </h3>
      <p className="mt-1 text-sm text-ink-2">{lead}</p>

      {canReview && completeInShopify ? (
        <div className="mt-3">
          <InlineMessage tone="warn">
            Complete this draft in Shopify. The card follows when you do.{" "}
            {completeInShopify.url ? <ShopifyLink href={completeInShopify.url}>Open the draft in Shopify</ShopifyLink> : null}
          </InlineMessage>
        </div>
      ) : null}

      {canReview && mode === "idle" ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {completeInShopify ? null : (
              <button
                ref={approveRef}
                type="button"
                onClick={() => setMode("approve")}
                disabled={approveBlock !== null}
                aria-describedby={approveBlock ? `${id}-approve-why` : undefined}
                className={ui.buttonPrimary}
              >
                <CheckCircleIcon size={16} aria-hidden />
                Approve
              </button>
            )}
            {rejected ? null : (
              <button
                ref={rejectRef}
                type="button"
                onClick={() => setMode("reject")}
                disabled={rejectBlock !== null}
                aria-describedby={rejectBlock ? rejectWhyId : undefined}
                className={ui.buttonSecondary.replace("text-ink", "text-bad")}
              >
                <XCircleIcon size={16} aria-hidden />
                Reject
              </button>
            )}
          </div>
          {approveWhyShown ? (
            <p id={`${id}-approve-why`} className="mt-2 text-sm text-ink-2">
              {approveBlock}
            </p>
          ) : null}
          {rejectWhyShown ? (
            <p id={`${id}-reject-why`} className="mt-2 text-sm text-ink-2">
              {rejectBlock}
            </p>
          ) : null}
        </>
      ) : null}

      {canReview && mode === "approve" ? (
        <div className="mt-3">
          <ApproveConfirm
            name={name}
            email={email}
            onConfirm={onApprove}
            onCancel={() => {
              setMode("idle");
              focusSoon(() => approveRef.current);
            }}
          />
        </div>
      ) : null}

      {canReview && mode === "reject" ? (
        <div className="mt-3">
          <RejectForm
            onSubmit={async (reason) => {
              const failure = await onReject(reason);
              if (!failure) {
                setMode("idle");
                focusSoon(() => headingRef.current);
              }
              return failure;
            }}
            onCancel={() => {
              setMode("idle");
              focusSoon(() => rejectRef.current);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
