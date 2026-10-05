"use client";

import { useRef, useState } from "react";
import { PlugsIcon } from "@phosphor-icons/react/Plugs";
import { StorefrontIcon } from "@phosphor-icons/react/Storefront";
import { formatDateTime, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { ConnectionSettingsView } from "@/server/desk/connection-view";
import { ui } from "@/components/ui";
import {
  ConfirmStep,
  describedBy,
  Field,
  focusSoon,
  InlineMessage,
  Panel,
  requestJson,
  sectionHeading,
  SettingsSection,
  ToneChip,
} from "./kit";
import { OrderHistoryPanel } from "./order-history";

type Mode = "client_credentials" | "legacy_token";

type SavedConnection = {
  shopDomain: string;
  status: "ok";
  lastSyncAt: number;
  lastError: string | null;
  shopName: string;
  authMode: Mode;
  webhooksRegisteredAt: number | null;
};

const STATUS: Record<ConnectionSettingsView["status"], { tone: string; label: string }> = {
  ok: { tone: "green", label: "Connected" },
  error: { tone: "red", label: "Needs attention" },
  disabled: { tone: "slate", label: "Disconnected" },
};

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-sm text-ink-2 sm:w-40">{term}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function ConnectionStatus({ connection }: { connection: ConnectionSettingsView }) {
  // Times render after mount, in the viewer's own time zone (the server
  // render cannot know it).
  const now = useNow(30000);
  const status = STATUS[connection.status];
  const lastSync = connection.catchingUp
    ? "Catching up on orders"
    : connection.lastSyncAt > 0
      ? now > 0
        ? relativeTime(connection.lastSyncAt, now)
        : ""
      : "Not yet";
  const live =
    connection.status === "disabled"
      ? "Off while disconnected"
      : connection.authMode === "legacy_token"
        ? "Not available with an Admin API token. Orders sync every 10 minutes."
        : connection.webhooksRegisteredAt
          ? now > 0
            ? `On since ${formatDateTime(connection.webhooksRegisteredAt)}`
            : "On"
          : "Off. Connect again to retry. Orders still sync every 10 minutes.";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-control bg-surface-2 text-ink-2">
          <StorefrontIcon size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-ink">{connection.shopName ?? connection.shopDomain}</p>
          <p className="truncate font-mono text-xs text-ink-2">{connection.shopDomain}</p>
        </div>
        <ToneChip tone={status.tone}>{status.label}</ToneChip>
      </div>
      <dl className="flex flex-col gap-2.5">
        <Detail term="Connected with">
          {connection.authMode === "client_credentials" ? "Client ID and Client secret" : "Admin API token (older app)"}
        </Detail>
        <Detail term="Live updates">{live}</Detail>
        <Detail term="Last sync">{lastSync}</Detail>
        {connection.scopes ? (
          <Detail term="Permissions">
            {connection.missingScopes.length === 0 ? "Every permission Ordering Desk needs is granted." : "Some are missing (below)."}
          </Detail>
        ) : null}
      </dl>
      {connection.missingScopes.length > 0 ? (
        <InlineMessage tone="warn">
          The Shopify app is missing these permissions:{" "}
          <span className="font-mono">{connection.missingScopes.join(", ")}</span>. Add them to the app, approve the new
          version on the store, and connect again.
        </InlineMessage>
      ) : null}
      {connection.lastError && connection.status !== "disabled" ? (
        <InlineMessage tone="bad">
          <span className="font-semibold">Last error: </span>
          {connection.lastError}
        </InlineMessage>
      ) : null}
    </div>
  );
}

