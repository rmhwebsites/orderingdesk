"use client";

import { useRef, useState } from "react";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { ShoppingBagIcon } from "@phosphor-icons/react/ShoppingBag";
import { formatDate } from "@/lib/format";
import { roleLabel, type WorkspaceRole } from "@/lib/roles";
import { useNow } from "@/lib/use-now";
import type { RosterTags } from "@/db/schema";
import type { MemberView, PendingInviteView } from "@/server/members";
import type { RosterRequests, RosterRequestView } from "@/server/roster";
import { ui } from "@/components/ui";
import {
  ConfirmStep,
  describedBy,
  Field,
  focusSoon,
  InlineMessage,
  nearestRowOrder,
  Panel,
  requestJson,
  SaveStatus,
  sectionHeading,
  Select,
  SettingsSection,
  ToneChip,
} from "./kit";

type TeamData = { members: MemberView[]; invites: PendingInviteView[]; requests: RosterRequests; rosterTags: RosterTags };

const NO_REQUESTS: RosterRequests = { waiting: [], denied: [], approved: [] };

type RequestList = "waiting" | "denied" | "approved";

// Why a tag needs approving, said once where the tags are explained.
const TAG_APPROVAL =
  "Tagging a customer in Shopify only requests access, since anyone can tag themselves through the store's own sign-up forms, and a manager approves it here once.";

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
  // Resolves true once the member is gone, false when the removal failed.
  onRemove: () => Promise<boolean>;
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
            setConfirming(false);
            // Gone: the section moves focus to the nearest row (or the
            // heading). Failed: back to this row's Remove button, enabled
            // again by then, next to the error the section shows.
            void onRemove().then((removed) => {
              if (!removed) {
                focusSoon(() => removeRef.current);
              }
            });
          }}
          onCancel={() => setConfirming(false)}
          returnFocus={() => removeRef.current}
        />
      ) : null}
    </li>
  );
}

