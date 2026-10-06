"use client";

import { useRef, useState } from "react";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import type { DomainView } from "@/server/domains";
import { ui } from "@/components/ui";
import { Chip, Spinner } from "@/components/kit";
import { ConfirmStep, describedBy, Field, focusSoon, InlineMessage, Panel, requestJson, SettingsSection } from "./kit";

const STATUS: Record<NonNullable<DomainView["status"]>, { tone: string; label: string }> = {
  pending: { tone: "amber", label: "Pending check" },
  active: { tone: "green", label: "Active" },
  error: { tone: "red", label: "Not reachable" },
};

function SetupPaths({ domain }: { domain: string }) {
  const zone = domain.split(".").slice(1).join(".") || "the client's domain";
  return (
    <details className="rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm">
      <summary className="cursor-pointer font-semibold text-ink">How to point {domain} at Ordering Desk</summary>
      <div className="mt-3 flex flex-col gap-3 text-ink-2">
        <div>
          <p className="font-semibold text-ink">If {zone} is in your Cloudflare account</p>
          <p className="mt-1">
            Attach {domain} to the orderingdesk Worker as a custom domain: add it to the routes in wrangler.jsonc with
            custom_domain true and deploy, or add it under Workers and Pages, orderingdesk, Settings, Domains and Routes
            (then add it to wrangler.jsonc too, so a later deploy keeps it). Cloudflare creates the DNS record and the
            certificate. The name must not already have a DNS record.
          </p>
        </div>
        <div>
          <p className="font-semibold text-ink">If {zone} is somewhere else</p>
          <p className="mt-1">
            Use Cloudflare for SaaS on the orderingdesk.com zone: add {domain} under SSL/TLS, Custom Hostnames. The
            client then adds a CNAME from {domain} to customers.orderingdesk.com, plus the validation record Cloudflare
            shows, at their DNS host. Wait until the hostname shows Active.
          </p>
        </div>
        <p>Then press Check here. Until the check passes, the address shows only a plain Not found page.</p>
      </div>
    </details>
  );
}

export function CustomDomainSection({ workspaceId, initial }: { workspaceId: string; initial: DomainView }) {
  const [view, setView] = useState(initial);
  const [input, setInput] = useState(initial.domain ?? "");
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/domain`;
  const status = view.status ? STATUS[view.status] : null;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    setError(null);
    setReason(null);
    const result = await requestJson<DomainView>(base, { method: "PUT", json: { domain: input } });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setView(result.data);
    setInput(result.data.domain ?? "");
  }

  async function check() {
    setBusy("check");
    setError(null);
    const result = await requestJson<DomainView & { reason: string | null }>(`${base}/check`, { method: "POST" });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setView({ domain: result.data.domain, status: result.data.status });
    setReason(result.data.reason);
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    const result = await requestJson<{ ok: true }>(base, { method: "DELETE" });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirming(false);
    setReason(null);
    setView({ domain: null, status: null });
    setInput("");
    // The domain and its buttons are gone: the domain field, now empty,
    // holds focus next.
    focusSoon(() => document.getElementById("custom-domain"));
  }

  return (
    <SettingsSection
      id="domain"
      title="Custom domain"
      description="The client's own address for this workspace, such as orders.impactrentals.store. It opens this workspace directly, in its branding, and people sign in there."
    >
      <Panel className="flex flex-col gap-4">
        {view.domain ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-2">
              <GlobeIcon size={20} aria-hidden />
            </span>
            <p className="min-w-0 flex-1 break-all font-mono text-sm text-ink">{view.domain}</p>
            {status ? <Chip size="sm" tone={status.tone}>{status.label}</Chip> : null}
          </div>
        ) : null}
        {reason && view.status === "error" ? <InlineMessage tone="bad">{reason}</InlineMessage> : null}
        {view.status === "active" && reason === null && busy === null && view.domain ? (
          <p className="text-sm text-ink-2">
            {view.domain} opens this workspace. Email from it can be set up under Workspace email.
          </p>
        ) : null}
        <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field
            id="custom-domain"
            label={view.domain ? "Change the domain" : "Domain"}
            help="The host name only, without https://."
            className="flex-1"
          >
            <input
              id="custom-domain"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="orders.client.com"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-describedby={describedBy("custom-domain", { help: true })}
              className={`${ui.input} font-mono`}
            />
          </Field>
          <button
            type="submit"
            disabled={busy !== null || input.trim().length === 0 || input.trim().toLowerCase() === view.domain}
            aria-busy={busy === "save" || undefined}
            className={ui.buttonSecondary}
          >
            {busy === "save" ? <Spinner /> : null}
            {busy === "save" ? "Saving" : "Save domain"}
          </button>
        </form>
        {view.domain ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={check}
              disabled={busy !== null}
              aria-busy={busy === "check" || undefined}
              className={ui.buttonPrimary}
            >
              {busy === "check" ? <Spinner /> : null}
              {busy === "check" ? "Checking" : "Check"}
            </button>
            <button
              ref={removeRef}
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
              className={ui.buttonQuiet}
            >
              Remove domain
            </button>
            <p className="text-sm text-ink-2">Check loads the address and confirms it reaches Ordering Desk.</p>
          </div>
        ) : null}
        {confirming && view.domain ? (
          <ConfirmStep
            message={`Remove ${view.domain}? It stops opening this workspace, and the email sender derived from it needs verifying again.`}
            confirmLabel="Remove"
            busyLabel="Removing"
            busy={busy === "remove"}
            onConfirm={remove}
            onCancel={() => setConfirming(false)}
            returnFocus={() => removeRef.current}
          />
        ) : null}
        {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
        <SetupPaths domain={view.domain ?? (input.trim() || "orders.client.com")} />
      </Panel>
    </SettingsSection>
  );
}
