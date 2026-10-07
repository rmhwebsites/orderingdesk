"use client";

import { useRef, useState } from "react";
import { CopySimpleIcon } from "@phosphor-icons/react/CopySimple";
import { Chip, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { GRANT_TTL_DAYS } from "@/mcp/constants";
import type { AiConnectionView, AiLimits, AiSettingsView } from "@/server/ai-connections";
import { ConfirmStep, Field, focusSoon, InlineMessage, Panel, requestJson, SaveStatus, SettingsSection, Switch } from "./kit";

// Settings > AI connections (comprehensive desk design section 4): how to
// connect Claude or ChatGPT, the connections the viewer may see with
// Revoke, the daily limits for managers, and the switch and Revoke all for
// platform admins on the hub. The server enforces every one of these.
export function AiConnectionsSection({ workspaceId, initial }: { workspaceId: string; initial: AiSettingsView }) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/ai`;

  async function reload() {
    const result = await requestJson<{ ai: AiSettingsView }>(base, { method: "GET" });
    if (result.ok) {
      setView(result.data.ai);
    }
  }

  return (
    <SettingsSection
      id="ai"
      title="AI connections"
      description="Work from Claude or ChatGPT. Every change is shown to you first, happens only after you confirm it in the chat, and says via Claude or via ChatGPT in the timeline."
    >
      {!view.teamAccess ? <InlineMessage tone="warn">AI connections are off for this workspace. A platform admin can turn them on here.</InlineMessage> : null}
      <ConnectPanel mcpUrl={view.mcpUrl} />
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <ConnectionList
        connections={view.connections}
        showPeople={view.canManage}
        canManage={view.canManage}
        onRevoke={async (id) => {
          setError(null);
          const result = await requestJson<{ revoked: boolean }>(`${base}/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (!result.ok) {
            setError(result.error);
          }
          await reload();
        }}
      />
      {view.canManage ? <LimitsPanel base={base} initial={view.limits} onSaved={setView} /> : null}
      {view.canSwitch ? <SwitchPanel base={base} view={view} onChanged={reload} /> : null}
    </SettingsSection>
  );
}

function ConnectPanel({ mcpUrl }: { mcpUrl: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Panel className="flex flex-col gap-3">
      <h3 className="font-display text-base font-semibold text-ink">Connect an AI app</h3>
      <p className="max-w-[65ch] text-sm text-ink-2">
        Add a custom connector with this address, then sign in with your work email and the 6-digit code we send. A connection lasts {GRANT_TTL_DAYS} days, then you connect again.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 max-w-full break-all rounded-control bg-surface-2 px-3 py-2 font-mono text-sm text-ink">{mcpUrl}</code>
        <button
          type="button"
          className={ui.buttonSecondary}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(mcpUrl);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <CopySimpleIcon size={16} aria-hidden />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
        <li>Claude (web, desktop or mobile): Settings, Connectors, Add custom connector.</li>
        <li>ChatGPT: Settings, Apps and Connectors, Advanced settings, Developer mode, then Create.</li>
      </ul>
    </Panel>
  );
}

// The line under a connection. Dates wait for mount (now > 0): the server
// renders in UTC (Workers) and the browser in the viewer's own zone, so a
// date in the first render would not hydrate. Same as store-connection.tsx.
export function connectionDetails(connection: AiConnectionView, now: number): string {
  const parts = connection.clientDomain ? [connection.clientDomain] : [];
  if (now > 0) {
    parts.push(
      `connected ${formatDateTime(connection.createdAt)}`,
      connection.lastUsedAt ? `last used ${formatDateTime(connection.lastUsedAt)}` : "not used yet",
      `expires ${formatDateTime(connection.expiresAt)}`,
    );
  }
  return parts.join(", ");
}

