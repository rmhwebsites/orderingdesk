"use client";

import { useState } from "react";
import type { PriceDisplay, QueueSettingsView } from "@/lib/queue-settings";
import { Segmented, Spinner, type SegmentedOption } from "@/components/kit";
import { ui } from "@/components/ui";
import { Field, InlineMessage, Panel, requestJson, SaveStatus } from "./kit";

const PRICE_OPTIONS: SegmentedOption<PriceDisplay>[] = [
  { value: "auto", label: "Automatic" },
  { value: "show", label: "Show" },
  { value: "hide", label: "Hide" },
];

// Settings > Statuses, second panel: when an open card's age turns amber
// and red, and whether the desk shows totals and the Paid chip.
export function QueueSettingsPanel({ workspaceId, initial }: { workspaceId: string; initial: QueueSettingsView }) {
  const [saved, setSaved] = useState(initial);
  const [amber, setAmber] = useState(String(initial.ageAmberDays));
  const [red, setRed] = useState(String(initial.ageRedDays));
  const [display, setDisplay] = useState<PriceDisplay>(initial.priceDisplay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dirty = amber !== String(saved.ageAmberDays) || red !== String(saved.ageRedDays) || display !== saved.priceDisplay;

  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestJson<{ queue: QueueSettingsView }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/queue-settings`,
      { method: "PUT", json: { ageAmberDays: Number(amber), ageRedDays: Number(red), priceDisplay: display } },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(result.data.queue);
    setAmber(String(result.data.queue.ageAmberDays));
    setRed(String(result.data.queue.ageRedDays));
    setDisplay(result.data.queue.priceDisplay);
    setDone("Work queue saved.");
  }

  const edited = () => setDone(null);

  return (
    <Panel className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Waiting time and prices</h3>
        <p className="mt-1 max-w-[65ch] text-sm text-ink-2">
          Every open card shows how long it has been in its status. The age turns amber, then red, after these many days.
        </p>
      </div>
      <div className="grid max-w-md gap-4 sm:grid-cols-2">
        <Field id="queue-amber" label="Amber after (days)">
          <input
            id="queue-amber"
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            step={1}
            value={amber}
            onChange={(event) => {
              setAmber(event.target.value);
              edited();
            }}
            aria-invalid={error ? true : undefined}
            className={ui.input}
          />
        </Field>
        <Field id="queue-red" label="Red after (days)">
          <input
            id="queue-red"
            type="number"
            inputMode="numeric"
            min={2}
            max={90}
            step={1}
            value={red}
            onChange={(event) => {
              setRed(event.target.value);
              edited();
            }}
            aria-invalid={error ? true : undefined}
            className={ui.input}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <p aria-hidden className={ui.label}>
          Show prices
        </p>
        <p className="max-w-[65ch] text-sm text-ink-2">
          Automatic hides totals and the Paid chip when nearly every order is $0, as on a company store with free items. A
          card with a price still says so.
        </p>
        <Segmented
          name="queue-prices"
          legend="Show prices"
          value={display}
          options={PRICE_OPTIONS}
          onChange={(next) => {
            setDisplay(next);
            edited();
          }}
        />
      </div>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="button" onClick={() => void save()} disabled={busy || !dirty} aria-busy={busy || undefined} className={ui.buttonPrimary}>
          {busy ? <Spinner /> : null}
          {busy ? "Saving" : "Save work queue"}
        </button>
        <SaveStatus text={done} />
      </div>
    </Panel>
  );
}
