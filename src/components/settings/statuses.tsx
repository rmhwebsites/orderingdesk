"use client";

import { useRef, useState } from "react";
import { ArrowDownIcon } from "@phosphor-icons/react/ArrowDown";
import { ArrowUpIcon } from "@phosphor-icons/react/ArrowUp";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { STATUS_LABEL_MAX } from "@/lib/status-label";
import type { StatusView } from "@/server/desk/shapes";
import { ui } from "@/components/ui";
import { InlineMessage, Panel, requestJson, SaveStatus, Select, SettingsSection, Switch } from "./kit";

// The nine status colors (STATUS_COLORS in src/server/desk/statuses.ts),
// each a semantic token pair in globals.css.
const COLORS = ["lime", "blue", "amber", "green", "teal", "violet", "red", "slate", "pink"] as const;
const LINKS = [
  { value: "", label: "No Shopify link" },
  { value: "fulfilled", label: "Fulfilled in Shopify" },
  { value: "delivered", label: "Delivered in Shopify" },
] as const;
const LIST_MAX = 20;

type Row = {
  uid: string;
  key: string | null;
  label: string;
  color: string;
  triggersPo: boolean;
  shopifyLink: "fulfilled" | "delivered" | null;
};

type InUse = { key: string; label: string; count: number };

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function rowsOf(statuses: StatusView[]): Row[] {
  return statuses.map((status) => ({
    uid: status.key,
    key: status.key,
    label: status.label,
    color: status.color,
    triggersPo: status.triggersPo,
    shopifyLink: status.shopifyLink,
  }));
}

function payload(rows: Row[]) {
  return rows.map((row) => ({
    ...(row.key ? { key: row.key } : {}),
    label: row.label,
    color: row.color,
    triggersPo: row.triggersPo,
    shopifyLink: row.shopifyLink,
  }));
}

