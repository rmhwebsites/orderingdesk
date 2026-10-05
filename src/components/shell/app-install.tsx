"use client";

import { useEffect, useState } from "react";
import { DeviceMobileIcon } from "@phosphor-icons/react/DeviceMobile";
import { ExportIcon } from "@phosphor-icons/react/Export";
import { XIcon } from "@phosphor-icons/react/X";
import { shouldShowInstallHint, syncDevicePush } from "@/lib/push-client";
import { ui } from "@/components/ui";

const HINT_DISMISSED_KEY = "od-install-hint-dismissed";

// Registers the service worker (public/sw.js) once the workspace shell is
// on screen, and re-sends this browser's push subscription so it belongs to
// whoever is signed in now. Renders nothing.
export function DevicePushSetup() {
  useEffect(() => {
    void syncDevicePush();
  }, []);
  return null;
}

// The iPhone steps in words, with the Share icon Safari shows. Shared by
// the shell hint and Settings.
export function IphoneInstallSteps() {
  return (
    <>
      In Safari, tap Share{" "}
      <ExportIcon size={16} aria-hidden className="inline-block -translate-y-px align-middle" />
      <span className="sr-only">(the square with an arrow pointing up)</span>, then Add to Home Screen. Open the app from your
      home screen to get notifications: iPhone delivers them only to installed apps.
    </>
  );
}

// On an iPhone or iPad in Safari (not the installed app): how to install,
// once, until dismissed on this device.
export function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(HINT_DISMISSED_KEY) === "1";
    } catch {
      dismissed = false;
    }
    setShow(!dismissed && shouldShowInstallHint());
  }, []);

  if (!show) {
    return null;
  }

  function dismiss() {
    setShow(false);
    try {
      window.localStorage.setItem(HINT_DISMISSED_KEY, "1");
    } catch {
      // Shown again on the next visit; nothing else depends on it.
    }
  }

  return (
    <aside aria-label="Install on your phone" className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-[1400px] items-start gap-3 px-4 py-2.5 sm:px-6">
        <DeviceMobileIcon size={20} aria-hidden className="mt-0.5 shrink-0 text-ink-2" />
        <p className="min-w-0 flex-1 text-sm text-ink">
          <span className="font-semibold">Install on your phone. </span>
          <IphoneInstallSteps />
        </p>
        <button type="button" onClick={dismiss} className={`${ui.iconButton} -my-1.5 -mr-2 size-9`}>
          <XIcon size={16} aria-hidden />
          <span className="sr-only">Dismiss the install hint</span>
        </button>
      </div>
    </aside>
  );
}
