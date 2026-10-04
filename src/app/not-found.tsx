import Link from "next/link";
import { APP_NAME } from "@/lib/brand";
import { ui } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 sm:px-6">
      <p className="text-sm font-medium text-ink-2">{APP_NAME}</p>
      <h1 className="font-display text-2xl font-semibold tracking-tight">This page is not here</h1>
      <p className="text-sm text-ink-2">
        The link may be old or mistyped. If it is for a workspace you expected to open, ask your manager to invite
        you.
      </p>
      <Link href="/" className={`${ui.buttonSecondary} self-start`}>
        Go to your workspaces
      </Link>
    </main>
  );
}