function ConnectionList({
  connections,
  showPeople,
  canManage,
  onRevoke,
}: {
  connections: AiConnectionView[];
  showPeople: boolean;
  canManage: boolean;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(60000);
  if (connections.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-ink-2">No AI apps are connected{showPeople ? " in this workspace" : " for you"} yet.</p>
      </Panel>
    );
  }
  return (
    // The rows carry the padding (Panel's own padding would double it), as
    // in the admin screen's lists.
    <ul className={`${ui.panel} divide-y divide-line`}>
      {connections.map((connection) => (
        <li key={connection.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
              {showPeople ? <span>{connection.mine ? "You" : connection.person}</span> : null}
              <span>{connection.app}</span>
              <Chip tone={connection.access === "change" ? "blue" : "slate"} size="sm">
                {connection.access === "change" ? "Look up and change" : "Look up only"}
              </Chip>
              {connection.everyWorkspace ? (
                <Chip tone="slate" size="sm">
                  Every workspace
                </Chip>
              ) : null}
            </p>
            {/* min-h-4 keeps one line's height before the dates arrive. */}
            <p className="mt-1 min-h-4 text-xs text-ink-2">{connectionDetails(connection, now)}</p>
          </div>
          {connection.mine || canManage ? (
            <button
              type="button"
              className={`${ui.buttonDangerSecondary} self-start sm:self-auto`}
              aria-busy={busy === connection.id || undefined}
              disabled={busy !== null}
              onClick={async () => {
                setBusy(connection.id);
                await onRevoke(connection.id);
                setBusy(null);
              }}
            >
              {busy === connection.id ? <Spinner /> : null}
              {busy === connection.id ? "Revoking" : "Revoke"}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LimitsPanel({ base, initial, onSaved }: { base: string; initial: AiLimits; onSaved: (view: AiSettingsView) => void }) {
  const [values, setValues] = useState({
    readsPerDay: String(initial.readsPerDay),
    staffChangesPerDay: String(initial.staffChangesPerDay),
    managerChangesPerDay: String(initial.managerChangesPerDay),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fields: { key: keyof typeof values; label: string; help: string }[] = [
    { key: "readsPerDay", label: "Lookups a day, per person", help: "Searches, look-ups and previews." },
    { key: "staffChangesPerDay", label: "Changes a day, staff", help: "Confirmed status changes and notes." },
    { key: "managerChangesPerDay", label: "Changes a day, managers", help: "Every confirmed change." },
  ];
  async function save() {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await requestJson<{ ai: AiSettingsView }>(base, {
      method: "PATCH",
      json: { readsPerDay: Number(values.readsPerDay), staffChangesPerDay: Number(values.staffChangesPerDay), managerChangesPerDay: Number(values.managerChangesPerDay) },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data.ai);
    setDone("Daily limits saved.");
  }
  return (
    <Panel className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Daily limits</h3>
        <p className="mt-1 max-w-[65ch] text-sm text-ink-2">Each person&apos;s AI app stops at these limits until midnight UTC. Platform admins use the manager limit.</p>
      </div>
      <div className="grid max-w-2xl gap-4 sm:grid-cols-3">
        {fields.map((field) => (
          <Field key={field.key} id={`ai-${field.key}`} label={field.label} help={field.help}>
            <input
              id={`ai-${field.key}`}
              className={ui.input}
              inputMode="numeric"
              aria-describedby={`ai-${field.key}-help`}
              value={values[field.key]}
              onChange={(event) => {
                setDone(null);
                setValues({ ...values, [field.key]: event.target.value });
              }}
            />
          </Field>
        ))}
      </div>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={ui.buttonPrimary} onClick={save} disabled={busy} aria-busy={busy || undefined}>
          {busy ? <Spinner /> : null}
          {busy ? "Saving" : "Save limits"}
        </button>
        <SaveStatus text={done} />
      </div>
    </Panel>
  );
}

function SwitchPanel({ base, view, onChanged }: { base: string; view: AiSettingsView; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Panel className="flex flex-col gap-4">
      <h3 className="font-display text-base font-semibold text-ink">Platform admin</h3>
      <Switch
        id="ai-team-access"
        label="AI connections for this workspace"
        checked={view.teamAccess}
        busy={busy}
        describedBy="ai-team-access-help"
        onChange={async (checked) => {
          setBusy(true);
          setError(null);
          const result = await requestJson<{ ai: AiSettingsView }>(base, { method: "PATCH", json: { teamAccess: checked } });
          setBusy(false);
          if (!result.ok) {
            setError(result.error);
          }
          await onChanged();
        }}
      />
      <p id="ai-team-access-help" className="max-w-[65ch] text-sm text-ink-2">
        Off stops every AI connection and new connections in this workspace at once (a platform admin&apos;s connection for every workspace keeps working in the others). Turning it back on lets the existing ones work again; Revoke all ends them for good.
      </p>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      {message ? <InlineMessage tone="good">{message}</InlineMessage> : null}
      {confirming ? (
        <ConfirmStep
          message="Revoke every AI connection that can act in this workspace, platform admins' connections for every workspace included? Everyone has to connect again."
          confirmLabel="Revoke all"
          busyLabel="Revoking"
          busy={busy}
          onCancel={() => setConfirming(false)}
          returnFocus={() => trigger.current}
          onConfirm={async () => {
            setBusy(true);
            const result = await requestJson<{ revoked: number }>(`${base}/revoke-all`, { method: "POST" });
            setBusy(false);
            setConfirming(false);
            // The step is gone: focus goes back to Revoke all.
            focusSoon(() => trigger.current);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setMessage(`${result.data.revoked} AI ${result.data.revoked === 1 ? "connection" : "connections"} revoked.`);
            await onChanged();
          }}
        />
      ) : (
        <button ref={trigger} type="button" className={`${ui.buttonDangerSecondary} self-start`} onClick={() => setConfirming(true)}>
          Revoke all
        </button>
      )}
    </Panel>
  );
}
