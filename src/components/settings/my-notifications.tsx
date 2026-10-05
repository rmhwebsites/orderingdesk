"use client";

import { useEffect, useRef, useState } from "react";
import { BellRingingIcon } from "@phosphor-icons/react/BellRinging";
import { DeviceMobileIcon } from "@phosphor-icons/react/DeviceMobile";
import {
  currentDevicePushKind,
  currentSubscription,
  disableDevicePush,
  enableDevicePush,
} from "@/lib/push-client";
import type { NotificationPrefsView } from "@/server/notification-prefs";
import { IphoneInstallSteps } from "@/components/shell/app-install";
import { ui } from "@/components/ui";
import { focusSoon, InlineMessage, Panel, requestJson, SaveStatus, SettingsSection, Switch, ToneChip } from "./kit";

// Settings > Your notifications, for every member: push on this device
// (the browser's own subscription, kept per person on the server), and the
// person's three choices for this workspace. Status changes and notes are
// always in the app (the bell and live updates); the third switch adds a
// push for them.

type DeviceState =
  | { kind: "checking" }
  | { kind: "install-first" }
  | { kind: "unsupported" }
  | { kind: "blocked" }
  | { kind: "off" }
  | { kind: "on" };

function readDeviceState(): Promise<DeviceState> {
  const kind = currentDevicePushKind();
  if (kind !== "ready") {
    return Promise.resolve({ kind });
  }
  if (Notification.permission === "denied") {
    return Promise.resolve({ kind: "blocked" });
  }
  return currentSubscription().then((subscription) =>
    subscription && Notification.permission === "granted" ? { kind: "on" } : { kind: "off" },
  );
}

const DEVICE_TOGGLE_ID = "alerts-device-push";

