"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/ArrowsLeftRight";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { initials } from "@/lib/format";
import type { AccountView } from "@/server/account";
import { SignOutButton } from "@/app/sign-out-button";
import { Monogram, Spinner } from "@/components/kit";
import { ThemeToggle } from "@/components/theme-toggle";
import { ui } from "@/components/ui";

// The account menu (comprehensive desk design section 1): who is signed in,
// their role, the theme, switch workspace and Sign out, on every host. Below
// the large breakpoint it also holds Sync now (the top bar has no room for
// the Sync button there) and, on phones, Settings.

export type AccountSync = {
  // The sync state in words ("Synced 5 h ago") and what to do about it.
  label: string;
  tip: string | null;
  running: boolean;
  disabled: boolean;
  onSync: () => void;
};

const row =
  "flex min-h-11 w-full items-center gap-3 rounded-control px-3 text-left text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60";

export function AccountMenuPanel({
  account,
  settingsHref,
  sync,
}: {
  account: AccountView;
  settingsHref: string | null;
  sync: AccountSync | null;
}) {
  return (
    <div className="flex flex-col p-2">
      <div className="flex items-center gap-3 px-2 py-2">
        <Monogram text={initials(account.name, account.email)} size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{account.name ?? account.email}</p>
          {account.name ? <p className="truncate text-xs text-ink-2">{account.email}</p> : null}
          {account.roleLabel ? <p className="text-xs font-medium text-ink-2">{account.roleLabel}</p> : null}
        </div>
      </div>
      <div className="border-t border-line px-2 pb-2 pt-3">
        <p aria-hidden className="mb-2 text-xs font-semibold text-ink-2">
          Theme
        </p>
        <ThemeToggle labels />
      </div>
      <ul className="flex flex-col border-t border-line pt-1">
        {sync ? (
          <li className="lg:hidden">
            <button type="button" onClick={sync.onSync} disabled={sync.disabled} aria-busy={sync.running || undefined} className={row}>
              {sync.running ? <Spinner size={18} /> : <ArrowsClockwiseIcon size={18} aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="block">{sync.running ? "Syncing" : "Sync now"}</span>
                <span className="block text-xs font-normal text-ink-2">
                  {sync.tip ? `${sync.label}. ${sync.tip}` : sync.label}
                </span>
              </span>
            </button>
          </li>
        ) : null}
        {settingsHref ? (
          <li className="sm:hidden">
            <Link href={settingsHref} className={row}>
              <GearSixIcon size={18} aria-hidden />
              Settings
            </Link>
          </li>
        ) : null}
        {account.links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className={row}>
              {link.label}
            </Link>
          </li>
        ))}
        {account.switchHref ? (
          <li>
            <a href={account.switchHref} className={row}>
              <ArrowsLeftRightIcon size={18} aria-hidden />
              Switch workspace
            </a>
          </li>
        ) : null}
        <li>
          <SignOutButton variant="menu" className={row} />
        </li>
      </ul>
    </div>
  );
}

// One button with the person's initials opens the panel below it, right
// aligned (keep it last in its row so the panel stays on screen). Esc and a
// click outside close it; focus returns to the button.
export function AccountMenu({
  account,
  settingsHref = null,
  sync = null,
}: {
  account: AccountView;
  settingsHref?: string | null;
  sync?: AccountSync | null;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    panelRef.current?.focus();
    function onPointerDown(event: PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account menu for ${account.name ?? account.email}`}
        onClick={() => setOpen((current) => !current)}
        className={ui.iconButton}
      >
        <Monogram text={initials(account.name, account.email)} size="sm" />
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-label="Account"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) {
              setOpen(false);
            }
          }}
          className="od-rise absolute right-0 top-full z-10 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-panel border border-line bg-surface shadow-lift focus:outline-none"
        >
          <AccountMenuPanel
            account={account}
            settingsHref={settingsHref}
            sync={
              sync
                ? {
                    ...sync,
                    onSync: () => {
                      sync.onSync();
                      setOpen(false);
                    },
                  }
                : null
            }
          />
        </div>
      ) : null}
    </div>
  );
}
