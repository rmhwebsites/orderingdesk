"use client";

import { useRef, useState } from "react";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { ShoppingBagIcon } from "@phosphor-icons/react/ShoppingBag";
import { formatDate } from "@/lib/format";
import { roleLabel, type WorkspaceRole } from "@/lib/roles";
import { useNow } from "@/lib/use-now";
import type { RosterTags } from "@/db/schema";
import type { MemberView, PendingInviteView } from "@/server/members";
import { ui } from "@/components/ui";
import {
  ConfirmStep,
  describedBy,
  Field,
  focusSoon,
  InlineMessage,
  Panel,
  requestJson,
  SaveStatus,
  sectionHeading,
  Select,
  SettingsSection,
  ToneChip,
} from "./kit";

type TeamData = { members: MemberView[]; invites: PendingInviteView[]; rosterTags: RosterTags };

const DEFAULT_TAGS: RosterTags = { manager: "Ordering Desk Manager", staff: "Ordering Desk Staff" };

function RoleOptions() {
  return (
    <>
      <option value="staff">Staff</option>
      <option value="manager">Manager</option>
    </>
  );
}

function MemberRow({
  member,
  isYou,
  busy,
  onRole,
  onRemove,
}: {
  member: MemberView;
  isYou: boolean;
  busy: boolean;
  onRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);
  const fromShopify = member.source === "shopify";
  const who = member.email ?? member.userId;
  const selectId = `role-${member.userId}`;
  return (
    <li data-member={member.userId} className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            <span className="min-w-0 break-all">{member.name || who}</span>
            {isYou ? <ToneChip tone="slate">You</ToneChip> : null}
            {fromShopify ? (
              <ToneChip tone="teal">
                <ShoppingBagIcon size={12} aria-hidden className="mr-1" />
                From Shopify
              </ToneChip>
            ) : null}
          </p>
          {member.name ? <p className="break-all text-sm text-ink-2">{who}</p> : null}
          {fromShopify ? (
            <p id={`${selectId}-hint`} className="mt-1 text-xs text-ink-2">
              Role follows their Shopify customer tag. Change or remove the tag in Shopify.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {fromShopify || isYou ? (
            <span className="inline-flex h-10 items-center px-1 text-sm font-medium text-ink">{roleLabel(member.role)}</span>
          ) : (
            <>
              <label htmlFor={selectId} className="sr-only">
                Role for {who}
              </label>
              <Select
                id={selectId}
                value={member.role}
                disabled={busy}
                onChange={(event) => onRole(event.target.value as WorkspaceRole)}
                className="w-36"
              >
                <RoleOptions />
              </Select>
            </>
          )}
          {fromShopify || isYou ? null : (
            <button
              ref={removeRef}
              type="button"
              disabled={busy}
              onClick={() => setConfirming(true)}
              className={ui.buttonQuiet}
              aria-label={`Remove ${who}`}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {confirming ? (
        <ConfirmStep
          message={`Remove ${who} from this workspace? They lose access right away, including any open tabs.`}
          confirmLabel="Remove"
          busyLabel="Removing"
          busy={busy}
          onConfirm={() => {
            onRemove();
            setConfirming(false);
            // Stay on this row while the removal runs; the section moves
            // focus on once the row is gone.
            focusSoon(() => removeRef.current);
          }}
          onCancel={() => setConfirming(false)}
          returnFocus={() => removeRef.current}
        />
      ) : null}
    </li>
  );
}

function RosterTagsEditor({
  workspaceId,
  tags,
  canEdit,
  onSaved,
}: {
  workspaceId: string;
  tags: RosterTags;
  canEdit: boolean;
  onSaved: (tags: RosterTags) => void;
}) {
  const [manager, setManager] = useState(tags.manager);
  const [staff, setStaff] = useState(tags.staff);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function save(json: RosterTags | null) {
    setBusy(true);
    setError(null);
    setSaved(null);
    const result = await requestJson<{ tags: RosterTags }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/roster-tags`, {
      method: "PUT",
      json,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setManager(result.data.tags.manager);
    setStaff(result.data.tags.staff);
    onSaved(result.data.tags);
    setSaved("Saved. The next sync, within 10 minutes, applies the new tags.");
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-ink-2">
        Shopify customers tagged <span className="font-semibold text-ink">{tags.manager}</span> are managers here, and
        customers tagged <span className="font-semibold text-ink">{tags.staff}</span> are staff. Adding or removing the
        tag in Shopify grants or removes their access.
      </p>
    );
  }
  const isDefault = manager === DEFAULT_TAGS.manager && staff === DEFAULT_TAGS.staff;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save({ manager, staff });
      }}
    >
      <p className="text-sm text-ink-2">
        Shopify customers with these tags get that role here. Adding or removing the tag in Shopify grants or removes
        their access. People invited by hand are never affected.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="tag-manager" label="Manager tag">
          <input
            id="tag-manager"
            value={manager}
            maxLength={40}
            onChange={(event) => setManager(event.target.value)}
            className={ui.input}
          />
        </Field>
        <Field id="tag-staff" label="Staff tag">
          <input id="tag-staff" value={staff} maxLength={40} onChange={(event) => setStaff(event.target.value)} className={ui.input} />
        </Field>
      </div>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={ui.buttonSecondary}>
          {busy ? "Saving" : "Save tags"}
        </button>
        {isDefault ? null : (
          <button type="button" disabled={busy} onClick={() => void save(null)} className={ui.buttonQuiet}>
            Use the default tags
          </button>
        )}
        <SaveStatus text={saved} />
      </div>
    </form>
  );
}

export function TeamSection({
  workspaceId,
  viewerUserId,
  initial,
  canEditRosterTags,
}: {
  workspaceId: string;
  viewerUserId: string;
  initial: TeamData;
  canEditRosterTags: boolean;
}) {
  const now = useNow(60000);
  const [team, setTeam] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("staff");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteDone, setInviteDone] = useState<string | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/members`;

  async function reload(): Promise<{ members: MemberView[]; invites: PendingInviteView[] } | null> {
    const result = await requestJson<{ members: MemberView[]; invites?: PendingInviteView[] }>(base, { method: "GET" });
    if (!result.ok) {
      return null;
    }
    const next = { members: result.data.members, invites: result.data.invites ?? [] };
    setTeam((current) => ({ ...current, ...next }));
    return next;
  }

  // The first control of the member or invite row now at index (or the
  // last one), for focus after a row was removed.
  function rowControl(kind: "member" | "invite", ids: string[], index: number): HTMLElement | null {
    const id = ids[Math.min(index, ids.length - 1)];
    if (id === undefined) {
      return null;
    }
    const row = document.querySelector(`[data-${kind}="${CSS.escape(id)}"]`);
    return row?.querySelector<HTMLElement>("select:not([disabled]), button:not([disabled])") ?? null;
  }

  async function mutate(id: string, method: "PATCH" | "DELETE", json: unknown) {
    setBusyId(id);
    setListError(null);
    const memberIndex = team.members.findIndex((member) => member.userId === id);
    const inviteIndex = team.invites.findIndex((pending) => pending.email === id);
    const result = await requestJson<{ ok: true }>(base, { method, json });
    if (!result.ok) {
      setListError(result.error);
    }
    const next = await reload();
    setBusyId(null);
    if (method !== "DELETE" || !result.ok || !next) {
      return;
    }
    // The removed row is gone: focus the row that took its place, else the
    // list's heading (members) or the invite field (invites).
    if (memberIndex !== -1) {
      const ids = next.members.map((member) => member.userId);
      focusSoon(() => rowControl("member", ids, memberIndex) ?? sectionHeading("team"));
    } else if (inviteIndex !== -1) {
      const ids = next.invites.map((pending) => pending.email);
      focusSoon(() => rowControl("invite", ids, inviteIndex) ?? document.getElementById("invite-email"));
    }
  }

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviting) {
      return;
    }
    setInviting(true);
    setInviteError(null);
    setInviteDone(null);
    const sent = email.trim();
    const result = await requestJson<{ ok: true; alreadyMember?: boolean }>(base, { method: "POST", json: { email: sent, role } });
    setInviting(false);
    if (!result.ok) {
      setInviteError(result.error);
      return;
    }
    setEmail("");
    setInviteDone(result.data.alreadyMember ? `${sent} already belongs to this workspace.` : `Invite sent to ${sent}. They join when they sign in.`);
    await reload();
  }

  return (
    <SettingsSection
      id="team"
      title="Team"
      description="Who can open this workspace. Managers invite and remove people and set their roles; staff work the orders. Platform admins can open every workspace and are not listed."
    >
      <Panel>
        {team.members.length === 0 ? (
          <p className="text-sm text-ink-2">Nobody belongs to this workspace yet. Invite the first person below.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {team.members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                isYou={member.userId === viewerUserId}
                busy={busyId === member.userId}
                onRole={(next) => void mutate(member.userId, "PATCH", { userId: member.userId, role: next })}
                onRemove={() => void mutate(member.userId, "DELETE", { userId: member.userId })}
              />
            ))}
          </ul>
        )}
        {listError ? (
          <div className="mt-3">
            <InlineMessage tone="bad">{listError}</InlineMessage>
          </div>
        ) : null}
      </Panel>

      <Panel className="flex flex-col gap-4">
        <h3 className="font-display text-base font-semibold text-ink">Invite someone</h3>
        <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="invite-email" label="Email" error={inviteError} className="flex-1">
            <input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              autoComplete="off"
              aria-invalid={inviteError ? true : undefined}
              aria-describedby={describedBy("invite-email", { error: inviteError })}
              className={ui.input}
            />
          </Field>
          <Field id="invite-role" label="Role" className="sm:w-40">
            <Select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>
              <RoleOptions />
            </Select>
          </Field>
          <button type="submit" disabled={inviting} className={`${ui.buttonPrimary} sm:self-end`}>
            <EnvelopeSimpleIcon size={16} aria-hidden />
            {inviting ? "Sending" : "Send invite"}
          </button>
        </form>
        <SaveStatus text={inviteDone} />
        {team.invites.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <h4 className="text-sm font-semibold text-ink">Waiting to sign in</h4>
            <ul className="flex flex-col divide-y divide-line">
              {team.invites.map((pending) => (
                <li
                  key={pending.email}
                  data-invite={pending.email}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="min-w-0 flex-1 break-all text-sm text-ink">{pending.email}</span>
                  <span className="text-sm text-ink-2">
                    {roleLabel(pending.role)}
                    {now > 0 ? `, invited ${formatDate(pending.createdAt)}` : ""}
                  </span>
                  <button
                    type="button"
                    disabled={busyId === pending.email}
                    onClick={() => void mutate(pending.email, "DELETE", { email: pending.email })}
                    className={ui.buttonQuiet}
                    aria-label={`Revoke the invite for ${pending.email}`}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel className="flex flex-col gap-3">
        <h3 className="font-display text-base font-semibold text-ink">Access from Shopify tags</h3>
        <RosterTagsEditor
          workspaceId={workspaceId}
          tags={team.rosterTags}
          canEdit={canEditRosterTags}
          onSaved={(rosterTags) => setTeam((current) => ({ ...current, rosterTags }))}
        />
      </Panel>
    </SettingsSection>
  );
}
