"use client";

// Approve and Reject on a request card (draft orders spec sections 9 and
// 11.3 with section 18 item 8; Approve and next from the comprehensive desk
// design section 1). ReviewSummary says where the request stands;
// ReviewActions holds the buttons and their steps (managers and platform
// admins; staff see who decides). ReviewPanel puts both in one panel. The
// server enforces every rule again.
//
// Approve completes the draft in Shopify, which cannot be undone, so its
// in-page confirmation follows the purchase order send step: focus lands on
// the question (never on the button that commits), and a press within
// CONFIRM_ARM_MS of opening is ignored, so a double click or a held Enter
// cannot create the order. Approve and next uses the same step and then
// opens the next request waiting; that request's own confirmation is never
// opened for it. Escape or Cancel closes a step and focus returns to the
// button that opened it. A failure stays in the step, announced, with focus
// on it.
//
// Reject opens a small form: the reason is required (it becomes a note),
// focus starts in it, and Escape or Cancel returns focus to Reject.

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { XCircleIcon } from "@phosphor-icons/react/XCircle";
import { NOTE_MAX } from "@/lib/limits";
import { InlineMessage, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { focusSoon } from "@/components/settings/kit";
import { confirmArmed } from "./po-send-confirm";
import { ShopifyLink } from "./request-parts";

const REASON_REQUIRED = "Give a reason (up to 4000 characters). It is saved as a note.";

export type NextRequest = { id: string; name: string };

function ApproveConfirm({
  name,
  email,
  nextName,
  onConfirm,
  onCancel,
}: {
  name: string;
  email: string;
  // Approve and next: the request that opens afterwards.
  nextName: string | null;
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
        Mark as paid does.{nextName ? ` Then request ${nextName} opens.` : ""}
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
          aria-busy={busy || undefined}
          aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
          className={ui.buttonPrimary}
        >
          {busy ? <Spinner /> : <CheckCircleIcon size={16} aria-hidden />}
          {busy ? "Approving" : nextName ? `Approve and open ${nextName}` : "Approve and create order"}
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
        <button type="submit" disabled={busy} aria-busy={busy || undefined} className={ui.buttonDanger}>
          {busy ? <Spinner /> : <XCircleIcon size={16} aria-hidden />}
          {busy ? "Rejecting" : "Reject request"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonSecondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export type ReviewSummaryProps = {
  // A manager or platform admin.
  canReview: boolean;
  // The card sits in the status Reject uses.
  rejected: boolean;
  // The total is not exactly 0: Approve is not offered; the draft is
  // completed in Shopify instead (url: the draft in Shopify admin).
  completeInShopify: { url: string | null } | null;
  // The heading's id (focus returns to it after a reject).
  titleId?: string;
};

// Where the request stands: the heading, who may decide, and the note to
// complete a priced draft in Shopify.
export function ReviewSummary({ canReview, rejected, completeInShopify, titleId }: ReviewSummaryProps) {
  const title = rejected ? "This request was rejected" : "Waiting for review";
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
    <>
      <h3 id={titleId} tabIndex={-1} className="font-display text-sm font-semibold text-ink outline-none">
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
    </>
  );
}

export type ReviewActionsProps = {
  name: string;
  email: string;
  rejected: boolean;
  // Why Approve or Reject cannot be used right now (null when it can).
  approveBlock: string | null;
  rejectBlock: string | null;
  completeInShopify: { url: string | null } | null;
  // The next request waiting, for Approve and next (null: none waits).
  next?: NextRequest | null;
  onApprove: () => Promise<string | null>;
  onApproveAndNext?: () => Promise<string | null>;
  onReject: (reason: string) => Promise<string | null>;
  // Where focus goes once a reject is saved.
  afterReject?: () => HTMLElement | null;
};

type Mode = "idle" | "approve" | "approve-next" | "reject";

export function ReviewActions({
  name,
  email,
  rejected,
  approveBlock,
  rejectBlock,
  completeInShopify,
  next = null,
  onApprove,
  onApproveAndNext,
  onReject,
  afterReject,
}: ReviewActionsProps) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("idle");
  const approveRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const approveWhyShown = approveBlock !== null && !completeInShopify;
  // One reason line when both buttons are blocked for the same reason.
  const rejectWhyId = approveWhyShown && rejectBlock === approveBlock ? `${id}-approve-why` : `${id}-reject-why`;
  const rejectWhyShown = rejectBlock !== null && !rejected && rejectWhyId === `${id}-reject-why`;
  const andNext = !completeInShopify && next !== null && onApproveAndNext !== undefined ? { next, run: onApproveAndNext } : null;

  if (mode === "approve" || (mode === "approve-next" && andNext)) {
    const withNext = mode === "approve-next" && andNext !== null;
    return (
      <ApproveConfirm
        name={name}
        email={email}
        nextName={withNext && andNext ? andNext.next.name : null}
        onConfirm={async () => {
          const failure = await (withNext && andNext ? andNext.run() : onApprove());
          if (!failure) {
            setMode("idle");
          }
          return failure;
        }}
        onCancel={() => {
          const back = withNext ? nextRef : approveRef;
          setMode("idle");
          focusSoon(() => back.current);
        }}
      />
    );
  }

  if (mode === "reject") {
    return (
      <RejectForm
        onSubmit={async (reason) => {
          const failure = await onReject(reason);
          if (!failure) {
            setMode("idle");
            if (afterReject) {
              focusSoon(afterReject);
            }
          }
          return failure;
        }}
        onCancel={() => {
          setMode("idle");
          focusSoon(() => rejectRef.current);
        }}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
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
        {andNext ? (
          <button
            ref={nextRef}
            type="button"
            onClick={() => setMode("approve-next")}
            disabled={approveBlock !== null}
            aria-describedby={approveBlock ? `${id}-approve-why` : `${id}-next`}
            className={ui.buttonSecondary}
          >
            <ArrowRightIcon size={16} aria-hidden />
            Approve and next
          </button>
        ) : null}
        {rejected ? null : (
          <button
            ref={rejectRef}
            type="button"
            onClick={() => setMode("reject")}
            disabled={rejectBlock !== null}
            aria-describedby={rejectBlock ? rejectWhyId : undefined}
            className={ui.buttonDangerSecondary}
          >
            <XCircleIcon size={16} aria-hidden />
            Reject
          </button>
        )}
      </div>
      {andNext && approveBlock === null ? (
        <p id={`${id}-next`} className="sr-only">
          {`Then request ${andNext.next.name} opens.`}
        </p>
      ) : null}
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
    </div>
  );
}

export type ReviewPanelProps = ReviewSummaryProps & Omit<ReviewActionsProps, "afterReject">;

// Both in one panel (the drawer's body until the phone action bar, Task 19,
// moves the actions to its footer).
export function ReviewPanel(props: ReviewPanelProps) {
  const id = useId();
  const titleId = `${id}-title`;
  return (
    <section aria-labelledby={titleId} className="mb-5 rounded-panel border border-line bg-surface-2 p-4">
      <ReviewSummary canReview={props.canReview} rejected={props.rejected} completeInShopify={props.completeInShopify} titleId={titleId} />
      {props.canReview ? (
        <div className="mt-3">
          <ReviewActions {...props} afterReject={() => document.getElementById(titleId)} />
        </div>
      ) : null}
    </section>
  );
}
