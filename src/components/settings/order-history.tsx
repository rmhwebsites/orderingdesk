"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/ClockCounterClockwise";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { formatDate, relativeTime } from "@/lib/format";
import {
  historyRangeLabel,
  historySummary,
  latestStartDate,
  rangeNeedsAllOrders,
  startOfLocalDay,
} from "@/lib/order-history";
import { useNow } from "@/lib/use-now";
import type { BackfillView } from "@/server/sync/backfill";
import { ui } from "@/components/ui";
import { ConfirmStep, describedBy, Field, focusSoon, InlineMessage, Panel, requestJson, ToneChip } from "./kit";

// Settings > Store connection > Order history (platform admins): start an
// import of the store's older orders, follow it, cancel it. The cron does
// the importing (src/server/sync/backfill.ts); this polls while it runs.

const POLL_MS = 30000;
const HEADING_ID = "order-history-heading";
const SCOPE_HINT =
  "Orders older than 60 days need the read_all_orders permission, which this store's Shopify app does not have. Add it to the app's access scopes, approve the new version on the store, then connect again above.";

type Mode = "all" | "since";

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-sm text-ink-2 sm:w-40">{term}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function Running({
  view,
  now,
  onCancel,
  cancelling,
  cancelError,
}: {
  view: BackfillView;
  now: number;
  onCancel: () => void;
  cancelling: boolean;
  cancelError: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mounted = now > 0;
  const range = historyRangeLabel(view.since, mounted ? (ms) => formatDate(ms) : null);
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2.5">
        <Detail term="Importing">{range.charAt(0).toUpperCase() + range.slice(1)}</Detail>
        <Detail term="Imported so far">
          <span className="font-mono tabular-nums">{view.imported.toLocaleString("en-US")}</span>{" "}
          {view.imported === 1 ? "order" : "orders"}
        </Detail>
        <Detail term="Started">{view.startedAt !== null && mounted ? relativeTime(view.startedAt, now) : ""}</Detail>
      </dl>
      {view.paused === "sync" ? (
        <InlineMessage tone="info">
          The regular sync is still bringing in recent orders. The import waits until the regular sync has caught up,
          then carries on by itself.
        </InlineMessage>
      ) : view.paused === "disconnected" ? (
        <InlineMessage tone="warn">
          Paused while the store is disconnected. Connect the same store again to carry on, or stop the import.
        </InlineMessage>
      ) : null}
      {view.error ? (
        <InlineMessage tone="warn">
          The last try did not go through ({view.error}). It tries again at the next sync, about every 10 minutes.
        </InlineMessage>
      ) : null}
      <p className="text-sm text-ink-2">
        About 100 orders every 10 minutes, in the background. You can leave this page; the count updates while it is
        open.
      </p>
      {confirming ? (
        <ConfirmStep
          message="Stop the import? The orders imported so far stay."
          confirmLabel="Stop import"
          busyLabel="Stopping"
          busy={cancelling}
          onConfirm={onCancel}
          onCancel={() => setConfirming(false)}
          returnFocus={() => cancelRef.current}
        />
      ) : (
        <div>
          <button ref={cancelRef} type="button" onClick={() => setConfirming(true)} className={ui.buttonSecondary}>
            Stop import
          </button>
        </div>
      )}
      {cancelError ? <InlineMessage tone="bad">{cancelError}</InlineMessage> : null}
    </div>
  );
}

