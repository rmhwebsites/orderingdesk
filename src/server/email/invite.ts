import { APP_NAME } from "../../lib/brand";
import { appOrigin, workspaceOrigin } from "../host";
import { escapeHtml, sanitizeSubject } from "./escape";
import { emailParagraph, renderEmail } from "./layout";
import { sendEmail, senderFor } from "./send";
import type { MailWorkspace } from "./workspace";

// Sent when a manager or platform admin invites someone to a workspace.
// Always a pending invite, whether or not the email has an account: the
// person joins when they sign in, or open the button's link while signed
// in (src/server/members.ts, src/app/page.tsx). Always the workspace's
// branding and sender; the button opens the workspace's client host when
// it has an active one, else the hub. Workspace names are user input: escaped in the
// HTML by renderEmail and here, control-stripped in the subject.
export async function sendWorkspaceInviteEmail(
  env: CloudflareEnv,
  to: string,
  workspace: MailWorkspace,
): Promise<void> {
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `Join ${workspace.name} to manage its orders.`,
    heading: `You are invited to ${workspace.name}`,
    bodyHtml: emailParagraph(
      `Sign in with this email address to join and start managing ${escapeHtml(workspace.name)} orders.`,
    ),
    cta: { label: `Open ${workspace.name} orders`, url: `${workspaceOrigin(env, workspace)}/` },
  });
  const sender = senderFor(env, workspace);
  await sendEmail(env, {
    from: sender.from,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    to: [to],
    subject: sanitizeSubject(`You are invited to ${workspace.name} orders`),
    html,
    text,
  });
}

// Sent when a platform admin promotes someone (an existing user, or a
// pending platform-admin invite). Hub mail: the Ordering Desk look and
// sender.
export async function sendPlatformAdminInviteEmail(env: CloudflareEnv, to: string): Promise<void> {
  const { html, text } = renderEmail({
    workspace: null,
    hubOrigin: appOrigin(env),
    preheader: `You can now manage every workspace on ${APP_NAME}.`,
    heading: `You are now a platform admin on ${APP_NAME}`,
    bodyHtml: emailParagraph("Sign in with this email address to manage every workspace."),
    cta: { label: `Open ${APP_NAME}`, url: `${appOrigin(env)}/` },
  });
  await sendEmail(env, {
    from: senderFor(env, null).from,
    to: [to],
    subject: `You are now a platform admin on ${APP_NAME}`,
    html,
    text,
  });
}