function Instructions() {
  return (
    <details className="group rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm text-ink">
      <summary className="cursor-pointer font-semibold text-ink">How to get the Client ID and Client secret</summary>
      <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-ink-2">
        <li>
          Open the Shopify Dev Dashboard (dev.shopify.com) under the organization that owns the store, and create an
          app for Ordering Desk (or open the one you made).
        </li>
        <li>
          Give it these Admin API access scopes, then release the version: read_orders and write_orders,
          read_customers, read_merchant_managed_fulfillment_orders and write_merchant_managed_fulfillment_orders.
          Add read_all_orders too if you will import orders older than 60 days (Order history, below).
        </li>
        <li>Install the app on the store and approve those permissions there.</li>
        <li>In the app&apos;s settings, copy its Client ID and Client secret.</li>
        <li>
          Enter the store&apos;s .myshopify.com address and both values here. Ordering Desk checks them with Shopify
          right away; if a permission is missing it says which one, and nothing is saved.
        </li>
        <li>If you change the scopes later, release a new version, approve it on the store, and connect again.</li>
      </ol>
      <p className="mt-3 text-ink-2">
        Enter the Client secret only here: never paste it into chat, email or a ticket. An older app with an Admin API
        token (shpat_...) can use the token instead; it gets no live updates and syncs every 10 minutes.
      </p>
    </details>
  );
}

function ConnectForm({
  workspaceId,
  existing,
  onSaved,
}: {
  workspaceId: string;
  existing: ConnectionSettingsView | null;
  onSaved: (saved: SavedConnection, warning: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>(existing?.authMode ?? "client_credentials");
  const [shopDomain, setShopDomain] = useState(existing?.shopDomain ?? "");
  // Credentials are never prefilled and are cleared after a save.
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const json = mode === "client_credentials" ? { shopDomain, clientId, clientSecret } : { shopDomain, token };
    const result = await requestJson<{ connection: SavedConnection; warning?: string }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/connection`,
      { method: "PUT", json },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setClientId("");
    setClientSecret("");
    setToken("");
    onSaved(result.data.connection, result.data.warning ?? null);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" autoComplete="off">
      <fieldset className="flex flex-col gap-2">
        <legend className={`${ui.label} mb-2`}>How the store connects</legend>
        {(
          [
            ["client_credentials", "Client ID and Client secret", "Recommended. For apps made in the Dev Dashboard (2026 and later)."],
            ["legacy_token", "Admin API token", "For older custom apps with a shpat_ token. No live updates."],
          ] as const
        ).map(([value, label, help]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-panel border px-3.5 py-3 transition-colors ${
              mode === value ? "border-primary-strong bg-surface" : "border-line hover:bg-surface-2"
            }`}
          >
            <input
              type="radio"
              name="auth-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
              className="mt-0.5 size-4 accent-[var(--primary-strong)]"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">{label}</span>
              <span className="block text-sm text-ink-2">{help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field id="shop-domain" label="Store address" help="The store's .myshopify.com address, for example your-store.myshopify.com.">
        <input
          id="shop-domain"
          type="text"
          inputMode="url"
          required
          value={shopDomain}
          onChange={(event) => setShopDomain(event.target.value)}
          placeholder="your-store.myshopify.com"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={describedBy("shop-domain", { help: true })}
          className={ui.input}
        />
      </Field>
      {mode === "client_credentials" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="client-id" label="Client ID">
            <input
              id="client-id"
              type="text"
              required
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className={`${ui.input} font-mono`}
            />
          </Field>
          <Field id="client-secret" label="Client secret">
            <input
              id="client-secret"
              type="password"
              required
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className={`${ui.input} font-mono`}
            />
          </Field>
        </div>
      ) : (
        <Field id="admin-token" label="Admin API access token">
          <input
            id="admin-token"
            type="password"
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={`${ui.input} font-mono`}
          />
        </Field>
      )}
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={ui.buttonPrimary}>
          <PlugsIcon size={16} aria-hidden />
          {busy ? "Checking with Shopify" : existing && existing.status !== "disabled" ? "Connect again" : "Connect store"}
        </button>
        <p className="text-sm text-ink-2">Shopify checks the credentials before anything is saved.</p>
      </div>
      <Instructions />
    </form>
  );
}

