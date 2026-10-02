import { APP_NAME } from "../../lib/brand";
import { appOrigin } from "../host";
import { sanitizeSubject } from "./escape";
import { emailParagraph, renderEmail } from "./layout";
import { sendEmail, senderFor } from "./send";
import type { MailWorkspace } from "./workspace";

// The sign-in link. Requested on a workspace's client host (workspace set),
// it comes from that workspace's sender and carries its branding; requested
// on the hub (workspace null), it is Ordering Desk mail. The link itself
// already points at the host where sign-in was requested (better-auth runs
// per host, src/server/auth.ts).
export async function sendMagicLinkEmail(
  env: CloudflareEnv,
  opts: { to: string; url: string; workspace: MailWorkspace | null },
): Promise<void> {
  const { workspace } = opts;
  const heading = `Sign in to ${workspace ? `${workspace.name} orders` : APP_NAME}`;
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: "Your sign-in link expires in 5 minutes.",
    heading,
    bodyHtml: emailParagraph("Press the button below to sign in. This link expires in 5 minutes."),
    cta: { label: "Sign in", url: opts.url },
    footerNote: "If you did not request this email, you can safely ignore it.",
  });
  const sender = senderFor(env, workspace);
  await sendEmail(env, {
    from: sender.from,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    to: [opts.to],
    subject: sanitizeSubject(heading),
    html,
    text,
  });
}
