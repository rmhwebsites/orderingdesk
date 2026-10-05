"use client";

// The order drawer's Purchase orders section: every PO of the order with
// its number, vendor, state, total and date, Open PDF, and for managers
// and platform admins Create purchase order, Edit (draft or failed), Retry
// (failed) and Send again (sent), each send behind the confirmation step.
// Staff see the history and the PDFs only. It reloads when its refreshKey
// changes (a save, a send, or a purchase order event from someone else).

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { FilePdfIcon } from "@phosphor-icons/react/FilePdf";
import { FilePlusIcon } from "@phosphor-icons/react/FilePlus";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";
import { formatDate } from "@/lib/format";
import { costToCents, formatCents } from "@/lib/po";
import { loadPoList, poDateLine, poStateChip } from "@/lib/po-client";
import type { PoView } from "@/server/po/service";
import { focusSoon, InlineMessage, ToneChip } from "@/components/settings/kit";
import { useToast } from "@/components/toasts";
import { ui } from "@/components/ui";
import { SendConfirm, useSendFlow } from "./po-send-confirm";

type ListState = { status: "loading" } | { status: "error" } | { status: "ready"; pos: PoView[] };

const small = "h-8 px-3 text-xs";

function rowFocusId(poId: string): string {
  return `po-${poId}-number`;
}

function poLabel(po: PoView): string {
  return po.number ? `purchase order ${po.number}` : "this purchase order";
}

function totalOf(po: PoView): string | null {
  const cents = po.subtotal === null ? null : costToCents(po.subtotal);
  return cents === null ? null : formatCents(cents, po.currency);
}