function StartForm({
  view,
  now,
  onStart,
  onEdit,
  busy,
  error,
}: {
  view: BackfillView;
  now: number;
  onStart: (body: { range: "all" } | { range: "since"; since: number }) => void;
  // The choice changed: an answer about the previous one no longer applies.
  onEdit: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [mode, setMode] = useState<Mode>(view.canReadAllOrders ? "all" : "since");
  const [date, setDate] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const latest = now > 0 ? latestStartDate(now) : undefined;
  const chosenSince = mode === "since" ? startOfLocalDay(date) : null;
  const blockedByScope =
    !view.canReadAllOrders && (mode === "all" || (chosenSince !== null && now > 0 && rangeNeedsAllOrders(chosenSince, now)));

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (blockedByScope) {
      return;
    }
    if (mode === "all") {
      onStart({ range: "all" });
      return;
    }
    const since = startOfLocalDay(date);
    if (since === null) {
      setDateError("Pick a start date.");
      return;
    }
    if (latest !== undefined && date > latest) {
      setDateError("Pick a date at least one day ago. Newer orders come in with the regular sync.");
      return;
    }
    setDateError(null);
    onStart({ range: "since", since });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <fieldset className="flex flex-col gap-2">
        <legend className={`${ui.label} mb-2`}>What to import</legend>
        {(
          [
            ["all", "All orders", "Every order the store has, oldest included."],
            ["since", "Orders since a date", "Orders placed on or after the day you pick."],
          ] as const
        ).map(([value, label, help]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-panel border px-3.5 py-3 transition-colors ${
              mode === value ? "border-primary-strong bg-surface" : "border-line hover:bg-surface-2"
            }`}
          >
            <input
              type="radio"
              name="history-range"
              value={value}
              checked={mode === value}
              onChange={() => {
                setMode(value);
                onEdit();
              }}
              className="mt-0.5 size-4 accent-[var(--primary-strong)]"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">{label}</span>
              <span className="block text-sm text-ink-2">{help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode === "since" ? (
        <Field
          id="history-since"
          label="Start date"
          help="At least one day ago. Dates more than 60 days back need the read_all_orders permission."
          error={dateError}
          className="sm:max-w-xs"
        >
          <input
            id="history-since"
            type="date"
            required
            min="2006-01-01"
            max={latest}
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setDateError(null);
              onEdit();
            }}
            aria-invalid={dateError ? true : undefined}
            aria-describedby={describedBy("history-since", { help: true, error: dateError })}
            className={`${ui.input} font-mono`}
          />
        </Field>
      ) : null}
      {!view.canReadAllOrders ? (
        <InlineMessage id="history-scope-hint" tone={blockedByScope ? "warn" : "info"}>
          {SCOPE_HINT}
        </InlineMessage>
      ) : null}
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap items-center gap-3">
        {/* A range the store's app cannot read cannot start (the server
            refuses it too); the hint above says why and how to fix it. */}
        <button
          type="submit"
          disabled={busy || blockedByScope}
          aria-describedby={blockedByScope ? "history-scope-hint" : undefined}
          className={ui.buttonPrimary}
        >
          <DownloadSimpleIcon size={16} aria-hidden />
          {busy ? "Starting" : "Start import"}
        </button>
        <p className="text-sm text-ink-2">Runs in the background, about 100 orders every 10 minutes.</p>
      </div>
    </form>
  );
}

export function OrderHistoryPanel({
  workspaceId,
  initial,
  connected,
  refreshSignal,
}: {
  workspaceId: string;
  initial: BackfillView;
  // The store is connected (not disconnected).
  connected: boolean;
  // Bumped after the store is connected again: the grant may have changed.
  refreshSignal: number;
}) {
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/backfill`;
  const [view, setView] = useState(initial);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const now = useNow(30000);

  const reload = useCallback(async () => {
    const result = await requestJson<{ backfill: BackfillView }>(url, { method: "GET" });
    if (result.ok) {
      setView(result.data.backfill);
    }
  }, [url]);

  // While an import runs, its count follows along (not in a hidden tab).
  useEffect(() => {
    if (view.status !== "running") {
      return;
    }
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void reload();
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [view.status, reload]);

  useEffect(() => {
    if (refreshSignal > 0) {
      void reload();
    }
  }, [refreshSignal, reload]);

  async function start(body: { range: "all" } | { range: "since"; since: number }) {
    setStarting(true);
    setStartError(null);
    const result = await requestJson<{ backfill: BackfillView }>(url, { method: "POST", json: body });
    setStarting(false);
    if (!result.ok) {
      setStartError(result.error);
      return;
    }
    setCancelError(null);
    setView(result.data.backfill);
    // The form is gone: the heading holds focus.
    focusSoon(() => document.getElementById(HEADING_ID));
  }

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    const result = await requestJson<{ backfill: BackfillView }>(url, { method: "DELETE" });
    setCancelling(false);
    if (!result.ok) {
      setCancelError(result.error);
      // It may have finished meanwhile: show where it is.
      void reload();
      return;
    }
    setView(result.data.backfill);
    focusSoon(() => document.getElementById(HEADING_ID));
  }

  const summary = historySummary(view, now > 0 ? (ms) => formatDate(ms) : null);

  return (
    <Panel className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-2">
            <ClockCounterClockwiseIcon size={20} aria-hidden />
          </span>
          <h3 id={HEADING_ID} tabIndex={-1} className="min-w-0 flex-1 font-medium text-ink">
            Order history
          </h3>
          {view.status === "running" ? <ToneChip tone="blue">Importing</ToneChip> : null}
        </div>
        <p className="max-w-[65ch] text-sm text-ink-2">
          The sync brings in orders from the last 60 days. Import older ones here. They arrive with the status their
          Shopify state implies, nobody is notified, and nothing changes in Shopify.
        </p>
      </div>
      {view.status === "running" ? (
        <Running view={view} now={now} onCancel={cancel} cancelling={cancelling} cancelError={cancelError} />
      ) : (
        <>
          {summary ? <InlineMessage tone={summary.tone}>{summary.text}</InlineMessage> : null}
          {connected ? (
            <StartForm
              view={view}
              now={now}
              onStart={start}
              onEdit={() => setStartError(null)}
              busy={starting}
              error={startError}
            />
          ) : (
            <p className="text-sm text-ink-2">Connect the store to import its order history.</p>
          )}
        </>
      )}
    </Panel>
  );
}
