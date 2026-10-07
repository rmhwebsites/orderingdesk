// The 6-digit code that connects an AI app (src/mcp/oauth/codes.ts). From
// and in the look of the workspace whose host asked (hub mail otherwise),
// like the sign-in link. The code is in the subject too (phones show it in
// the notification; the local email fallback logs subjects). No link: the
// code is typed on the page the AI app opened. Relative imports only:
// custom-worker.ts bundles this.

import { APP_NAME } from "../../lib/brand";
import { appOrigin } from "../host";
import { escapeHtml, sanitizeSubject } from "./escape";
import { emailParagraph, renderEmail } from "./layout";
import { sendEmail, senderFor } from "./send";
import type { MailWorkspace } from "./workspace";

export type SignInCodeMessage = { to: string; code: string; clientLabel: string; workspace: MailWorkspace | null };

export async function sendSignInCodeEmail(env: CloudflareEnv, message: SignInCodeMessage): Promise<void> {
  const { workspace } = message;
  const place = workspace ? `${workspace.name} orders` : APP_NAME;
  const spaced = `${message.code.slice(0, 3)} ${message.code.slice(3)}`;
  const heading = `Connect ${message.clientLabel} to ${place}`;
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: "Your code expires in 10 minutes.",
    heading,
    bodyHtml:
      emailParagraph(
        `Enter this code on the page your AI app opened: <strong style="font-size:22px;letter-spacing:4px;">${escapeHtml(spaced)}</strong>`,
      ) +
      emailParagraph("It expires in 10 minutes. If you did not start connecting an AI app, ignore this email: nothing connects without the code."),
    footerNote: "Ordering Desk never asks for this code by phone, chat or email.",
  });
  const sender = senderFor(env, workspace);
  await sendEmail(env, {
    from: sender.from,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    to: [message.to],
    subject: sanitizeSubject(`${message.code} is your code to connect ${message.clientLabel} to ${place}`),
    html,
    text: text.includes(spaced) ? text : `${text}\n\nCode: ${spaced}`,
  });
}
