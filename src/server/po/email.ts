// The email that carries a purchase order to its vendor: the workspace's
// branded layout (renderEmail), a short summary, and the PDF attached by
// the caller (src/server/po/send.ts). No button: vendors have no account.
// Every interpolated value passes escapeHtml; the subject passes
// sanitizeSubject.

import { formatDate } from "@/lib/format";
import { formatCents, type PoLine } from "@/lib/po";
import { escapeHtml, sanitizeSubject } from "@/server/email/escape";
import { emailParagraph, renderEmail } from "@/server/email/layout";
import type { RenderedEmail } from "@/server/email/notifications";
import type { MailWorkspace } from "@/server/email/workspace";
import { appOrigin } from "@/server/host";

export type VendorPoEmailInput = {
  poNumber: string;
  orderName: string;
  vendorName: string;
  lines: PoLine[];
  currency: string;
  subtotalCents: number;
  shipTo: string[];
  notes: string | null;
  date: number;
};

const LABEL_STYLE = "padding:6px 16px 6px 0;vertical-align:top;font-size:14px;line-height:20px;font-weight:700;white-space:nowrap;";
const VALUE_STYLE = "padding:6px 0;vertical-align:top;font-size:14px;line-height:20px;";
const NOTES_SHOWN = 600;

function plural(count: number, word: string): string {
  return `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
}

function table(rows: Array<[string, string]>): string {
  const body = rows
    .map(([label, value]) => `<tr><td style="${LABEL_STYLE}">${escapeHtml(label)}</td><td style="${VALUE_STYLE}">${value}</td></tr>`)
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 16px 0;">${body}</table>`;
}

export function vendorPoEmail(env: CloudflareEnv, workspace: MailWorkspace, po: VendorPoEmailInput): RenderedEmail {
  const units = po.lines.reduce((sum, line) => sum + line.quantity, 0);
  const total = formatCents(po.subtotalCents, po.currency);
  const shipTo = po.shipTo.filter((line) => line.trim().length > 0);
  const rows: Array<[string, string]> = [
    ["Purchase order", escapeHtml(po.poNumber)],
    ["Date", escapeHtml(formatDate(po.date, "UTC"))],
    ["Reference", escapeHtml(`Order ${po.orderName}`)],
    ["Items", escapeHtml(`${plural(po.lines.length, "line")}, ${plural(units, "unit")}`)],
    ["Total", escapeHtml(total)],
  ];
  if (shipTo.length > 0) {
    rows.push(["Ship to", shipTo.map(escapeHtml).join("<br>")]);
  }
  const notes = po.notes?.trim() ?? "";
  const shownNotes = notes.length > NOTES_SHOWN ? `${notes.slice(0, NOTES_SHOWN)}... (the PDF has the full notes)` : notes;

  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `Purchase order ${po.poNumber} from ${workspace.name}, ${total}. The PDF is attached.`,
    heading: `Purchase order ${po.poNumber}`,
    bodyHtml:
      emailParagraph(`Hello ${escapeHtml(po.vendorName)},`) +
      emailParagraph(
        `${escapeHtml(workspace.name)} sent you purchase order ${escapeHtml(po.poNumber)}. The PDF is attached to this email.`,
      ) +
      table(rows) +
      (shownNotes ? emailParagraph(`<strong>Notes:</strong> ${escapeHtml(shownNotes).replace(/\r?\n/g, "<br>")}`) : "") +
      (workspace.replyTo ? emailParagraph("Reply to this email with any questions about this order.") : ""),
  });
  return {
    subject: sanitizeSubject(`Purchase order ${po.poNumber} from ${workspace.name}`),
    html,
    text,
  };
}