export function StatusesSection({ workspaceId, initial }: { workspaceId: string; initial: StatusView[] }) {
  const [saved, setSaved] = useState<Row[]>(() => rowsOf(initial));
  const [rows, setRows] = useState<Row[]>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inUse, setInUse] = useState<InUse[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const nextId = useRef(1);
  const dirty = JSON.stringify(payload(rows)) !== JSON.stringify(payload(saved));

  function update(uid: string, patch: Partial<Row>) {
    setDone(null);
    setRows((current) => current.map((row) => (row.uid === uid ? { ...row, ...patch } : row)));
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) {
      return;
    }
    const next = [...rows];
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row);
    setRows(next);
    setDone(null);
    setAnnouncement(`${row.label || "Status"} moved to position ${target + 1} of ${next.length}.`);
    // Keep focus on the same button of the moved row so it can move again;
    // at the top or bottom that button is disabled, so take the other one.
    const atEdge = target === 0 || target === next.length - 1;
    const direction = (delta < 0) !== atEdge ? "up" : "down";
    requestAnimationFrame(() => {
      document.getElementById(`status-${row.uid}-${direction}`)?.focus();
    });
  }

  function add() {
    const uid = `new-${nextId.current++}`;
    setRows((current) => [...current, { uid, key: null, label: "", color: "blue", triggersPo: false, shopifyLink: null }]);
    setDone(null);
    requestAnimationFrame(() => document.getElementById(`status-${uid}-label`)?.focus());
  }

  async function save() {
    setBusy(true);
    setError(null);
    setInUse([]);
    setDone(null);
    const result = await requestJson<{ statuses: StatusView[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/statuses`, {
      method: "PUT",
      json: payload(rows),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      const list = result.data?.inUse;
      setInUse(Array.isArray(list) ? (list as InUse[]) : []);
      return;
    }
    const next = rowsOf(result.data.statuses);
    setSaved(next);
    setRows(next);
    setDone("Statuses saved.");
  }

  return (
    <SettingsSection
      id="statuses"
      title="Statuses"
      description="The steps an order moves through, in order. New orders from Shopify start in the first status."
    >
      <Panel className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">
          A status linked to a Shopify state works both ways: moving an order into it updates Shopify (a status linked
          to Fulfilled creates the fulfillment without emailing the customer), and when Shopify reports the order
          fulfilled or delivered, the order moves into that status here. Each status also shows on the Shopify order
          as a tag, so names can be up to {STATUS_LABEL_MAX} characters.
        </p>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        <ol className="flex flex-col gap-3">
          {rows.map((row, index) => {
            const id = `status-${row.uid}`;
            return (
              <li key={row.uid} className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span className="hidden w-6 shrink-0 text-center font-mono text-xs tabular-nums text-ink-2 sm:inline">{index + 1}</span>
                  <div className="flex shrink-0">
                    <button
                      id={`${id}-up`}
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${row.label || "this status"} up`}
                      className={`${ui.iconButton} size-9`}
                    >
                      <ArrowUpIcon size={16} aria-hidden />
                    </button>
                    <button
                      id={`${id}-down`}
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === rows.length - 1}
                      aria-label={`Move ${row.label || "this status"} down`}
                      className={`${ui.iconButton} size-9`}
                    >
                      <ArrowDownIcon size={16} aria-hidden />
                    </button>
                  </div>
                  <label htmlFor={`${id}-label`} className="sr-only">
                    Status name
                  </label>
                  <input
                    id={`${id}-label`}
                    value={row.label}
                    maxLength={STATUS_LABEL_MAX}
                    placeholder="Status name"
                    onChange={(event) => update(row.uid, { label: event.target.value })}
                    className={`${ui.input} min-w-0 flex-1`}
                  />
                  {/* The live chip: the status as the desk will show it. */}
                  <span aria-hidden className="hidden w-32 shrink-0 justify-end sm:flex">
                    <span
                      data-tone={row.color}
                      className="inline-flex h-7 max-w-full items-center truncate rounded-control bg-tone-fill px-2.5 text-xs font-semibold text-tone-text"
                    >
                      {row.label || "New status"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRows((current) => current.filter((candidate) => candidate.uid !== row.uid));
                      setDone(null);
                    }}
                    disabled={rows.length <= 1}
                    aria-label={`Remove ${row.label || "this status"}`}
                    className={`${ui.iconButton} size-9`}
                  >
                    <TrashIcon size={16} aria-hidden />
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center sm:pl-28">
                  <div className="flex min-w-0 items-center gap-2">
                    <label htmlFor={`${id}-color`} className="sr-only">
                      Color for {row.label || "this status"}
                    </label>
                    <Select
                      id={`${id}-color`}
                      value={row.color}
                      onChange={(event) => update(row.uid, { color: event.target.value })}
                      className="min-w-0 flex-1"
                    >
                      {COLORS.map((color) => (
                        <option key={color} value={color}>
                          {capitalize(color)}
                        </option>
                      ))}
                    </Select>
                    <span
                      data-tone={row.color}
                      aria-hidden
                      className="inline-flex h-7 max-w-[9rem] shrink-0 items-center truncate rounded-control bg-tone-fill px-2.5 text-xs font-semibold text-tone-text sm:hidden"
                    >
                      {row.label || "New status"}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <label htmlFor={`${id}-link`} className="sr-only">
                      Shopify link for {row.label || "this status"}
                    </label>
                    <Select
                      id={`${id}-link`}
                      value={row.shopifyLink ?? ""}
                      onChange={(event) => update(row.uid, { shopifyLink: (event.target.value || null) as Row["shopifyLink"] })}
                    >
                      {LINKS.map((link) => (
                        <option key={link.value} value={link.value}>
                          {link.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <Switch
                    id={`${id}-po`}
                    checked={row.triggersPo}
                    onChange={(checked) => update(row.uid, { triggersPo: checked })}
                    label="Starts a purchase order"
                  />
                </div>
              </li>
            );
          })}
        </ol>
        <div>
          <button type="button" onClick={add} disabled={rows.length >= LIST_MAX} className={ui.buttonSecondary}>
            <PlusIcon size={16} aria-hidden />
            Add status
          </button>
        </div>
        {error ? (
          <InlineMessage tone="bad">
            {error}
            {inUse.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {inUse.map((status) => (
                  <li key={status.key}>
                    {status.label}: {status.count} {status.count === 1 ? "order" : "orders"}
                  </li>
                ))}
              </ul>
            ) : null}
          </InlineMessage>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <button type="button" onClick={save} disabled={busy || !dirty} className={ui.buttonPrimary}>
            {busy ? "Saving" : "Save statuses"}
          </button>
          {dirty ? (
            <button
              type="button"
              onClick={() => {
                setRows(saved);
                setError(null);
                setInUse([]);
              }}
              disabled={busy}
              className={ui.buttonQuiet}
            >
              Discard changes
            </button>
          ) : null}
          <SaveStatus text={done} />
        </div>
      </Panel>
    </SettingsSection>
  );
}
