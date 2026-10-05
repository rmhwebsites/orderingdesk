"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { disableDevicePush } from "@/lib/push-client";
import { ui } from "@/components/ui";

// How long signing out waits for this browser's push subscription to be
// forgotten before it signs out anyway.
const FORGET_PUSH_MS = 2000;

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      // A signed-out browser stops getting this person's notifications
      // (a shared device): forget its push subscription while the session
      // still allows it.
      await Promise.race([disableDevicePush(), new Promise((resolve) => setTimeout(resolve, FORGET_PUSH_MS))]);
      await authClient.signOut();
    } finally {
      router.replace("/sign-in");
      router.refresh();
    }
  }

  return (
    <button type="button" onClick={handleClick} disabled={busy} className={ui.buttonSecondary}>
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}
