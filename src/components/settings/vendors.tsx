"use client";

import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TruckIcon } from "@phosphor-icons/react/Truck";
import type { VendorView } from "@/server/desk/vendors";
import { ui } from "@/components/ui";
import { ConfirmStep, describedBy, Field, InlineMessage, Panel, requestJson, SettingsSection } from "./kit";

type Draft = { name: string; email: string; cc: string; notes: string };

const EMPTY: Draft = { name: "", email: "", cc: "", notes: "" };

function draftOf(vendor: VendorView): Draft {
  return { name: vendor.name, email: vendor.email, cc: vendor.cc.join(", "), notes: vendor.notes ?? "" };
}

function bodyOf(draft: Draft) {
  return {
    name: draft.name,
    email: draft.email,
    cc: draft.cc
      .split(/[,\s]+/)
      .map((email) => email.trim())
      .filter((email) => email.length > 0),
    notes: draft.notes.trim().length > 0 ? draft.notes : null,
  };
}

function VendorForm({
  idPrefix,
  initial,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  initial: Draft;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (draft: Draft) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) {
          return;
        }
        setBusy(true);
        setError(null);
        const problem = await onSubmit(draft);
        setBusy(false);
        if (problem) {
          setError(problem);
        } else if (!onCancel) {
          setDraft(EMPTY);
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${idPrefix}-name`} label="Vendor name">
          <input
            id={`${idPrefix}-name`}
            required
            maxLength={120}
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
            className={ui.input}
          />
        </Field>
        <Field id={`${idPrefix}-email`} label="Order email">
          <input
            id={`${idPrefix}-email`}
            type="email"
            required
            value={draft.email}
            onChange={(event) => set({ email: event.target.value })}
            placeholder="orders@vendor.com"
            autoComplete="off"
            className={ui.input}
          />
        </Field>
      </div>
      <Field id={`${idPrefix}-cc`} label="Copy to" help="Optional. Up to 10 more addresses, separated by commas.">
        <input
          id={`${idPrefix}-cc`}
          value={draft.cc}
          onChange={(event) => set({ cc: event.target.value })}
          autoComplete="off"
          aria-describedby={describedBy(`${idPrefix}-cc`, { help: true })}
          className={ui.input}
        />
      </Field>
      <Field id={`${idPrefix}-notes`} label="Notes" help="Optional. Account numbers, lead times, who to call.">
        <textarea
          id={`${idPrefix}-notes`}
          rows={2}
          maxLength={2000}
          value={draft.notes}
          onChange={(event) => set({ notes: event.target.value })}
          aria-describedby={describedBy(`${idPrefix}-notes`, { help: true })}
          className={ui.textarea}
        />
      </Field>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={onCancel ? ui.buttonPrimary : ui.buttonSecondary}>
          {onCancel ? null : <PlusIcon size={16} aria-hidden />}
          {busy ? busyLabel : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonQuiet}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function VendorsSection({
  workspaceId,
  initial,
  canEdit,
}: {
  workspaceId: string;
  initial: VendorView[];
  canEdit: boolean;
}) {
  const [vendors, setVendors] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/vendors`;
  const sorted = (list: VendorView[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

  async function create(draft: Draft): Promise<string | null> {
    const result = await requestJson<{ vendor: VendorView }>(base, { method: "POST", json: bodyOf(draft) });
    if (!result.ok) {
      return result.error;
    }
    setVendors((current) => sorted([...current, result.data.vendor]));
    return null;
  }

  async function update(id: string, draft: Draft): Promise<string | null> {
    const result = await requestJson<{ vendor: VendorView }>(`${base}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      json: bodyOf(draft),
    });
    if (!result.ok) {
      return result.error;
    }
    setVendors((current) => sorted(current.map((vendor) => (vendor.id === id ? result.data.vendor : vendor))));
    setEditing(null);
    return null;
  }

  async function remove(id: string) {
    setRemoveBusy(true);
    setRemoveError(null);
    const result = await requestJson<{ ok: true }>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
    setRemoveBusy(false);
    if (!result.ok) {
      setRemoveError(result.error);
      return;
    }
    setVendors((current) => current.filter((vendor) => vendor.id !== id));
    setRemoving(null);
  }

  return (
    <SettingsSection
      id="vendors"
      title="Vendors"
      description={
        canEdit
          ? "Where purchase orders go. Each order's purchase order is sent to the vendor you pick, after you review it."
          : "Where purchase orders go. Managers add and edit vendors."
      }
    >
      <Panel>
        {vendors.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <span className="grid size-10 place-items-center rounded-control bg-surface-2 text-ink-2">
              <TruckIcon size={20} aria-hidden />
            </span>
            <p className="font-medium text-ink">No vendors yet</p>
            <p className="text-sm text-ink-2">
              {canEdit ? "Add the first vendor below." : "A manager adds the vendors purchase orders go to."}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {vendors.map((vendor) => (
              <li key={vendor.id} className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0">
                {editing === vendor.id ? (
                  <VendorForm
                    idPrefix={`vendor-${vendor.id}`}
                    initial={draftOf(vendor)}
                    submitLabel="Save vendor"
                    busyLabel="Saving"
                    onSubmit={(draft) => update(vendor.id, draft)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">{vendor.name}</p>
                      <p className="break-all text-sm text-ink-2">
                        {vendor.email}
                        {vendor.cc.length > 0 ? `, copy to ${vendor.cc.join(", ")}` : ""}
                      </p>
                      {vendor.notes ? <p className="mt-1 whitespace-pre-line break-words text-sm text-ink-2">{vendor.notes}</p> : null}
                    </div>
                    {canEdit ? (
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(vendor.id)}
                          className={ui.buttonQuiet}
                          aria-label={`Edit ${vendor.name}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoving(vendor.id)}
                          className={ui.buttonQuiet}
                          aria-label={`Remove ${vendor.name}`}
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
                {removing === vendor.id ? (
                  <ConfirmStep
                    message={`Remove ${vendor.name}? It leaves the vendor list; purchase orders already sent to it keep their history.`}
                    confirmLabel="Remove"
                    busyLabel="Removing"
                    busy={removeBusy}
                    onConfirm={() => void remove(vendor.id)}
                    onCancel={() => setRemoving(null)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {removeError ? (
          <div className="mt-3">
            <InlineMessage tone="bad">{removeError}</InlineMessage>
          </div>
        ) : null}
      </Panel>
      {canEdit ? (
        <Panel className="flex flex-col gap-4">
          <h3 className="font-display text-base font-semibold text-ink">Add a vendor</h3>
          <VendorForm idPrefix="vendor-new" initial={EMPTY} submitLabel="Add vendor" busyLabel="Adding" onSubmit={create} />
        </Panel>
      ) : null}
    </SettingsSection>
  );
}
