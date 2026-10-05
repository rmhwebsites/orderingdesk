"use client";

// The purchase order review modal: the mandatory stop before anything goes
// to a vendor. Opened by a manager or platform admin from the drawer
// (Create purchase order, Review and send, Edit) or when a status change
// answers triggersPo. The vendor is picked from the workspace list (or
// added inline), the lines are prefilled from the order and editable (the
// unit cost is the reviewer's; an order whose stored item list is partial
// is prefilled from the full list read from Shopify, and when that cannot
// be read the lines start empty and sending stays blocked), the ship-to is
// prefilled and editable, and notes are optional. Save draft keeps it;
// Review and send saves it, then shows the confirmation step naming every
// recipient and what goes out, and only Send to vendor there sends it,
// bound to that exact content (when someone changed the PO meanwhile,
// nothing is sent: the step and the form show the PO as it would go out now
// and ask again). Nothing is ever sent from here without that step, and
// "Send to vendor" names nothing else.
//
// Full screen on phones, a centered panel from sm. The footer scrolls on
// its own, so its buttons stay reachable in a short window. The rest of
// the workspace (the drawer included) is inert while it is open, Esc and
// the scrim close it (asking first when there are unsaved changes), and
// focus returns where it was. A button disabled while it saves gets focus
// back when the save ends.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { XIcon } from "@phosphor-icons/react/X";
import { formatCents, type PoLine } from "@/lib/po";
import { savePoDraft } from "@/lib/po-client";
import { emptyLine, formFromOrder, formFromPo, formTotals, readForm, sameForm, type PoForm, type PoFormErrors, type PoFormLine } from "@/lib/po-form";
import { readSnapshot } from "@/lib/order-snapshot";
import type { VendorView } from "@/server/desk/vendors";
import type { PoView } from "@/server/po/service";
import { describedBy, Field, focusSoon, InlineMessage, SaveStatus, Select } from "@/components/settings/kit";
import { ui } from "@/components/ui";
import { SendConfirm, useSendFlow } from "./po-send-confirm";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; orderName: string; currency: string; nextNumber: string | null };

// Over the drawer (z-40), under toasts (z-50).
const LAYER = "z-[45]";

function ModalShell({
  labelledBy,
  onRequestClose,
  children,
}: {
  labelledBy: string;
  onRequestClose: () => void;
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTarget(document.getElementById("workspace-overlays") ?? document.body);
  }, []);

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const others = [document.getElementById("workspace-main"), document.querySelector<HTMLElement>("[data-drawer-state]")];
    // Only what this modal made inert is restored (the drawer already
    // makes the page inert while it is open).
    const made = others.filter((element): element is HTMLElement => element !== null && !element.hasAttribute("inert"));
    made.forEach((element) => element.setAttribute("inert", ""));
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      made.forEach((element) => element.removeAttribute("inert"));
      document.body.style.overflow = overflow;
      if (returnTo && returnTo.isConnected && returnTo !== document.body) {
        focusSoon(() => returnTo);
      }
    };
  }, []);

  useEffect(() => {
    if (target) {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [target]);

  if (!target) {
    return null;
  }
  return createPortal(
    <div className={`fixed inset-0 ${LAYER} flex items-stretch justify-center sm:items-center sm:p-6`}>
      <div aria-hidden className="absolute inset-0 bg-scrim" onClick={onRequestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onRequestClose();
          }
        }}
        className="od-rise relative flex h-full w-full flex-col bg-surface shadow-lift outline-none sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:max-w-3xl sm:rounded-panel sm:border sm:border-line"
      >
        {children}
      </div>
    </div>,
    target,
  );
}

