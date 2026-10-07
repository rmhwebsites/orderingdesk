// "A new AI connection was made with your account" (comprehensive desk
// design section 4, consent phishing defense): which app, where its access
// goes, and the way to revoke it. Relative imports only: custom-worker.ts
// bundles this.

import { appOrigin } from "../host";
import { escapeHtml, sanitizeSubject } from "./escape";
import { emailParagraph, renderEmail } from "./layout";
import { sendEmail, senderFor } from "./send";
import type { MailWorkspace } from "./workspace";

export type NewConnectionMessage = {
  to: string;
  workspace: MailWorkspace | null;
  workspaceName: string;
  // A platform admin's hub connection for every workspace with AI on (owner
  // decision 3, Oct 7); workspaceName is then not shown.
  everyWorkspace?: boolean;
  clientLabel: string;
  redirectHost: string;
  settingsUrl: string;
};

export async function sendNewConnectionEmail(env: CloudflareEnv, message: NewConnectionMessage): Promise<void> {
  const label = escapeHtml(message.clientLabel);
  const every = message.everyWorkspace === true;
  const heading = every
    ? `${message.clientLabel} is connected to Ordering Desk in every workspace`
    : `${message.clientLabel} is connected to ${message.workspaceName} orders`;
  const where = every ? "every workspace with AI connections on" : `${escapeHtml(message.workspaceName)} orders`;
  const { html, text } = renderEmail({
    workspace: message.workspace,
    hubOrigin: appOrigin(env),
    preheader: "A new AI connection was made with your account.",
    heading,
    bodyHtml:
      emailParagraph(
        `${label} can now work in ${where} as you, from ${escapeHtml(message.redirectHost)}. Every change it makes is shown to you first, happens only after you confirm it in the chat, and says via ${label} in the timeline.`,
      ) +
      emailParagraph(
        every
          ? "Not you? Revoke it now in Settings &gt; AI connections of any workspace on Ordering Desk."
          : "Not you? Revoke it now in Settings &gt; AI connections, and tell your workspace manager.",
      ),
    cta: { label: every ? "Open Ordering Desk" : "Open AI connections", url: message.settingsUrl },
    footerNote: "You get this email for every new AI connection.",
  });
  const sender = senderFor(env, message.workspace);
  await sendEmail(env, {
    from: sender.from,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    to: [message.to],
    subject: sanitizeSubject(heading),
    html,
    text,
  });
}