function DevicePanel() {
  const [state, setState] = useState<DeviceState>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readDeviceState().then((next) => {
      if (live) {
        setState(next);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // The button is disabled while it works (and swapped for the other one
  // after), which drops focus to the page: hand it to the button shown now.
  const refocus = () => focusSoon(() => document.getElementById(DEVICE_TOGGLE_ID));

  async function enable() {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await enableDevicePush();
    setBusy(false);
    refocus();
    if (result.ok) {
      setState({ kind: "on" });
      setDone("Push is on for this device.");
      return;
    }
    if (result.reason === "denied") {
      setState({ kind: "blocked" });
    }
    setError(result.message);
  }

  async function disable() {
    setBusy(true);
    setError(null);
    setDone(null);
    const ok = await disableDevicePush();
    setBusy(false);
    refocus();
    if (ok) {
      setState({ kind: "off" });
      setDone("Push is off for this device.");
    } else {
      setError("Push could not be turned off. Check your connection and try again.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DeviceMobileIcon size={18} aria-hidden className="text-ink-2" />
        <h3 className="font-display text-base font-semibold text-ink">This device</h3>
        {state.kind === "on" ? <ToneChip tone="green">Push on</ToneChip> : null}
        {state.kind === "off" ? <ToneChip tone="slate">Push off</ToneChip> : null}
        {state.kind === "blocked" ? <ToneChip tone="amber">Blocked</ToneChip> : null}
      </div>

      {state.kind === "checking" ? (
        <div aria-label="Checking this device" role="status" className="flex flex-col gap-2">
          <span className="od-skeleton h-4 w-64 max-w-full" />
          <span className="od-skeleton h-10 w-56" />
          <span className="sr-only">Checking this device</span>
        </div>
      ) : null}

      {state.kind === "install-first" ? (
        <div className="flex flex-col gap-2 text-sm text-ink">
          <p className="font-semibold">Install on your phone first.</p>
          <p className="max-w-[65ch] text-ink-2">
            <IphoneInstallSteps /> Then open Settings in the installed app and turn push on here.
          </p>
        </div>
      ) : null}

      {state.kind === "unsupported" ? (
        <p className="max-w-[65ch] text-sm text-ink-2">
          This browser cannot show push notifications. Use a current version of Chrome, Edge, Firefox or Safari, or
          install the app on your phone.
        </p>
      ) : null}

      {state.kind === "blocked" ? (
        <p className="max-w-[65ch] text-sm text-ink-2">
          Notifications are blocked for this site in your browser settings. Allow them there, then reload this page and
          turn push on.
        </p>
      ) : null}

      {state.kind === "off" ? (
        <>
          <p className="max-w-[65ch] text-sm text-ink-2">
            Get new orders and sent purchase orders as notifications on this device, even when Ordering Desk is closed.
          </p>
          <div>
            <button id={DEVICE_TOGGLE_ID} type="button" onClick={enable} disabled={busy} className={ui.buttonPrimary}>
              <BellRingingIcon size={16} aria-hidden />
              {busy ? "Turning on push" : "Enable push on this device"}
            </button>
          </div>
        </>
      ) : null}

      {state.kind === "on" ? (
        <>
          <p className="max-w-[65ch] text-sm text-ink-2">
            This device gets push notifications for the choices below, in every workspace you belong to.
          </p>
          <div>
            <button id={DEVICE_TOGGLE_ID} type="button" onClick={disable} disabled={busy} className={ui.buttonSecondary}>
              {busy ? "Turning off push" : "Turn off on this device"}
            </button>
          </div>
        </>
      ) : null}

      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <SaveStatus text={done} />
    </div>
  );
}

const CHOICES: Array<{ field: keyof NotificationPrefsView; id: string; label: string; help: string }> = [
  {
    field: "pushNewOrders",
    id: "alerts-push-orders",
    label: "Phone push for new orders and purchase orders",
    help: "Sent to every device where push is on.",
  },
  {
    field: "emailNewOrders",
    id: "alerts-email-orders",
    label: "Email for new orders and purchase orders",
    help: "Sent to the address you sign in with.",
  },
  {
    field: "pushAllActivity",
    id: "alerts-push-activity",
    label: "Phone push for all other activity",
    help: "Status changes and notes by others. They always show in the bell while you are here.",
  },
];

function ChoicesPanel({ workspaceId, initial }: { workspaceId: string; initial: NotificationPrefsView }) {
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState<keyof NotificationPrefsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const confirmed = useRef(initial);
  const inFlight = useRef(false);

  // One change at a time. The switches stay focusable while it saves
  // (busy, not disabled), so keyboard and screen reader users keep their
  // place.
  async function change(field: keyof NotificationPrefsView, value: boolean) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setPrefs((current) => ({ ...current, [field]: value }));
    setSaving(field);
    setError(null);
    setDone(null);
    const result = await requestJson<{ prefs: NotificationPrefsView }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/notification-prefs`,
      { method: "PUT", json: { [field]: value } },
    );
    inFlight.current = false;
    setSaving(null);
    if (!result.ok) {
      setPrefs(confirmed.current);
      setError(`Not saved. ${result.error}`);
      return;
    }
    confirmed.current = result.data.prefs;
    setPrefs(result.data.prefs);
    setDone("Saved.");
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="font-display text-base font-semibold text-ink">What you get</h3>
      <ul className="flex flex-col gap-4">
        {CHOICES.map((choice) => (
          <li key={choice.field} className="flex flex-col gap-1">
            <Switch
              id={choice.id}
              checked={prefs[choice.field]}
              busy={saving !== null}
              onChange={(value) => void change(choice.field, value)}
              label={choice.label}
              describedBy={`${choice.id}-help`}
            />
            <p id={`${choice.id}-help`} className="pl-[3.125rem] text-sm text-ink-2">
              {choice.help}
            </p>
          </li>
        ))}
      </ul>
      {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
      <SaveStatus text={done} />
    </div>
  );
}

export function MyNotificationsSection({
  workspaceId,
  workspaceName,
  initial,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: { member: boolean; prefs: NotificationPrefsView };
}) {
  return (
    <SettingsSection
      id="alerts"
      title="Your notifications"
      description={`How you hear about new orders and purchase orders in ${workspaceName}. Everything else shows in the bell and as live updates while you have it open.`}
    >
      <Panel>
        <DevicePanel />
      </Panel>
      <Panel>
        {initial.member ? (
          <ChoicesPanel workspaceId={workspaceId} initial={initial.prefs} />
        ) : (
          <InlineMessage tone="info">
            You are not a member of {workspaceName}, so it does not send you notifications. Platform admins get them only
            from workspaces they belong to.
          </InlineMessage>
        )}
      </Panel>
    </SettingsSection>
  );
}