export function PurchaseOrders({
  orderId,
  canManage,
  refreshKey,
  onCreate,
  onEdit,
  onChanged,
}: {
  orderId: string;
  canManage: boolean;
  refreshKey: number;
  onCreate: () => void;
  onEdit: (po: PoView) => void;
  // A send from here changed a PO (the drawer's timeline follows through
  // the live event; this is for anything else that wants to know).
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [notices, setNotices] = useState<Record<string, string>>({});
  const loadedOrder = useRef<string | null>(null);

  const load = useCallback(async () => {
    const quiet = loadedOrder.current === orderId;
    if (!quiet) {
      setList({ status: "loading" });
      setNotices({});
    }
    const result = await loadPoList(orderId);
    if (result) {
      loadedOrder.current = orderId;
      setList({ status: "ready", pos: result.pos });
    } else if (!quiet) {
      setList({ status: "error" });
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // A send from a row's confirmation step ends with the step closing while
  // focus is on its (disabled) send button; the row's buttons change with
  // the PO's new state, so focus goes to the row's PO number, which stays.
  const focusRow = (poId: string) => focusSoon(() => document.getElementById(rowFocusId(poId)));

  const flow = useSendFlow({
    onSent: (po, resend) => {
      focusRow(po.id);
      toast({
        title: resend ? `Purchase order ${po.number ?? ""} sent again` : `Purchase order ${po.number ?? ""} sent`,
        body: po.vendor ? `To ${po.vendor.name}` : undefined,
        tone: "good",
      });
      setNotices((current) => {
        const next = { ...current };
        delete next[po.id];
        return next;
      });
      void load();
      onChanged?.();
    },
    onSettled: (po, message) => {
      focusRow(po.id);
      if (message) {
        setNotices((current) => ({ ...current, [po.id]: message }));
      }
      void load();
      onChanged?.();
    },
  });

  const pos = list.status === "ready" ? list.pos : [];

  return (
    <section className="border-t border-line py-5" aria-labelledby={`pos-${orderId}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 id={`pos-${orderId}`} className="font-display text-sm font-semibold text-ink">
          Purchase orders
        </h3>
        {canManage ? (
          <button type="button" onClick={onCreate} className={`${ui.buttonSecondary} h-9`}>
            <FilePlusIcon size={16} aria-hidden />
            Create purchase order
          </button>
        ) : null}
      </div>

      {list.status === "loading" ? (
        <div aria-label="Loading purchase orders" className="flex flex-col gap-2">
          <span className="od-skeleton h-4 w-48" />
          <span className="od-skeleton h-3.5 w-64" />
        </div>
      ) : null}

      {list.status === "error" ? (
        <p role="alert" className="text-sm text-bad">
          Purchase orders did not load.{" "}
          <button type="button" onClick={() => void load()} className="font-semibold underline underline-offset-2">
            Try again
          </button>
        </p>
      ) : null}

      {list.status === "ready" && pos.length === 0 ? (
        <p className="text-sm text-ink-2">
          {canManage
            ? "No purchase orders yet. Create one to send this order's items to a vendor after you review it."
            : "No purchase orders yet. A manager creates them."}
        </p>
      ) : null}

      {pos.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {pos.map((po) => {
            const chip = poStateChip(po);
            const total = totalOf(po);
            const pending = flow.pending?.poId === po.id ? flow.pending : null;
            const canSend = canManage && po.recipients !== null && po.state !== "sending";
            return (
              <li key={po.id} className="flex flex-col gap-2.5 py-3.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span id={rowFocusId(po.id)} tabIndex={-1} className="font-mono text-sm font-semibold tabular-nums text-ink outline-none">
                    {po.number ?? "Draft"}
                  </span>
                  <ToneChip tone={chip.tone}>{chip.label}</ToneChip>
                  {total ? <span className="ml-auto font-mono text-sm tabular-nums text-ink">{total}</span> : null}
                </div>
                <p className="text-sm text-ink-2">
                  <span className="font-medium text-ink">{po.vendor?.name ?? "Unknown vendor"}</span>
                  {", "}
                  <time dateTime={new Date(po.sentAt ?? po.updatedAt ?? po.createdAt).toISOString()} title={formatDate(po.sentAt ?? po.createdAt)}>
                    {poDateLine(po)}
                  </time>
                </p>

                {po.state === "failed" && po.lastError ? <InlineMessage tone="bad">{po.lastError}</InlineMessage> : null}
                {po.state === "sent" && po.lastError ? (
                  <InlineMessage tone="warn">The last send again did not go out: {po.lastError}</InlineMessage>
                ) : null}
                {po.interrupted ? (
                  <InlineMessage tone="warn">
                    A send started and did not finish, so the vendor may or may not have it. Check with them before sending
                    again.
                  </InlineMessage>
                ) : null}
                {notices[po.id] && notices[po.id] !== po.lastError ? <InlineMessage tone="info">{notices[po.id]}</InlineMessage> : null}
                {canManage && po.vendor?.archived && po.state !== "sent" ? (
                  <InlineMessage tone="warn">This vendor was removed. Edit the purchase order to pick another before sending.</InlineMessage>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {po.pdfUrl ? (
                    <a href={po.pdfUrl} target="_blank" rel="noopener noreferrer" className={`${ui.buttonSecondary} ${small}`}>
                      <FilePdfIcon size={14} aria-hidden />
                      Open PDF
                      <span className="sr-only"> for {po.number ?? "this purchase order"} (opens in a new tab)</span>
                    </a>
                  ) : null}
                  {canManage && (po.state === "draft" || po.state === "failed") ? (
                    <button type="button" onClick={() => onEdit(po)} className={`${ui.buttonSecondary} ${small}`}>
                      <PencilSimpleIcon size={14} aria-hidden />
                      {po.state === "draft" ? "Review and send" : "Edit"}
                    </button>
                  ) : null}
                  {canSend && po.state === "failed" && !pending ? (
                    <button
                      id={`po-${po.id}-retry`}
                      type="button"
                      onClick={() => flow.start(po, { label: poLabel(po), resend: false })}
                      className={`${ui.buttonSecondary} ${small}`}
                    >
                      <ArrowClockwiseIcon size={14} aria-hidden />
                      Retry
                    </button>
                  ) : null}
                  {canSend && po.state === "sent" && !pending ? (
                    <button
                      id={`po-${po.id}-resend`}
                      type="button"
                      onClick={() => flow.start(po, { label: poLabel(po), resend: true })}
                      className={`${ui.buttonSecondary} ${small}`}
                    >
                      <PaperPlaneTiltIcon size={14} aria-hidden />
                      Send again
                    </button>
                  ) : null}
                </div>

                {pending ? (
                  <SendConfirm
                    pending={pending}
                    busy={flow.busy}
                    onConfirm={() => void flow.confirm()}
                    onCancel={() => {
                      flow.cancel();
                      // Back to the button that opened the step.
                      focusSoon(() => document.getElementById(`po-${po.id}-${pending.resend ? "resend" : "retry"}`));
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