export function StoreConnectionSection({
  workspaceId,
  initial,
  canEdit,
}: {
  workspaceId: string;
  initial: ConnectionSettingsView | null;
  canEdit: boolean;
}) {
  const [connection, setConnection] = useState(initial);
  const [result, setResult] = useState<{ tone: "good" | "warn"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  // Bumped after a connect or disconnect, so Order history reloads (the
  // grant, or the store itself, may have changed).
  const [historySignal, setHistorySignal] = useState(0);
  const disconnectRef = useRef<HTMLButtonElement>(null);

  function saved(next: SavedConnection, warning: string | null) {
    setConnection({
      shopDomain: next.shopDomain,
      shopName: next.shopName,
      authMode: next.authMode,
      status: next.status,
      scopes: null,
      missingScopes: [],
      // The grant is not known from a save (scopes null), like missingScopes.
      draftsEnabled: false,
      missingDraftScopes: [],
      webhooksRegisteredAt: next.webhooksRegisteredAt,
      lastSyncAt: next.lastSyncAt,
      lastError: next.lastError,
      catchingUp: connection?.catchingUp ?? false,
      backfill: connection?.backfill ?? {
        status: "idle",
        since: null,
        imported: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        paused: null,
        canReadAllOrders: false,
      },
    });
    setResult(
      warning
        ? { tone: "warn", text: warning }
        : { tone: "good", text: `Connected to ${next.shopName}. Every permission checked out.` },
    );
    setHistorySignal((signal) => signal + 1);
  }

  async function disconnect() {
    setDisconnecting(true);
    setDisconnectError(null);
    const response = await requestJson<{ ok: true }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/connection`, {
      method: "DELETE",
    });
    setDisconnecting(false);
    if (!response.ok) {
      setDisconnectError(response.error);
      return;
    }
    setConfirming(false);
    setResult(null);
    setConnection((current) =>
      current ? { ...current, status: "disabled", webhooksRegisteredAt: null, lastError: null } : current,
    );
    setHistorySignal((signal) => signal + 1);
    // The disconnect controls are gone: the section heading holds focus.
    focusSoon(() => sectionHeading("store"));
  }

  return (
    <SettingsSection
      id="store"
      title="Store connection"
      description={
        canEdit
          ? "The Shopify store this workspace's orders come from. Only platform admins connect or change it."
          : "The Shopify store this workspace's orders come from. A platform admin connects and manages it."
      }
    >
      <Panel className="flex flex-col gap-5">
        {connection ? (
          <ConnectionStatus connection={connection} />
        ) : (
          <div className="flex flex-col items-start gap-2">
            <span className="grid size-10 place-items-center rounded-control bg-surface-2 text-ink-2">
              <StorefrontIcon size={20} aria-hidden />
            </span>
            <p className="font-medium text-ink">No store connected yet</p>
            <p className="text-sm text-ink-2">
              {canEdit
                ? "Connect the store below. Orders start syncing right after."
                : "Orders appear once a platform admin connects the store."}
            </p>
          </div>
        )}
        {result ? <InlineMessage tone={result.tone}>{result.text}</InlineMessage> : null}
        {canEdit ? (
          <>
            <div className="border-t border-line" />
            <ConnectForm workspaceId={workspaceId} existing={connection} onSaved={saved} />
            {connection && connection.status !== "disabled" ? (
              <div className="flex flex-col gap-3 border-t border-line pt-5">
                {confirming ? (
                  <ConfirmStep
                    message={`Disconnect ${connection.shopDomain}? Syncing and live updates stop and the stored credentials are erased. People who have access through a Shopify customer tag lose it until the store is connected again. Orders and their history stay, and connecting the same store again resumes.`}
                    confirmLabel="Disconnect"
                    busyLabel="Disconnecting"
                    busy={disconnecting}
                    onConfirm={disconnect}
                    onCancel={() => setConfirming(false)}
                    returnFocus={() => disconnectRef.current}
                  />
                ) : (
                  <div>
                    <button
                      ref={disconnectRef}
                      type="button"
                      onClick={() => setConfirming(true)}
                      className={ui.buttonSecondary}
                    >
                      Disconnect store
                    </button>
                  </div>
                )}
                {disconnectError ? <InlineMessage tone="bad">{disconnectError}</InlineMessage> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </Panel>
      {canEdit && connection ? (
        <OrderHistoryPanel
          workspaceId={workspaceId}
          initial={connection.backfill}
          connected={connection.status !== "disabled"}
          refreshSignal={historySignal}
        />
      ) : null}
    </SettingsSection>
  );
}
