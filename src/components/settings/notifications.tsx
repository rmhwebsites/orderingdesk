"use client";

import { useState } from "react";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/PaperPlaneTilt";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { SettingsView } from "@/server/desk/shapes";
import type { SenderView } from "@/server/sender";
import { ui } from "@/components/ui";
import { Chip } from "@/components/kit";
import { describedBy, Field, InlineMessage, Panel, requestJson, SaveStatus, SettingsSection } from "./kit";

function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}

function EmailSettings({ workspaceId, initial }: { workspaceId: string; initial: SettingsView }) {
  const [emails, setEmails] = useState(initial.notificationEmails.join("\n"));
  const [replyTo, setReplyTo] = useState(initial.replyTo ?? "");
  const [fromName, setFromName] = useState(initial.fromName ?? "");
  const [poPrefix, setPoPrefix] = useState(initial.poPrefix);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const year = new Date().getFullYear();
  const prefixPreview = `${(poPrefix.trim() || "PO").toUpperCase()}-${year}-0041`;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestJson<{ settings: SettingsView }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, {
      method: "PUT",
      json: { notificationEmails: splitEmails(emails), replyTo, fromName, poPrefix },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const saved = result.data.settings;
    setEmails(saved.notificationEmails.join("\n"));
    setReplyTo(saved.replyTo ?? "");
    setFromName(saved.fromName ?? "");
    setPoPrefix(saved.poPrefix);
    setDone("Saved.");
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field
        id="notify-emails"
        label="Notification emails"
        help="New orders and sent purchase orders are emailed here. One address per line, up to 20."
      >
        <textarea
          id="notify-emails"
          rows={3}
          value={emails}
          onChange={(event) => setEmails(event.target.value)}
          placeholder="orders@company.com"
          spellCheck={false}
          aria-describedby={describedBy("notify-emails", { help: true })}
          className={`${ui.textarea} font-mono`}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="reply-to" label="Reply-to address" help="Replies to workspace email go here. Optional.">
          <input
            id="reply-to"
            type="email"
            value={replyTo}
            onChange={(event) => setReplyTo(event.target.value)}
            autoComplete="off"
            aria-describedby={describedBy("reply-to", { help: true })}
            className={ui.input}
          />
        </Field>
        <Field id="from-name" label="From name" help="The sender name for purchase order email. Optional.">
          <input
            id="from-name"
            value={fromName}
            maxLength={60}
            onChange={(event) => setFromName(event.target.value)}
            autoComplete="off"
            aria-describedby={describedBy("from-name", { help: true })}
            className={ui.input}
          />
        </Field>
      </div>
      <Field id="po-prefix" label="Purchase order prefix" help={`Up to 8 letters or digits. Numbers look like ${prefixPreview}.`}>
        <input
          id="po-prefix"
          value={poPrefix}
          maxLength={8}
          onChange={(event) => setPoPrefix(event.target.value.toUpperCase())}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={describedBy("po-prefix", { help: true })}
          className={`${ui.input} max-w-40 font-mono uppercase`}
        />
      </Field>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={ui.buttonPrimary}>
          {busy ? "Saving" : "Save"}
        </button>
        <SaveStatus text={done} />
      </div>
    </form>
  );
}

