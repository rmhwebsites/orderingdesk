"use client";

// Edit a request before approval (comprehensive design section 2): change
// a quantity, remove lines (one stays), switch the ship-to among the
// company's locations. Opened from the review panel, so an open Approve
// confirmation closes. Two steps: the editor, then a before-and-after
// review whose Save follows the Approve step (focus on the question, a
// press within CONFIRM_ARM_MS of opening ignored). The server re-reads the
// draft and refuses when it changed since the editor opened; the editor
// then reloads with the latest version and says why.
//
// The editor owns focus while it is open. Each change of view removes the
// control that held focus (Edit request, Back to editing, Save changes), so
// something in the editor takes it (editFocus), or focus would drop to the
// page and the drawer would stop answering Escape and Tab.

import { useCallback, useEffect, useId, useRef, useState, type Ref } from "react";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/ArrowUUpLeft";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { MinusIcon } from "@phosphor-icons/react/Minus";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import {
  EDIT_QUANTITY_MAX,
  bodyFromForm,
  lineLabel,
  summarizeEdit,
  type EditRequestBody,
  type EditSummary,
  type RequestEditor,
} from "@/lib/request-edit";
import { InlineMessage, RadioCard, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { focusSoon } from "@/components/settings/kit";
import { confirmArmed } from "./po-send-confirm";

// What a save came to: an error (with the fresh editor when the request
// changed meanwhile), or saved with an optional warning (a total above $0).
export type EditSaveOutcome = { error: string; editor?: RequestEditor } | { warning: string | null };

// What the editor shows: loading, the load error, the form, or the review.
// `editor` is the loaded editor object (compared by identity), null before
// one loads.
export type EditStep = { view: "loading" | "error" | "form" | "review"; editor: object | null };
export type EditFocusTarget = "loading" | "error" | "heading" | "review-button";

// Where focus goes when the editor moves from `prev` to `next`: the loading
// region when it opens or tries again, the message when it does not load,
// the heading when the form is ready (first load or a reload after a stale
// save, whose notice the heading carries), Review changes after Back to
// editing. The review puts focus on its own question.
export function editFocus(prev: EditStep | null, next: EditStep): EditFocusTarget | null {
  if (prev && prev.view === next.view && prev.editor === next.editor) {
    return null;
  }
  switch (next.view) {
    case "loading":
      return "loading";
    case "error":
      return "error";
    case "review":
      return null;
    case "form":
      return prev?.view === "review" && prev.editor === next.editor ? "review-button" : "heading";
  }
}

export function EditRequestForm({
  name,
  editor,
  notice,
  onReview,
  onClose,
  headingRef,
  reviewRef,
}: {
  name: string;
  editor: RequestEditor;
  // Why the editor reloaded (the request changed in Shopify), or null.
  notice: string | null;
  onReview: (body: EditRequestBody, summary: EditSummary) => void;
  onClose: () => void;
  // Focus targets for EditRequest (see editFocus).
  headingRef?: Ref<HTMLHeadingElement>;
  reviewRef?: Ref<HTMLButtonElement>;
}) {
  const id = useId();
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(editor.lines.map((line) => [line.uuid, String(line.quantity)])),
  );
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [locationId, setLocationId] = useState<string | null>(editor.locationId);
  const [error, setError] = useState<string | null>(null);
  const kept = editor.lines.filter((line) => !removed.has(line.uuid)).length;
  const parsed = bodyFromForm(editor, { quantities, removed, locationId });
  const summary = "error" in parsed ? null : summarizeEdit(editor, parsed);

  function step(uuid: string, delta: number) {
    setQuantities((current) => {
      const value = Number(current[uuid]);
      const next = Number.isInteger(value) ? Math.min(EDIT_QUANTITY_MAX, Math.max(1, value + delta)) : 1;
      return { ...current, [uuid]: String(next) };
    });
  }

  function toggle(uuid: string) {
    setRemoved((current) => {
      const next = new Set(current);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  }

  function review() {
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (summary && summary.changes.length > 0) {
      setError(null);
      onReview(parsed, summary);
    }
  }

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <h4
        ref={headingRef}
        tabIndex={-1}
        aria-describedby={notice ? `${id}-notice` : undefined}
        className="font-display text-sm font-semibold text-ink outline-none"
      >
        Edit request {name}
      </h4>
      {notice ? (
        <InlineMessage id={`${id}-notice`} tone="warn">
          {notice}
        </InlineMessage>
      ) : null}
      <ul className="flex flex-col gap-3" aria-label="Items">
        {editor.lines.map((line) => {
          const gone = removed.has(line.uuid);
          const label = lineLabel(line);
          const lastOne = !gone && kept <= 1;
          return (
            <li key={line.uuid} className="rounded-panel border border-line bg-surface p-3">
              <p className={`text-sm font-medium ${gone ? "text-ink-2 line-through" : "text-ink"}`}>{label}</p>
              {line.sku || line.propertyCount > 0 ? (
                <p className="text-xs text-ink-2">
                  {line.sku ? <span className="whitespace-nowrap font-mono">SKU {line.sku}</span> : null}
                  {line.sku && line.propertyCount > 0 ? " · " : null}
                  {line.propertyCount > 0
                    ? `Personalization kept exactly (${line.propertyCount} ${line.propertyCount === 1 ? "field" : "fields"})`
                    : null}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {gone ? null : (
                  <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${label}`}>
                    <button type="button" onClick={() => step(line.uuid, -1)} className={ui.iconButton}>
                      <MinusIcon size={16} aria-hidden />
                      <span className="sr-only">One fewer {label}</span>
                    </button>
                    <input
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={quantities[line.uuid] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setQuantities((current) => ({ ...current, [line.uuid]: value }));
                      }}
                      aria-label={`Quantity of ${label}`}
                      className={`${ui.input} w-20 px-2 text-center tabular-nums`}
                    />
                    <button type="button" onClick={() => step(line.uuid, 1)} className={ui.iconButton}>
                      <PlusIcon size={16} aria-hidden />
                      <span className="sr-only">One more {label}</span>
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => toggle(line.uuid)}
                  disabled={lastOne}
                  aria-describedby={lastOne ? `${id}-keep` : undefined}
                  className={`${ui.buttonQuiet} h-10`}
                >
                  {gone ? <ArrowUUpLeftIcon size={16} aria-hidden /> : <TrashIcon size={16} aria-hidden />}
                  {gone ? "Keep" : "Remove"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {kept <= 1 ? (
        <p id={`${id}-keep`} className="text-xs text-ink-2">
          A request keeps at least one item.
        </p>
      ) : null}
      {editor.locations.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className={`${ui.label} mb-1`}>Ship to</legend>
          {editor.locations.map((option) => (
            <RadioCard
              key={option.shopifyLocationId}
              name={`${id}-location`}
              value={option.shopifyLocationId}
              checked={locationId === option.shopifyLocationId}
              onChange={() => setLocationId(option.shopifyLocationId)}
              label={option.name}
              help={option.address || undefined}
            />
          ))}
        </fieldset>
      ) : editor.locationName ? (
        <p className="text-sm text-ink-2">
          Ships to <span className="font-semibold text-ink">{editor.locationName}</span>.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          ref={reviewRef}
          type="button"
          onClick={review}
          disabled={summary !== null && summary.changes.length === 0}
          className={ui.buttonPrimary}
        >
          Review changes
        </button>
        <button type="button" onClick={onClose} className={ui.buttonSecondary}>
          Close
        </button>
      </div>
    </div>
  );
}

export function EditReview({
  name,
  summary,
  error,
  busy,
  onSave,
  onBack,
}: {
  name: string;
  summary: EditSummary;
  error: string | null;
  busy: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  const id = useId();
  const questionRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const openedAt = useRef<number | null>(null);

  useEffect(() => {
    openedAt.current = Date.now();
    questionRef.current?.focus();
  }, []);

  useEffect(() => {
    if (error) {
      focusSoon(() => errorRef.current);
    }
  }, [error]);

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm text-ink outline-none">
        <span className="font-semibold">Save these changes to request {name} in Shopify?</span> Personalization and proof
        links stay exactly as they are. Shopify recalculates the request; Approve still needs a $0.00 total.
      </p>
      <ul className="list-disc pl-5 text-sm text-ink">
        {summary.changes.map((change, index) => (
          <li key={index}>{change}</li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["Before", summary.before],
            ["After", summary.after],
          ] as const
        ).map(([title, side]) => (
          <section key={title} aria-labelledby={`${id}-${title}`} className="rounded-panel bg-surface-2 p-3">
            <h5 id={`${id}-${title}`} className="text-xs font-semibold text-ink-2">
              {title}
            </h5>
            <ul className="mt-1 text-sm text-ink">
              {side.lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-2">Ship to {side.shipTo}</p>
          </section>
        ))}
      </div>
      {error ? (
        <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            if (!busy && confirmArmed(openedAt.current, Date.now())) {
              onSave();
            }
          }}
          aria-busy={busy || undefined}
          aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
          className={ui.buttonPrimary}
        >
          {busy ? <Spinner /> : <CheckIcon size={16} aria-hidden />}
          {busy ? "Saving" : "Save changes"}
        </button>
        <button type="button" onClick={onBack} disabled={busy} className={ui.buttonSecondary}>
          Back to editing
        </button>
      </div>
    </div>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; editor: RequestEditor; notice: string | null };

// The editor's data: the draft read fresh through GET /api/orders/[id]/edit.
export function EditRequest({
  orderId,
  name,
  onSave,
  onClose,
}: {
  orderId: string;
  name: string;
  onSave: (body: EditRequestBody) => Promise<EditSaveOutcome>;
  onClose: (warning?: string | null) => void;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [review, setReview] = useState<{ body: EditRequestBody; summary: EditSummary } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const loadingRef = useRef<HTMLDivElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const shown = useRef<EditStep | null>(null);
  const view: EditStep["view"] = state.status === "ready" ? (review ? "review" : "form") : state.status;
  const shownEditor = state.status === "ready" ? state.editor : null;

  // Move focus into the view that just replaced the one holding it.
  useEffect(() => {
    const next: EditStep = { view, editor: shownEditor };
    const target = editFocus(shown.current, next);
    shown.current = next;
    if (target) {
      focusSoon(() => {
        switch (target) {
          case "loading":
            return loadingRef.current;
          case "error":
            return failedRef.current;
          case "heading":
            return headingRef.current;
          case "review-button":
            return reviewRef.current && !reviewRef.current.disabled ? reviewRef.current : headingRef.current;
        }
      });
    }
  }, [view, shownEditor]);

  const load = useCallback(
    async (notice: string | null) => {
      setState({ status: "loading" });
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/edit`, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as { editor?: RequestEditor; error?: string } | null;
        if (!mounted.current) {
          return;
        }
        setState(
          response.ok && body?.editor
            ? { status: "ready", editor: body.editor, notice }
            : { status: "error", message: body?.error ?? `The request did not load (the server answered ${response.status}).` },
        );
      } catch {
        if (mounted.current) {
          setState({ status: "error", message: "Could not reach the server. Check your connection and try again." });
        }
      }
    },
    [orderId],
  );

  useEffect(() => {
    mounted.current = true;
    void load(null);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function save() {
    if (!review || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await onSave(review.body);
    if (!mounted.current) {
      return;
    }
    setBusy(false);
    if ("error" in outcome) {
      if (outcome.editor) {
        setReview(null);
        setState({ status: "ready", editor: outcome.editor, notice: outcome.error });
      } else {
        setError(outcome.error);
      }
      return;
    }
    onClose(outcome.warning);
  }

  if (state.status === "loading") {
    return (
      <div ref={loadingRef} role="status" tabIndex={-1} className="flex flex-col gap-2 outline-none">
        <span className="sr-only">Loading the request from Shopify</span>
        <span aria-hidden className="od-skeleton h-4 w-40" />
        <span aria-hidden className="od-skeleton h-16 w-full rounded-panel" />
        <span aria-hidden className="od-skeleton h-16 w-full rounded-panel" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <div ref={failedRef} tabIndex={-1} className="outline-none">
          <InlineMessage tone="bad">{state.message}</InlineMessage>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load(null)} className={ui.buttonSecondary}>
            Try again
          </button>
          <button type="button" onClick={() => onClose()} className={`${ui.buttonQuiet} h-10`}>
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {/* Kept mounted while reviewing, so Back keeps what was typed. */}
      <div hidden={review !== null}>
        <EditRequestForm
          key={state.editor.updatedAt}
          name={name}
          editor={state.editor}
          notice={state.notice}
          onReview={(body, summary) => setReview({ body, summary })}
          onClose={() => onClose()}
          headingRef={headingRef}
          reviewRef={reviewRef}
        />
      </div>
      {review ? (
        <EditReview
          name={name}
          summary={review.summary}
          error={error}
          busy={busy}
          onSave={() => void save()}
          onBack={() => {
            setReview(null);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}