// Body and footer both scroll, so header plus footer can never push the
// footer's buttons (the confirmation step's Send to vendor and Cancel) out
// of the panel in a short window (a phone held sideways, or 200% zoom).
// When room runs out the body gives it up first (its flex-shrink dwarfs
// the footer's, and from sm the panel's height comes from its content, so
// the body's basis is its full content height); only once the body is
// down to nothing does the footer shrink, and then it scrolls.
export function PoModalBody({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 shrink-[1000] overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">{children}</div>;
}

const FOOTER_ID = "po-footer";
const STATUS_ID = "po-status";
const HEADING_ID = "po-heading";

export function PoModalFooter({ children }: { children: React.ReactNode }) {
  return (
    <footer
      id={FOOTER_ID}
      className="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto overscroll-contain border-t border-line px-4 py-4 sm:px-6"
    >
      {children}
    </footer>
  );
}

type ModalMessage = { tone: "bad" | "warn" | "info"; text: string };

// The footer's message (a save or send that did not go through, or someone
// else sending the PO). Focusable from script, so focus can land on it when
// every footer button is disabled.
export function PoModalStatus({ message }: { message: ModalMessage | null }) {
  if (!message) {
    return null;
  }
  return (
    <div id={STATUS_ID} tabIndex={-1} className="rounded-panel outline-none">
      <InlineMessage tone={message.tone}>{message.text}</InlineMessage>
    </div>
  );
}

type FocusCandidate = { disabled?: boolean; getAttribute(name: string): string | null };

function canTakeFocus(element: FocusCandidate): boolean {
  return element.disabled !== true && element.getAttribute("aria-disabled") !== "true";
}

// Where focus goes after a save or a send that left the modal open: the
// button that was pressed when it is enabled again, else the first enabled
// control in the footer, else the first fallback there is (the status
// message, then the modal heading). Never a disabled button, which cannot
// take focus and would drop it to the page.
export function footerFocusTarget<T extends FocusCandidate>(
  preferred: T | null,
  footerControls: readonly T[],
  fallbacks: readonly (T | null)[],
): T | null {
  if (preferred && canTakeFocus(preferred)) {
    return preferred;
  }
  return footerControls.find(canTakeFocus) ?? fallbacks.find((element): element is T => element !== null) ?? null;
}

// The form's own buttons. Review and send opens the confirmation step;
// only that step's Send to vendor sends.
export function DraftActions({
  saved,
  saving,
  locked,
  sendBlocked,
  onSaveDraft,
  onReview,
}: {
  saved: string | null;
  saving: boolean;
  locked: boolean;
  // The order's full item list has not loaded: no review yet.
  sendBlocked: boolean;
  onSaveDraft: () => void;
  onReview: () => void;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
      <SaveStatus text={saved} />
      <button id="po-save-draft" type="button" onClick={onSaveDraft} disabled={locked} className={ui.buttonSecondary}>
        {saving ? "Saving" : "Save draft"}
      </button>
      <button id="po-send" type="button" onClick={onReview} disabled={locked || sendBlocked} className={ui.buttonPrimary}>
        Review and send
      </button>
    </div>
  );
}

// After a save or a send that did not close the modal, focus goes back to
// the footer button (disabled while it ran), or Close once the PO is sent;
// when that button is disabled (someone else is sending the PO), the first
// enabled footer control, else the status message, else the heading.
function focusFooter(id: "po-save-draft" | "po-send") {
  focusSoon(() => {
    const footer = document.getElementById(FOOTER_ID);
    const controls = footer
      ? Array.from(footer.querySelectorAll<HTMLElement & { disabled?: boolean }>("button, a[href], input, select, textarea"))
      : [];
    const preferred = (document.getElementById(id) ?? document.getElementById("po-done")) as (HTMLElement & { disabled?: boolean }) | null;
    return footerFocusTarget(preferred, controls, [document.getElementById(STATUS_ID), document.getElementById(HEADING_ID)]);
  });
}

type VendorDraft = { name: string; email: string; cc: string };

function InlineVendorAdd({
  workspaceId,
  onAdded,
  onCancel,
}: {
  workspaceId: string;
  onAdded: (vendor: VendorView) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<VendorDraft>({ name: "", email: "", cc: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    focusSoon(() => document.getElementById(`${id}-name`));
  }, [id]);

  async function add() {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/vendors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          email: draft.email,
          cc: draft.cc
            .split(/[,\s]+/)
            .map((email) => email.trim())
            .filter((email) => email.length > 0),
        }),
      });
      const body = (await response.json().catch(() => null)) as { vendor?: VendorView; error?: string } | null;
      if (!response.ok || !body?.vendor) {
        setError(body?.error ?? "The vendor was not added. Try again.");
        return;
      }
      onAdded(body.vendor);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-panel border border-line bg-surface-2 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="text-sm font-semibold text-ink">Add a vendor</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-name`} label="Vendor name">
          <input
            id={`${id}-name`}
            value={draft.name}
            maxLength={120}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            className={ui.input}
          />
        </Field>
        <Field id={`${id}-email`} label="Order email">
          <input
            id={`${id}-email`}
            type="email"
            value={draft.email}
            autoComplete="off"
            placeholder="orders@vendor.com"
            onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))}
            className={ui.input}
          />
        </Field>
      </div>
      <Field id={`${id}-cc`} label="Copy to" help="Optional. Other addresses at the vendor, separated by commas.">
        <input
          id={`${id}-cc`}
          value={draft.cc}
          autoComplete="off"
          aria-describedby={describedBy(`${id}-cc`, { help: true })}
          onChange={(event) => setDraft((current) => ({ ...current, cc: event.target.value }))}
          className={ui.input}
        />
      </Field>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void add()} disabled={busy} className={ui.buttonPrimary}>
          {busy ? "Adding" : "Add vendor"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={ui.buttonQuiet}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function LineRow({
  line,
  index,
  total,
  currency,
  errors,
  canRemove,
  onChange,
  onRemove,
}: {
  line: PoFormLine;
  index: number;
  total: number | null;
  currency: string;
  errors: PoFormErrors["lines"][string] | undefined;
  canRemove: boolean;
  onChange: (patch: Partial<PoFormLine>) => void;
  onRemove: () => void;
}) {
  const base = `po-line-${line.key}`;
  const n = index + 1;
  const cell = "flex min-w-0 flex-col gap-1";
  const label = "text-xs font-medium text-ink-2 sm:sr-only";
  const error = (field: keyof NonNullable<typeof errors>) =>
    errors?.[field] ? (
      <span id={`${base}-${field}-error`} className="text-xs text-bad">
        {errors[field]}
      </span>
    ) : null;
  const invalid = (field: keyof NonNullable<typeof errors>) =>
    errors?.[field] ? { "aria-invalid": true as const, "aria-describedby": `${base}-${field}-error` } : {};
  return (
    <li className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-panel border border-line p-3 sm:grid-cols-[minmax(0,1fr)_8rem_4.5rem_6.5rem_6rem_2.5rem] sm:items-start sm:gap-2 sm:rounded-none sm:border-0 sm:p-0">
      <div className={`${cell} col-span-2 sm:col-span-1`}>
        <label htmlFor={`${base}-description`} className={label}>
          Line {n} description
        </label>
        <input
          id={`${base}-description`}
          value={line.description}
          maxLength={300}
          onChange={(event) => onChange({ description: event.target.value })}
          className={`${ui.input} px-3`}
          {...invalid("description")}
        />
        {error("description")}
      </div>
      <div className={cell}>
        <label htmlFor={`${base}-sku`} className={label}>
          Line {n} SKU
        </label>
        <input
          id={`${base}-sku`}
          value={line.sku}
          maxLength={64}
          onChange={(event) => onChange({ sku: event.target.value })}
          className={`${ui.input} px-3 font-mono`}
          {...invalid("sku")}
        />
        {error("sku")}
      </div>
      <div className={cell}>
        <label htmlFor={`${base}-quantity`} className={label}>
          Line {n} quantity
        </label>
        <input
          id={`${base}-quantity`}
          value={line.quantity}
          inputMode="numeric"
          onChange={(event) => onChange({ quantity: event.target.value })}
          className={`${ui.input} px-3 text-right font-mono tabular-nums`}
          {...invalid("quantity")}
        />
        {error("quantity")}
      </div>
      <div className={cell}>
        <label htmlFor={`${base}-cost`} className={label}>
          Line {n} unit cost
        </label>
        <input
          id={`${base}-cost`}
          value={line.unitCost}
          inputMode="decimal"
          placeholder="0.00"
          onChange={(event) => onChange({ unitCost: event.target.value })}
          className={`${ui.input} px-3 text-right font-mono tabular-nums`}
          {...invalid("unitCost")}
        />
        {error("unitCost")}
      </div>
      <div className="flex min-h-10 items-center justify-between gap-2 sm:justify-end">
        <span className="text-xs font-medium text-ink-2 sm:sr-only">Line total</span>
        <span className="font-mono text-sm tabular-nums text-ink">{total === null ? "Not priced" : formatCents(total, currency)}</span>
      </div>
      <div className="col-span-2 flex items-center justify-end sm:col-span-1">
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          className={`${ui.buttonQuiet} h-10 sm:w-10 sm:px-0`}
        >
          <TrashIcon size={18} aria-hidden />
          <span className="sm:sr-only">Remove</span>
          <span className="sr-only"> line {n}</span>
        </button>
      </div>
    </li>
  );
}

export function PoModal({
  workspaceId,
  orderId,
  po: initialPo,
  onClose,
  onSaved,
  onSent,
}: {
  workspaceId: string;
  orderId: string;
  // An existing draft or failed PO to review, or null for a new one.
  po: PoView | null;
  onClose: () => void;
  onSaved: (po: PoView) => void;
  onSent: (po: PoView) => void;
}) {
  // One review modal is open at a time; the fixed id lets focusFooter find
  // the heading.
  const titleId = HEADING_ID;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [vendors, setVendors] = useState<VendorView[]>([]);
  const [po, setPo] = useState<PoView | null>(initialPo);
  const [form, setForm] = useState<PoForm | null>(null);
  const [baseline, setBaseline] = useState<PoForm | null>(null);
  const [errors, setErrors] = useState<PoFormErrors | null>(null);
  // After a Save or Send found problems, the form is checked again on
  // every change, so each message goes as soon as its field is fixed.
  const [checkMode, setCheckMode] = useState<{ requireCosts: boolean } | null>(null);
  const [message, setMessage] = useState<ModalMessage | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const [addingVendor, setAddingVendor] = useState(false);
  // A new PO whose order's full item list could not be read (the stored
  // list is partial): the lines start empty and Review and send stays
  // blocked until the list loads.
  const [linesProblem, setLinesProblem] = useState<string | null>(null);
  const [linesRetrying, setLinesRetrying] = useState(false);

  const flow = useSendFlow({
    onSent: (sentPo) => {
      onSent(sentPo);
      onClose();
    },
    onSettled: (current, text) => {
      setPo(current);
      onSaved(current);
      if (text) {
        setMessage({ tone: current.state === "failed" ? "bad" : "info", text });
      }
      // The step closed while focus was on its (disabled) send button.
      focusFooter("po-send");
    },
    // Someone changed the PO since this review (another manager saved it,
    // or its vendor was edited): nothing was sent. The step now shows what
    // would go out, and the form behind it shows the same.
    onChanged: (fresh) => {
      const next = formFromPo(fresh);
      setPo(fresh);
      setForm(next);
      setBaseline(next);
      setErrors(null);
      setCheckMode(null);
      setSaved(null);
      const shown = fresh.vendor && !fresh.vendor.archived ? fresh.vendor : null;
      if (shown) {
        setVendors((current) => {
          const entry = { id: shown.id, name: shown.name, email: shown.email, cc: shown.cc };
          const known = current.find((vendor) => vendor.id === shown.id);
          return known
            ? current.map((vendor) => (vendor.id === shown.id ? { ...vendor, ...entry } : vendor))
            : [...current, { ...entry, notes: null }].sort((a, b) => a.name.localeCompare(b.name));
        });
      }
      onSaved(fresh);
    },
  });

  const load = useCallback(async () => {
    setLoaded({ status: "loading" });
    try {
      const [orderResponse, vendorsResponse, listResponse, linesResponse] = await Promise.all([
        fetch(`/api/orders/${encodeURIComponent(orderId)}`, { cache: "no-store" }),
        fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/vendors`, { cache: "no-store" }),
        fetch(`/api/orders/${encodeURIComponent(orderId)}/pos`, { cache: "no-store" }),
        initialPo ? Promise.resolve(null) : fetch(`/api/orders/${encodeURIComponent(orderId)}/po-lines`, { cache: "no-store" }),
      ]);
      if (!orderResponse.ok || !vendorsResponse.ok || !listResponse.ok || (linesResponse && !linesResponse.ok && linesResponse.status !== 502)) {
        throw new Error("load");
      }
      const order = (await orderResponse.json()) as { order: { name: string; shopify: unknown } };
      const vendorList = (await vendorsResponse.json()) as { vendors: VendorView[] };
      const list = (await listResponse.json()) as { nextNumber: string | null };
      const snapshot = readSnapshot(order.order.shopify);
      let lines: PoLine[] | null = null;
      if (linesResponse) {
        const body = (await linesResponse.json().catch(() => null)) as { lines?: PoLine[]; error?: string } | null;
        lines = linesResponse.ok && Array.isArray(body?.lines) ? body.lines : null;
        setLinesProblem(lines ? null : (body?.error ?? "The order's full item list did not load."));
      }
      const first = initialPo ? formFromPo(initialPo) : formFromOrder(snapshot, lines);
      setVendors(vendorList.vendors);
      setForm(first);
      setBaseline(first);
      setLoaded({
        status: "ready",
        orderName: order.order.name,
        currency: initialPo?.currency ?? (snapshot.currency || "USD"),
        nextNumber: list.nextNumber,
      });
    } catch {
      setLoaded({ status: "error", message: "The order or the vendor list did not load. Check your connection and try again." });
    }
  }, [orderId, workspaceId, initialPo]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (form && checkMode) {
      const read = readForm(form, checkMode);
      setErrors(read.ok ? null : read.errors);
    }
  }, [form, checkMode]);

  // Tries the order's full item list again; on success it replaces the
  // (empty) lines it could not fill.
  async function retryLines() {
    setLinesRetrying(true);
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/po-lines`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { lines?: PoLine[]; error?: string } | null;
      if (response.ok && Array.isArray(body?.lines)) {
        const lines = formFromOrder(readSnapshot(null), body.lines).lines;
        setForm((current) => (current ? { ...current, lines } : current));
        setBaseline((current) => (current ? { ...current, lines } : current));
        setLinesProblem(null);
      } else {
        setLinesProblem(body?.error ?? "The order's full item list did not load.");
      }
    } catch {
      setLinesProblem("Could not reach the server. Check your connection and try again.");
    } finally {
      setLinesRetrying(false);
    }
  }

  const dirty = form !== null && baseline !== null && !sameForm(form, baseline);
  const totals = useMemo(() => (form ? formTotals(form) : null), [form]);
  const vendor = vendors.find((entry) => entry.id === form?.vendorId) ?? null;
  const locked = saving || flow.pending !== null || flow.busy || po?.state === "sent" || po?.state === "sending";

  const requestClose = useCallback(() => {
    if (flow.busy || saving) {
      return;
    }
    if (dirty && !askDiscard) {
      setAskDiscard(true);
      focusSoon(() => document.getElementById("po-keep-editing"));
      return;
    }
    onClose();
  }, [flow.busy, saving, dirty, askDiscard, onClose]);

  function update(patch: Partial<PoForm>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setSaved(null);
    setAskDiscard(false);
  }

  function updateLine(key: string, patch: Partial<PoFormLine>) {
    setForm((current) =>
      current ? { ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) } : current,
    );
    setSaved(null);
    setAskDiscard(false);
  }

  function addLine() {
    const line = emptyLine();
    setForm((current) => (current ? { ...current, lines: [...current.lines, line] } : current));
    focusSoon(() => document.getElementById(`po-line-${line.key}-description`));
  }

  function removeLine(index: number) {
    if (!form) {
      return;
    }
    const rest = form.lines.filter((_, i) => i !== index);
    update({ lines: rest });
    const next = rest[Math.min(index, rest.length - 1)];
    focusSoon(() => (next ? document.getElementById(`po-line-${next.key}-description`) : document.getElementById("po-add-line")));
  }

  function focusFirstError(found: PoFormErrors) {
    if (found.vendor) {
      focusSoon(() => document.getElementById("po-vendor"));
      return;
    }
    const lineKey = form?.lines.find((line) => found.lines[line.key])?.key;
    if (lineKey) {
      const fields = found.lines[lineKey];
      const field = fields.description ? "description" : fields.sku ? "sku" : fields.quantity ? "quantity" : "cost";
      focusSoon(() => document.getElementById(`po-line-${lineKey}-${field}`));
      return;
    }
    if (found.shipTo) {
      focusSoon(() => document.getElementById("po-ship-to"));
    } else if (found.notes) {
      focusSoon(() => document.getElementById("po-notes"));
    } else if (found.form) {
      focusSoon(() => document.getElementById("po-add-line"));
    }
  }

  // Saves the form (creating the draft the first time). Returns the saved
  // PO, or null with the problem shown. The footer is disabled while it
  // saves; a failed save gives focus back to the button that was pressed
  // (`from`), a successful one leaves that to the caller.
  async function save(requireCosts: boolean, from: "po-save-draft" | "po-send"): Promise<PoView | null> {
    if (!form) {
      return null;
    }
    const read = readForm(form, { requireCosts });
    if (!read.ok) {
      setErrors(read.errors);
      setCheckMode({ requireCosts });
      setMessage(null);
      focusFirstError(read.errors);
      return null;
    }
    setErrors(null);
    setCheckMode(null);
    if (po && !dirty) {
      return po;
    }
    setSaving(true);
    setMessage(null);
    const result = await savePoDraft(orderId, po?.id ?? null, read.body);
    setSaving(false);
    if (!result.ok) {
      if (result.po) {
        setPo(result.po);
        onSaved(result.po);
      }
      setMessage({ tone: "bad", text: result.message });
      focusFooter(from);
      return null;
    }
    setPo(result.po);
    setBaseline(form);
    onSaved(result.po);
    return result.po;
  }

  async function saveDraft() {
    const result = await save(false, "po-save-draft");
    if (result) {
      setSaved("Draft saved");
      focusFooter("po-save-draft");
    }
  }

  async function startSend() {
    if (linesProblem) {
      setMessage({ tone: "warn", text: "Sending waits until the order's full item list loads. Try loading it again above." });
      return;
    }
    const result = await save(true, "po-send");
    if (!result) {
      return;
    }
    const label = result.number ? `purchase order ${result.number}` : "this purchase order";
    // The confirmation step takes focus itself (its question).
    if (!flow.start(result, { label, resend: false })) {
      setMessage({ tone: "bad", text: "Pick a vendor from the list before sending." });
      focusFooter("po-send");
    }
  }

  const ready = loaded.status === "ready" && form !== null;
  const header =
    loaded.status === "ready"
      ? po?.number
        ? `Number ${po.number}`
        : loaded.nextNumber
          ? `Number when sent: ${loaded.nextNumber}`
          : null
      : null;

  return (
    <ModalShell labelledBy={titleId} onRequestClose={requestClose}>
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 id={titleId} tabIndex={-1} className="font-display text-lg font-semibold text-ink outline-none">
            {loaded.status === "ready" ? `Purchase order for ${loaded.orderName}` : "Purchase order"}
          </h2>
          {header ? <p className="mt-0.5 font-mono text-sm tabular-nums text-ink-2">{header}</p> : null}
        </div>
        <button type="button" onClick={requestClose} className={`${ui.iconButton} -mr-2 -mt-1`} disabled={flow.busy || saving}>
          <XIcon size={20} aria-hidden />
          <span className="sr-only">Close purchase order</span>
        </button>
      </header>

      <PoModalBody>
        {loaded.status === "loading" ? (
          <div aria-label="Loading the purchase order" className="flex flex-col gap-3">
            <span className="od-skeleton h-4 w-32" />
            <span className="od-skeleton h-10 w-full" />
            <span className="od-skeleton mt-4 h-4 w-24" />
            <span className="od-skeleton h-10 w-full" />
            <span className="od-skeleton h-10 w-full" />
          </div>
        ) : null}

        {loaded.status === "error" ? (
          <div className="flex flex-col items-start gap-3">
            <InlineMessage tone="bad">{loaded.message}</InlineMessage>
            <button type="button" onClick={() => void load()} className={ui.buttonSecondary}>
              Try again
            </button>
          </div>
        ) : null}

        {ready && form && totals ? (
          <fieldset disabled={locked} className="flex min-w-0 flex-col gap-6">
            <legend className="sr-only">Purchase order details</legend>
            {po?.state === "failed" && po.lastError ? (
              <InlineMessage tone="bad">The last send did not go out: {po.lastError}</InlineMessage>
            ) : null}
            {po?.state === "sent" ? (
              <InlineMessage tone="info">This purchase order was sent, so it can no longer be changed.</InlineMessage>
            ) : null}

            <div className="flex flex-col gap-3">
              <Field id="po-vendor" label="Vendor" error={errors?.vendor}>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Select
                    id="po-vendor"
                    value={form.vendorId}
                    onChange={(event) => update({ vendorId: event.target.value })}
                    aria-invalid={errors?.vendor ? true : undefined}
                    aria-describedby={describedBy("po-vendor", { error: errors?.vendor })}
                    className="min-w-0 flex-1"
                  >
                    <option value="">{vendors.length === 0 ? "No vendors yet: add one" : "Choose a vendor"}</option>
                    {vendors.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                  {!addingVendor ? (
                    <button type="button" onClick={() => setAddingVendor(true)} className={ui.buttonSecondary}>
                      <PlusIcon size={16} aria-hidden />
                      Add vendor
                    </button>
                  ) : null}
                </div>
              </Field>
              {vendor ? (
                <p className="break-words text-sm text-ink-2">
                  Goes to {vendor.email}
                  {vendor.cc.length > 0 ? `, with copies to ${vendor.cc.join(", ")}` : ""}. Copies also go to the workspace email
                  list, if one is set. You confirm every address before it is sent.
                </p>
              ) : null}
              {addingVendor ? (
                <InlineVendorAdd
                  workspaceId={workspaceId}
                  onCancel={() => {
                    setAddingVendor(false);
                    focusSoon(() => document.getElementById("po-vendor"));
                  }}
                  onAdded={(added) => {
                    setVendors((current) => [...current, added].sort((a, b) => a.name.localeCompare(b.name)));
                    update({ vendorId: added.id });
                    setAddingVendor(false);
                    focusSoon(() => document.getElementById("po-vendor"));
                  }}
                />
              ) : null}
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="font-display text-sm font-semibold text-ink">Lines</h3>
              {linesProblem ? (
                <div className="flex flex-col items-start gap-2">
                  <InlineMessage tone="warn">
                    {linesProblem} Sending is blocked until the full list loads, so no item is left out by mistake.
                  </InlineMessage>
                  <button type="button" onClick={() => void retryLines()} disabled={linesRetrying} className={ui.buttonSecondary}>
                    {linesRetrying ? "Loading" : "Load the full list again"}
                  </button>
                </div>
              ) : (
                <p className="-mt-2 text-sm text-ink-2">
                  Copied from the order. Enter what the vendor charges for each; you can change, add or remove lines.
                </p>
              )}
              <div
                aria-hidden
                className="hidden gap-2 text-xs font-medium text-ink-2 sm:grid sm:grid-cols-[minmax(0,1fr)_8rem_4.5rem_6.5rem_6rem_2.5rem]"
              >
                <span>Description</span>
                <span>SKU</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Unit cost</span>
                <span className="text-right">Line total</span>
                <span />
              </div>
              <ul className="flex flex-col gap-3 sm:gap-2">
                {form.lines.map((line, index) => (
                  <LineRow
                    key={line.key}
                    line={line}
                    index={index}
                    total={totals.lineTotals[line.key] ?? null}
                    currency={loaded.currency}
                    errors={errors?.lines[line.key]}
                    canRemove={form.lines.length > 1}
                    onChange={(patch) => updateLine(line.key, patch)}
                    onRemove={() => removeLine(index)}
                  />
                ))}
              </ul>
              {errors?.form ? <p className={ui.errorText}>{errors.form}</p> : null}
              <div className="flex flex-wrap items-start justify-between gap-4">
                <button id="po-add-line" type="button" onClick={addLine} className={ui.buttonQuiet}>
                  <PlusIcon size={16} aria-hidden />
                  Add line
                </button>
                <dl className="ml-auto flex min-w-56 flex-col gap-1.5 text-sm">
                  <div className="flex justify-between gap-6">
                    <dt className="text-ink-2">Subtotal</dt>
                    <dd className="font-mono tabular-nums text-ink">
                      {totals.subtotalCents === null ? "Not priced" : formatCents(totals.subtotalCents, loaded.currency)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-6 border-t border-line pt-1.5">
                    <dt className="font-semibold text-ink">Total</dt>
                    <dd className="font-mono font-semibold tabular-nums text-ink">
                      {totals.subtotalCents === null ? "Not priced" : formatCents(totals.subtotalCents, loaded.currency)}
                    </dd>
                  </div>
                  {totals.subtotalCents === null ? (
                    <p className="text-xs text-ink-2">Enter a unit cost on every line to see the total.</p>
                  ) : null}
                </dl>
              </div>
            </div>

            <Field id="po-ship-to" label="Ship to" help="From the order. One line per row; printed on the purchase order." error={errors?.shipTo}>
              <textarea
                id="po-ship-to"
                rows={5}
                value={form.shipTo}
                onChange={(event) => update({ shipTo: event.target.value })}
                aria-invalid={errors?.shipTo ? true : undefined}
                aria-describedby={describedBy("po-ship-to", { help: true, error: errors?.shipTo })}
                className={ui.textarea}
              />
            </Field>

            <Field id="po-notes" label="Notes" help="Optional. Printed on the purchase order and shown in the email." error={errors?.notes}>
              <textarea
                id="po-notes"
                rows={3}
                maxLength={2000}
                value={form.notes}
                onChange={(event) => update({ notes: event.target.value })}
                aria-invalid={errors?.notes ? true : undefined}
                aria-describedby={describedBy("po-notes", { help: true, error: errors?.notes })}
                className={ui.textarea}
              />
            </Field>
          </fieldset>
        ) : null}
      </PoModalBody>

      {ready ? (
        <PoModalFooter>
          {errors ? <InlineMessage tone="bad">Check the highlighted fields.</InlineMessage> : null}
          <PoModalStatus message={message} />
          {flow.pending ? (
            <SendConfirm
              pending={flow.pending}
              busy={flow.busy}
              onConfirm={() => void flow.confirm()}
              onCancel={() => {
                flow.cancel();
                focusFooter("po-send");
              }}
            />
          ) : askDiscard ? (
            <div
              data-tone="red"
              className="flex flex-col gap-3 rounded-panel border border-line bg-surface-2 p-3.5 sm:flex-row sm:items-center"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setAskDiscard(false);
                  focusFooter("po-send");
                }
              }}
            >
              <p className="min-w-0 flex-1 text-sm text-ink">Close without saving your changes?</p>
              <div className="flex shrink-0 flex-col-reverse gap-2 sm:flex-row">
                <button
                  id="po-keep-editing"
                  type="button"
                  onClick={() => {
                    setAskDiscard(false);
                    focusFooter("po-send");
                  }}
                  className={ui.buttonSecondary}
                >
                  Keep editing
                </button>
                <button type="button" onClick={onClose} className={ui.buttonDanger}>
                  Discard changes
                </button>
              </div>
            </div>
          ) : po?.state === "sent" ? (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <SaveStatus text={saved} />
              <button id="po-done" type="button" onClick={onClose} className={ui.buttonSecondary}>
                Close
              </button>
            </div>
          ) : (
            <DraftActions
              saved={saved}
              saving={saving}
              locked={locked}
              sendBlocked={linesProblem !== null}
              onSaveDraft={() => void saveDraft()}
              onReview={() => void startSend()}
            />
          )}
        </PoModalFooter>
      ) : null}
    </ModalShell>
  );
}
