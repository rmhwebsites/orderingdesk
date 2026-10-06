"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SignOutIcon } from "@phosphor-icons/react/SignOut";
import { authClient } from "@/lib/auth-client";
import { disableDevicePush } from "@/lib/push-client";
import { Spinner } from "@/components/kit";
import { ui } from "@/components/ui";

// How long signing out waits for this browser's push subscription to be
// forgotten before it signs out anyway.
const FORGET_PUSH_MS = 2000;

// variant "menu": a row of the account menu (className from the menu).
export function SignOutButton({ variant = "button", className }: { variant?: "button" | "menu"; className?: string }) {
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
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      aria-busy={busy || undefined}
      className={className ?? ui.buttonSecondary}
    >
      {busy ? <Spinner /> : variant === "menu" ? <SignOutIcon size={18} aria-hidden /> : null}
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}
