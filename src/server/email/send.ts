import { APP_NAME } from "../../lib/brand";
import { sanitizeSubject } from "./escape";

// Email driver: Cloudflare Email Service send binding (wrangler.jsonc
// "send_email", bound as EMAIL). All app email goes through sendEmail so the
// localhost fallback applies everywhere: in local dev the binding cannot
// really deliver, so the recipient, subject, and first link are logged and
// flows like magic-link sign-in stay testable from the dev server log.

// The platform sender (hub mail, and workspace mail until the workspace's
// own sender is verified). orderingdesk.com is onboarded for Email Sending.
export const DEFAULT_FROM = `${APP_NAME} <orders@orderingdesk.com>`;

// The sender actually used: EMAIL_FROM (wrangler.jsonc vars) when set, else
// DEFAULT_FROM. Whatever domain it names must be onboarded for Email Sending
// in the same Cloudflare account as this Worker, or every send is refused.
export function defaultFrom(env: CloudflareEnv): string {
  return env.EMAIL_FROM || DEFAULT_FROM;
}

// A structured sender: the binding builds (and encodes) the header from it.
export type EmailSender = { name: string; email: string };

export interface SendEmailOptions {
  // "Display Name <addr>", a bare address, or a structured sender.
  from: string | EmailSender;
  to: string[];
  subject: string;
  html: string;
  // The plain-text alternative (renderEmail returns one with the HTML).
  text?: string;
  cc?: string[];
  replyTo?: string;
  attachments?: { filename: string; content: string }[];
}

// The workspace fields that decide who its mail comes from. replyTo is the
// workspace setting (workspace_settings.reply_to).
export type SenderWorkspace = {
  name: string;
  customDomain: string | null;
  customDomainStatus: "pending" | "active" | "error" | null;
  sendingAddress: string | null;
  sendingVerifiedAt: number | null;
  replyTo: string | null;
};

// The workspace's own sending address, verified or not: the override a
// platform admin set (sending_address), else accounts@<custom domain> once
// that domain is active (IMPACT: accounts@orders.impactrentals.store). null
// when there is neither.
export function workspaceSenderAddress(
  workspace: SenderWorkspace,
): { address: string; source: "override" | "domain" } | null {
  if (workspace.sendingAddress) {
    return { address: workspace.sendingAddress, source: "override" };
  }
  if (workspace.customDomain && workspace.customDomainStatus === "active") {
    return { address: `accounts@${workspace.customDomain}`, source: "domain" };
  }
  return null;
}

// A display name that can never break or extend the From header: control
// characters, quotes, angle brackets and backslashes removed, whitespace
// collapsed, at most 78 characters.
export function senderDisplayName(name: string): string {
  const safe = sanitizeSubject(name.replace(/["<>\\]/g, "")).slice(0, 78).trim();
  return safe.length > 0 ? safe : APP_NAME;
}

// The platform address alone (orders@orderingdesk.com), from EMAIL_FROM or
// DEFAULT_FROM.
function platformAddress(env: CloudflareEnv): string {
  const parsed = parseAddress(defaultFrom(env));
  return typeof parsed === "string" ? parsed.trim() : parsed.email;
}

// Who an email comes from (platform amendment section 5). EVERY email takes
// its sender from here:
// - null (hub mail: sign-in on orderingdesk.com, platform admin invites):
//   the platform sender;
// - a workspace whose own address (workspaceSenderAddress) is verified
//   (sending_verified_at, cleared whenever the address or the custom domain
//   changes): that address, with the workspace name as display name;
// - any other workspace: the platform address with the workspace name as
//   display name.
// Workspace mail carries the workspace reply-to when one is set.
export function senderFor(
  env: CloudflareEnv,
  workspace: SenderWorkspace | null,
): { from: string | EmailSender; replyTo?: string } {
  if (!workspace) {
    return { from: defaultFrom(env) };
  }
  const own = workspaceSenderAddress(workspace);
  const email = own && workspace.sendingVerifiedAt !== null ? own.address : platformAddress(env);
  return {
    from: { name: senderDisplayName(workspace.name), email },
    ...(workspace.replyTo ? { replyTo: workspace.replyTo } : {}),
  };
}

// The first link's address (an image URL is not what the dev log is for),
// entity-decoded so it can be pasted into a browser.
function firstUrlIn(html: string): string | undefined {
  const link = html.match(/href="(https?:\/\/[^"]+)"/);
  const match = link ? link[1] : html.match(/https?:\/\/[^\s"'<>]+/)?.[0];
  return match?.replace(/&amp;/g, "&");
}

// "Display Name <addr>" becomes the structured EmailAddress the binding
// accepts; a bare address passes through as a string.
function parseAddress(value: string): string | { name: string; email: string } {
  const match = value.match(/^(.+)<([^<>]+)>\s*$/);
  if (match && match[1].trim().length > 0) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return value;
}

// Email Service attachments require a MIME type; our options carry only
// filename + content (base64), so the type is inferred from the extension.
// Phase 7 sends PDFs; extend the map when a template attaches something new.
const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  csv: "text/csv",
};

function attachmentType(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Sends an email through the Cloudflare Email Service binding.
 *
 * Convention for ALL templates (current and Phase 6/7, which interpolate
 * customer and vendor data), applied at the call site because sendEmail
 * cannot tell markup from data:
 * - every dynamic value interpolated into `opts.html` MUST pass through
 *   escapeHtml from "./escape";
 * - every dynamic value interpolated into `opts.subject` MUST pass through
 *   sanitizeSubject from "./escape", never escapeHtml (subjects are plain
 *   text, so entity encoding would show literally).
 *
 * Dev fallback: when APP_URL points at localhost the email is logged instead
 * of sent (the binding does not deliver from local dev anyway). Outside
 * localhost the EMAIL binding is required, so a misconfigured deployment
 * fails loudly instead of silently dropping email.
 */
export async function sendEmail(
  env: CloudflareEnv,
  opts: SendEmailOptions,
): Promise<{ id: string }> {
  if (env.APP_URL.startsWith("http://localhost")) {
    console.log(
      "[email-fallback]",
      JSON.stringify({ to: opts.to, subject: opts.subject, url: firstUrlIn(opts.html) }),
    );
    return { id: "dev-fallback" };
  }
  if (!env.EMAIL) {
    throw new Error("Email sending is not configured (EMAIL binding missing)");
  }
  const message: EmailMessageBuilder = {
    from: typeof opts.from === "string" ? parseAddress(opts.from) : opts.from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(opts.cc ? { cc: opts.cc } : {}),
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    ...(opts.attachments
      ? {
          attachments: opts.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.content,
            type: attachmentType(attachment.filename),
            disposition: "attachment" as const,
          })),
        }
      : {}),
  };
  const result = await env.EMAIL.send(message);
  return { id: result.messageId };
}