function SenderSettings({
  workspaceId,
  initial,
  domain,
}: {
  workspaceId: string;
  initial: SenderView;
  domain: string | null;
}) {
  const now = useNow(60000);
  const [sender, setSender] = useState(initial);
  const [override, setOverride] = useState(initial.override ?? "");
  const [busy, setBusy] = useState<"save" | "clear" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const derived = domain ? `accounts@${domain}` : null;
  const sendingDomain = (sender.address ?? derived ?? "").split("@")[1] ?? null;
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/sender`;

  async function saveOverride(address: string | null, kind: "save" | "clear") {
    setBusy(kind);
    setError(null);
    setResult(null);
    const response = await requestJson<SenderView>(base, { method: "PUT", json: { address } });
    setBusy(null);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setSender(response.data);
    setOverride(response.data.override ?? "");
    setResult(kind === "clear" ? "Back to the derived address. Press Verify to use it." : "Saved. Press Verify to start sending from it.");
  }

  async function verify() {
    setBusy("verify");
    setError(null);
    setResult(null);
    const response = await requestJson<SenderView>(`${base}/verify`, { method: "POST" });
    setBusy(null);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setSender(response.data);
    setResult(`Verified. A test email went to your address, and workspace email now comes from ${response.data.address}.`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Sending address</h3>
        <p className="mt-1 text-sm text-ink-2">Platform admins only. Workspace email comes from the client&apos;s own address once it is verified.</p>
      </div>
      <dl className="flex flex-col gap-2.5 text-sm">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-ink-2 sm:w-40">Sending now from</dt>
          <dd className="min-w-0 break-all font-mono text-ink">{sender.from}</dd>
        </div>
        <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-ink-2 sm:w-40">Workspace address</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2 text-ink">
            {sender.address ? <span className="break-all font-mono">{sender.address}</span> : <span>None yet</span>}
            {sender.address ? (
              sender.verified ? (
                <Chip size="sm" tone="green">Verified</Chip>
              ) : (
                <Chip size="sm" tone="amber">Not verified</Chip>
              )
            ) : null}
            {sender.verified && sender.verifiedAt && now > 0 ? (
              <span className="text-ink-2">since {formatDateTime(sender.verifiedAt)}</span>
            ) : null}
          </dd>
        </div>
      </dl>
      {!sender.address ? (
        <p className="text-sm text-ink-2">
          {derived
            ? `Once the custom domain is active, the address is ${derived}. Until then email comes from the platform address with the workspace name.`
            : "Set up a custom domain first: the address is derived from it (accounts@<custom domain>). Until then email comes from the platform address with the workspace name."}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void saveOverride(override, "save");
        }}
      >
        <Field
          id="sender-override"
          label="Use a different address"
          help={derived ? `Optional. Leave empty to use ${derived}.` : "Optional. Its domain must be onboarded for sending."}
          className="flex-1"
        >
          <input
            id="sender-override"
            type="email"
            value={override}
            onChange={(event) => setOverride(event.target.value)}
            placeholder={derived ?? "hello@client.com"}
            autoComplete="off"
            aria-describedby={describedBy("sender-override", { help: true })}
            className={ui.input}
          />
        </Field>
        <div className="flex gap-2">
          <button type="submit" disabled={busy !== null || override.trim().length === 0} className={ui.buttonSecondary}>
            {busy === "save" ? "Saving" : "Save address"}
          </button>
          {sender.override ? (
            <button type="button" disabled={busy !== null} onClick={() => void saveOverride(null, "clear")} className={ui.buttonQuiet}>
              {busy === "clear" ? "Clearing" : "Clear"}
            </button>
          ) : null}
        </div>
      </form>
      <div className="flex flex-col gap-3 rounded-panel border border-line bg-surface-2 p-3.5">
        <p className="text-sm text-ink">
          {sendingDomain
            ? `Before verifying, onboard ${sendingDomain} in Cloudflare under Compute > Email Service > Email Sending (sending only, never Email Routing). Verify then sends a test email to you from the address.`
            : "Verify sends a test email to you from the workspace address. Its domain must be onboarded in Cloudflare under Compute > Email Service > Email Sending first."}
        </p>
        <div>
          <button type="button" onClick={verify} disabled={busy !== null || !sender.address} className={ui.buttonPrimary}>
            <PaperPlaneTiltIcon size={16} aria-hidden />
            {busy === "verify" ? "Sending a test email" : "Verify"}
          </button>
        </div>
      </div>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      {result ? <InlineMessage tone="good">{result}</InlineMessage> : null}
    </div>
  );
}

export function NotificationsSection({
  workspaceId,
  settings,
  sender,
  domain,
}: {
  workspaceId: string;
  settings: SettingsView;
  sender: SenderView | null;
  domain: string | null;
}) {
  return (
    <SettingsSection
      id="notifications"
      title="Workspace email"
      description="Who else gets new order and purchase order email, and how workspace email is addressed. Each person picks their own push and email under Your notifications."
    >
      <Panel>
        <EmailSettings workspaceId={workspaceId} initial={settings} />
      </Panel>
      {sender ? (
        <Panel>
          <SenderSettings workspaceId={workspaceId} initial={sender} domain={domain} />
        </Panel>
      ) : null}
    </SettingsSection>
  );
}
