// A workspace's own email sender (platform amendment section 5), behind
// /api/workspaces/[id]/sender. Platform admins only; the routes check that.
//
// The sender is accounts@<custom domain> once the client host is active
// (IMPACT: accounts@orders.impactrentals.store), or an address a platform
// admin sets as an override. It is used only after a test send from it
// succeeds (sending_verified_at); changing the address or the custom domain
// clears that, and until then workspace mail comes from the platform
// address with the workspace name (senderFor in src/server/email/send.ts).
// Cloudflare treats orders.<client domain> as its own sending domain: it
// must be onboarded under Email Sending first (docs/HANDOFF.md, "Sending
// email for a client").

import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "@/db";
import { workspaces } from "@/db/schema";
import { isRecord } from "./desk/shapes";
import { normalizeEmail } from "./desk/validate";
import { escapeHtml, sanitizeSubject } from "./email/escape";
import { emailParagraph, renderEmail } from "./email/layout";
import { sendEmail, senderDisplayName, senderFor, workspaceSenderAddress } from "./email/send";
import { loadMailWorkspace, type MailWorkspace } from "./email/workspace";
import { appOrigin } from "./host";

export type SenderView = {
  // The override a platform admin set, or null.
  override: string | null;
  // The workspace's own address (the override, else accounts@<active
  // domain>), verified or not; null when there is none.
  address: string | null;
  source: "override" | "domain" | null;
  verified: boolean;
  verifiedAt: number | null;
  // What workspace mail comes from right now, "Name <address>".
  from: string;
  replyTo: string | null;
};

export function senderView(env: CloudflareEnv, workspace: MailWorkspace): SenderView {
  const own = workspaceSenderAddress(workspace);
  const { from } = senderFor(env, workspace);
  return {
    override: workspace.sendingAddress,
    address: own?.address ?? null,
    source: own?.source ?? null,
    verified: own !== null && workspace.sendingVerifiedAt !== null,
    verifiedAt: own !== null ? workspace.sendingVerifiedAt : null,
    from: typeof from === "string" ? from : `${from.name} <${from.email}>`,
    replyTo: workspace.replyTo,
  };
}

export type SetSenderResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "saved"; sender: SenderView };

// Body {address: string | null}: sets the override address, or clears it
// with null (or an empty string), going back to accounts@<custom domain>.
// A different value clears the verification.
export async function setSenderOverride(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  body: unknown,
): Promise<SetSenderResult> {
  if (!isRecord(body) || !("address" in body)) {
    return { kind: "invalid", error: "address is required: an email address, or null to clear the override" };
  }
  let address: string | null = null;
  if (body.address !== null && !(typeof body.address === "string" && body.address.trim() === "")) {
    address = normalizeEmail(body.address);
    if (address === null) {
      return { kind: "invalid", error: "The sending address must be a valid email address" };
    }
  }
  const current = await loadMailWorkspace(db, workspaceId);
  if (!current) {
    return { kind: "not-found" };
  }
  if (current.sendingAddress !== address) {
    await db
      .update(workspaces)
      .set({ sendingAddress: address, sendingVerifiedAt: null })
      .where(eq(workspaces.id, workspaceId));
  }
  const saved = await loadMailWorkspace(db, workspaceId);
  return saved ? { kind: "saved", sender: senderView(env, saved) } : { kind: "not-found" };
}

// Cloudflare's answer when the sender's domain is not onboarded for Email
// Sending in this account, as the one thing to do about it; null for any
// other failure.
export function sendingRefusal(error: unknown, address: string): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/not authorized|could not find domain config of sending domain/i.test(message)) {
    return null;
  }
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return `Onboard ${domain} under Compute > Email Service > Email Sending in Cloudflare (Email Sending only), then press Verify again.`;
}

export type VerifySenderResult =
  | { kind: "not-found" }
  | { kind: "no-sender"; error: string }
  | { kind: "refused"; error: string }
  | { kind: "failed"; error: string }
  | { kind: "verified"; sender: SenderView };

function same(column: AnySQLiteColumn, value: string | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

// Sends a branded test email FROM the workspace's own address TO the
// platform admin who asked (through the EMAIL binding, like all mail), and
// on success records sending_verified_at, but only if the address, the
// override and the domain are still the ones the test was sent from.
export async function verifySender(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  to: string,
): Promise<VerifySenderResult> {
  const workspace = await loadMailWorkspace(db, workspaceId);
  if (!workspace) {
    return { kind: "not-found" };
  }
  const own = workspaceSenderAddress(workspace);
  if (!own) {
    return {
      kind: "no-sender",
      error:
        "This workspace has no sender of its own yet. Attach and check its client host (orders.<client domain>), or set a sending address, then press Verify.",
    };
  }
  const { html, text } = renderEmail({
    workspace,
    hubOrigin: appOrigin(env),
    preheader: `A test email from ${own.address}.`,
    heading: "Email sending works",
    bodyHtml:
      emailParagraph(`This test email was sent from ${escapeHtml(own.address)}.`) +
      emailParagraph(`Email for ${escapeHtml(workspace.name)} now comes from this address.`),
    footerNote: "You received this because you pressed Verify in this workspace's email settings.",
  });
  try {
    await sendEmail(env, {
      from: { name: senderDisplayName(workspace.name), email: own.address },
      to: [to],
      subject: sanitizeSubject(`Test email from ${workspace.name}`),
      html,
      text,
      ...(workspace.replyTo ? { replyTo: workspace.replyTo } : {}),
    });
  } catch (e) {
    const refusal = sendingRefusal(e, own.address);
    if (refusal) {
      return { kind: "refused", error: refusal };
    }
    const detail = e instanceof Error && e.message ? `: ${e.message.slice(0, 300)}` : "";
    return { kind: "failed", error: `Cloudflare did not send the test email${detail}` };
  }
  const recorded = await db
    .update(workspaces)
    .set({ sendingVerifiedAt: Date.now() })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        same(workspaces.sendingAddress, workspace.sendingAddress),
        same(workspaces.customDomain, workspace.customDomain),
        same(workspaces.customDomainStatus, workspace.customDomainStatus),
      ),
    )
    .returning({ id: workspaces.id });
  if (recorded.length === 0) {
    return { kind: "failed", error: "The sender changed while the test email was sent. Press Verify again." };
  }
  const saved = await loadMailWorkspace(db, workspaceId);
  return saved ? { kind: "verified", sender: senderView(env, saved) } : { kind: "not-found" };
}
