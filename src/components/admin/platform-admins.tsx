"use client";

import { useState } from "react";
import { UserPlusIcon } from "@phosphor-icons/react/UserPlus";
import { formatDate } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { PlatformAdminView, PlatformInviteView } from "@/server/platform-admins";
import { Chip } from "@/components/kit";
import {
  ConfirmStep,
  describedBy,
  Field,
  focusSoon,
  InlineMessage,
  Panel,
  requestJson,
  SaveStatus,
} from "@/components/settings/kit";
import { ui } from "@/components/ui";

type AdminsData = { admins: PlatformAdminView[]; invites: PlatformInviteView[] };

// Platform admins: the bootstrap list (from the PLATFORM_ADMIN_EMAILS
// secret, changed only there) and everyone promoted here, who can be
// revoked; inviting someone with no account leaves a pending invite.
export function PlatformAdmins({ initial, viewerUserId }: { initial: AdminsData; viewerUserId: string }) {
  const now = useNow(60000);
  const [data, setData] = useState(initial);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function reload() {
    const result = await requestJson<AdminsData>("/api/platform/admins", { method: "GET" });
    if (result.ok) {
      setData(result.data);
    }
  }

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("invite");
    setError(null);
    setDone(null);
    const sent = email.trim();
    const result = await requestJson<{ ok: true; alreadyAdmin?: boolean }>("/api/platform/admins", {
      method: "POST",
      json: { email: sent },
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEmail("");
    setDone(result.data.alreadyAdmin ? `${sent} is already a platform admin.` : `Invite sent to ${sent}.`);
    await reload();
  }

  async function revoke(key: string, json: { userId: string } | { email: string }) {
    setBusy(key);
    setError(null);
    setDone(null);
    const result = await requestJson<{ ok: true }>("/api/platform/admins", { method: "DELETE", json });
    setBusy(null);
    setConfirming(null);
    if (!result.ok) {
      setError(result.error);
      focusSoon(() => document.getElementById(`revoke-${key}`));
      return;
    }
    await reload();
    // The row is gone: the add field holds focus next.
    focusSoon(() => document.getElementById("admin-email"));
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <ul className="flex flex-col divide-y divide-line">
          {data.admins.map((admin) => {
            const key = admin.userId ?? admin.email;
            const isYou = admin.userId === viewerUserId;
            return (
              <li key={key} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-sm font-medium text-ink">{admin.name || admin.email}</span>
                    {admin.name ? <span className="block break-all text-sm text-ink-2">{admin.email}</span> : null}
                  </span>
                  {isYou ? <Chip size="sm" tone="slate">You</Chip> : null}
                  {admin.source === "bootstrap" ? (
                    <Chip size="sm" tone="blue">From the Worker secret</Chip>
                  ) : (
                    <Chip size="sm" tone="green">Promoted</Chip>
                  )}
                  {admin.source === "granted" && admin.userId && !isYou ? (
                    <button
                      id={`revoke-${key}`}
                      type="button"
                      onClick={() => setConfirming(key)}
                      disabled={busy !== null}
                      className={ui.buttonQuiet}
                      aria-label={`Revoke platform admin access for ${admin.email}`}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
                {admin.source === "bootstrap" && !admin.userId ? (
                  <p className="text-xs text-ink-2">Has not signed in yet.</p>
                ) : null}
                {confirming === key && admin.userId ? (
                  <ConfirmStep
                    message={`Revoke platform admin access for ${admin.email}? They keep only the workspaces they belong to, and their other open tabs close.`}
                    confirmLabel="Revoke"
                    busyLabel="Revoking"
                    busy={busy === key}
                    onConfirm={() => void revoke(key, { userId: admin.userId! })}
                    onCancel={() => setConfirming(null)}
                    returnFocus={() => document.getElementById(`revoke-${key}`)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs text-ink-2">
          Admins from the PLATFORM_ADMIN_EMAILS Worker secret change only there.
        </p>
      </Panel>

      <Panel className="flex flex-col gap-4">
        <h3 className="font-display text-base font-semibold text-ink">Add a platform admin</h3>
        <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field
            id="admin-email"
            label="Email"
            help="They can open and manage every workspace."
            className="flex-1"
          >
            <input
              id="admin-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              autoComplete="off"
              aria-describedby={describedBy("admin-email", { help: true })}
              className={ui.input}
            />
          </Field>
          <button type="submit" disabled={busy !== null} className={ui.buttonPrimary}>
            <UserPlusIcon size={16} aria-hidden />
            {busy === "invite" ? "Sending" : "Send invite"}
          </button>
        </form>
        <SaveStatus text={done} />
        {data.invites.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <h4 className="text-sm font-semibold text-ink">Waiting to sign in</h4>
            <ul className="flex flex-col divide-y divide-line">
              {data.invites.map((pending) => (
                <li key={pending.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
                  <span className="min-w-0 flex-1 break-all text-sm text-ink">{pending.email}</span>
                  {now > 0 ? <span className="text-sm text-ink-2">Invited {formatDate(pending.createdAt)}</span> : null}
                  <button
                    type="button"
                    onClick={() => void revoke(`invite:${pending.email}`, { email: pending.email })}
                    disabled={busy !== null}
                    className={ui.buttonQuiet}
                    aria-label={`Withdraw the invite for ${pending.email}`}
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
    </div>
  );
}