// One Shopify tag request: the email, the role its tag asks for (and what
// they keep meanwhile when it raises an approved role), since when, and its
// controls. Waiting: Approve, and Deny behind the confirmation step. Denied:
// Approve. Approved but nobody has signed in for it yet: Revoke, behind the
// confirmation step, which denies it.
function RequestRow({
  request,
  list,
  busy,
  showDates,
  onApprove,
  onDeny,
}: {
  request: RosterRequestView;
  list: RequestList;
  // The decision running for this request, if any.
  busy: "approve" | "deny" | null;
  showDates: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const denyRef = useRef<HTMLButtonElement>(null);
  const raise = list === "waiting" && request.currentRole !== null && request.currentRole !== request.role;
  const when = list === "denied" ? request.deniedAt : request.since;
  const whenLabel = list === "denied" ? "denied" : list === "approved" ? "approved" : "since";
  const revoke = list === "approved";
  return (
    <li data-request={request.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium text-ink">{request.email}</p>
          <p className="text-sm text-ink-2">
            {roleLabel(request.role)} tag
            {raise && request.currentRole ? `, ${roleLabel(request.currentRole).toLowerCase()} until approved` : ""}
            {showDates && when !== null ? `, ${whenLabel} ${formatDate(when)}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {revoke ? null : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={onApprove}
              className={ui.buttonSecondary}
              aria-label={`Approve ${request.email} as ${request.role}`}
            >
              {busy === "approve" ? "Approving" : "Approve"}
            </button>
          )}
          {list === "denied" ? null : (
            <button
              ref={denyRef}
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirming(true)}
              className={ui.buttonQuiet}
              aria-label={revoke ? `Revoke the approval for ${request.email}` : `Deny ${request.email}`}
            >
              {revoke ? "Revoke" : "Deny"}
            </button>
          )}
        </div>
      </div>
      {confirming ? (
        <ConfirmStep
          message={
            revoke
              ? `Revoke the approval for ${request.email}? Their tag gives no access here until it is removed in Shopify and added again.`
              : raise && request.currentRole
                ? `Deny ${request.email}? They also lose the ${roleLabel(request.currentRole).toLowerCase()} access they have now, including any open tabs, until the tag is removed in Shopify and added again.`
                : `Deny ${request.email}? Their tag gives no access here until it is removed in Shopify and added again.`
          }
          confirmLabel={revoke ? "Revoke" : "Deny"}
          busyLabel={revoke ? "Revoking" : "Denying"}
          busy={busy === "deny"}
          onConfirm={() => {
            onDeny();
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
          returnFocus={() => denyRef.current}
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
        Shopify customers tagged <span className="font-semibold text-ink">{tags.manager}</span> can be managers here, and
        customers tagged <span className="font-semibold text-ink">{tags.staff}</span> can be staff. {TAG_APPROVAL}{" "}
        Removing the tag removes their access.
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
        Shopify customers with these tags can have that role here. {TAG_APPROVAL} Removing the tag removes their
        access. People invited by hand are never affected.
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
  const [team, setTeam] = useState<TeamData>({ ...initial, requests: initial.requests ?? NO_REQUESTS });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("staff");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteDone, setInviteDone] = useState<string | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/members`;

  const [requestBusy, setRequestBusy] = useState<{ id: string; action: "approve" | "deny" } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  async function reload(): Promise<Omit<TeamData, "rosterTags"> | null> {
    const result = await requestJson<{ members: MemberView[]; invites?: PendingInviteView[]; requests?: RosterRequests }>(
      base,
      { method: "GET" },
    );
    if (!result.ok) {
      return null;
    }
    const next = {
      members: result.data.members,
      invites: result.data.invites ?? [],
      requests: result.data.requests ?? NO_REQUESTS,
    };
    setTeam((current) => ({ ...current, ...next }));
    return next;
  }

  // Approve or deny a Shopify tag request (Revoke on an approved one is a
  // deny). Approve names the role the manager saw, so a tag changed
  // meanwhile is refused (409), not approved.
  async function decide(target: RosterRequestView, action: "approve" | "deny") {
    setRequestBusy({ id: target.id, action });
    setRequestError(null);
    const from: RequestList = team.requests.waiting.some((entry) => entry.id === target.id)
      ? "waiting"
      : team.requests.approved.some((entry) => entry.id === target.id)
        ? "approved"
        : "denied";
    const index = from === "denied" ? -1 : team.requests[from].findIndex((entry) => entry.id === target.id);
    const result = await requestJson<{ ok: true }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/roster/${encodeURIComponent(target.id)}/${action}`,
      { method: "POST", json: action === "approve" ? { role: target.role } : {} },
    );
    if (!result.ok) {
      setRequestError(result.error);
    }
    const next = await reload();
    setRequestBusy(null);
    if (!result.ok) {
      // Back to the control that was used (Deny's step has closed).
      const label = action === "approve" ? "Approve" : from === "approved" ? "Revoke" : "Deny";
      focusSoon(() =>
        document
          .querySelector(`[data-request="${CSS.escape(target.id)}"]`)
          ?.querySelector<HTMLElement>(`button[aria-label^="${label} "]`),
      );
      return;
    }
    // The request left its list: the request that took its place there,
    // else the panel's heading.
    const ids = from === "denied" ? [] : (next ?? team).requests[from].map((entry) => entry.id);
    focusSoon(
      () =>
        (index !== -1 ? rowControl("request", ids, index) : null) ??
        document.getElementById("team-requests-heading") ??
        sectionHeading("team"),
    );
  }

  // The first enabled control of a row of the list, for focus after the row
  // at index was removed: the row that took its place, else the nearest one
  // that has a control (your own row and Shopify-tagged rows have none).
  function rowControl(kind: "member" | "invite" | "request", ids: string[], index: number): HTMLElement | null {
    for (const i of nearestRowOrder(ids.length, index)) {
      const row = document.querySelector(`[data-${kind}="${CSS.escape(ids[i])}"]`);
      const control = row?.querySelector<HTMLElement>("select:not([disabled]), button:not([disabled])");
      if (control) {
        return control;
      }
    }
    return null;
  }

  // Answers whether the change went through. Focus: a role change keeps it
  // on the role control (disabled while saving); a removed row's focus goes
  // to the nearest row, else the list's heading (members) or the invite
  // field (invites). A failed member removal is refocused by MemberRow; a
  // failed invite revoke goes back to its Revoke button.
  async function mutate(id: string, method: "PATCH" | "DELETE", json: unknown): Promise<boolean> {
    setBusyId(id);
    setListError(null);
    const memberIndex = team.members.findIndex((member) => member.userId === id);
    const inviteIndex = team.invites.findIndex((pending) => pending.email === id);
    const result = await requestJson<{ ok: true }>(base, { method, json });
    if (!result.ok) {
      setListError(result.error);
    }
    const next = (await reload()) ?? team;
    setBusyId(null);
    if (method === "PATCH") {
      focusSoon(() => document.getElementById(`role-${id}`));
      return result.ok;
    }
    if (!result.ok) {
      if (inviteIndex !== -1) {
        focusSoon(() =>
          document.querySelector(`[data-invite="${CSS.escape(id)}"]`)?.querySelector<HTMLElement>("button:not([disabled])"),
        );
      }
      return false;
    }
    if (memberIndex !== -1) {
      const ids = next.members.map((member) => member.userId);
      focusSoon(() => rowControl("member", ids, memberIndex) ?? sectionHeading("team"));
    } else if (inviteIndex !== -1) {
      const ids = next.invites.map((pending) => pending.email);
      focusSoon(() => rowControl("invite", ids, inviteIndex) ?? document.getElementById("invite-email"));
    }
    return true;
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
                onRemove={() => mutate(member.userId, "DELETE", { userId: member.userId })}
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

      {team.requests.waiting.length > 0 || team.requests.denied.length > 0 || team.requests.approved.length > 0 ? (
        <Panel className="flex flex-col gap-3">
          <div>
            <h3
              id="team-requests-heading"
              tabIndex={-1}
              className="flex items-center gap-2 font-display text-base font-semibold text-ink"
            >
              Waiting for approval
              {team.requests.waiting.length > 0 ? <ToneChip tone="amber">{team.requests.waiting.length}</ToneChip> : null}
            </h3>
            <p className="mt-1 text-sm text-ink-2">
              From Shopify customer tags. Approve and the tag gives that role here from the person&apos;s next sign-in;
              deny and it gives nothing.
            </p>
          </div>
          {team.requests.waiting.length === 0 ? (
            <p className="text-sm text-ink-2">Nobody is waiting.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {team.requests.waiting.map((entry) => (
                <RequestRow
                  key={entry.id}
                  request={entry}
                  list="waiting"
                  busy={requestBusy?.id === entry.id ? requestBusy.action : null}
                  showDates={now > 0}
                  onApprove={() => void decide(entry, "approve")}
                  onDeny={() => void decide(entry, "deny")}
                />
              ))}
            </ul>
          )}
          {team.requests.approved.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <h4 className="text-sm font-semibold text-ink">Approved, waiting to sign in</h4>
              <p className="text-sm text-ink-2">They join the team the next time they sign in.</p>
              <ul className="flex flex-col divide-y divide-line">
                {team.requests.approved.map((entry) => (
                  <RequestRow
                    key={entry.id}
                    request={entry}
                    list="approved"
                    busy={requestBusy?.id === entry.id ? requestBusy.action : null}
                    showDates={now > 0}
                    onApprove={() => {}}
                    onDeny={() => void decide(entry, "deny")}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {requestError ? <InlineMessage tone="bad">{requestError}</InlineMessage> : null}
          {team.requests.denied.length > 0 ? (
            <details className="border-t border-line pt-3">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Denied ({team.requests.denied.length})</summary>
              <ul className="mt-3 flex flex-col divide-y divide-line">
                {team.requests.denied.map((entry) => (
                  <RequestRow
                    key={entry.id}
                    request={entry}
                    list="denied"
                    busy={requestBusy?.id === entry.id ? requestBusy.action : null}
                    showDates={now > 0}
                    onApprove={() => void decide(entry, "approve")}
                    onDeny={() => {}}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </Panel>
      ) : null}

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
