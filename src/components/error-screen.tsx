"use client";

import Link from "next/link";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { ui } from "@/components/ui";

// What a screen that failed to render says (the error.tsx files): plainly
// that it did not load, Try again, and a way out. Never the error's own
// text; the digest lets the operator find the server log line.
export function ErrorScreen({
  title,
  onRetry,
  homeHref,
  homeLabel,
  digest,
}: {
  title: string;
  onRetry: () => void;
  homeHref: string;
  homeLabel: string;
  digest?: string;
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col items-start gap-4 px-4 py-16 sm:px-6">
      <span className="grid size-12 place-items-center rounded-control bg-surface-2 text-ink-2">
        <WarningCircleIcon size={24} aria-hidden />
      </span>
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      <p className="text-sm text-ink-2">
        {digest
          ? `Try again. If it keeps happening, tell your platform admin the code ${digest}.`
          : "Try again. If it keeps happening, tell your platform admin."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className={ui.buttonPrimary}>
          Try again
        </button>
        <Link href={homeHref} className={ui.buttonSecondary}>
          {homeLabel}
        </Link>
      </div>
    </main>
  );
}
