import Link from "next/link";
import { headers } from "next/headers";
import { APP_NAME } from "@/lib/brand";
import { signInView } from "@/server/client-host";
import { requestHost } from "@/server/request-host";
import { Monogram } from "@/components/kit";
import { BrandScope } from "@/components/shell/brand-scope";
import { ThemedImage } from "@/components/shell/workspace-brand-slot";
import { ui } from "@/components/ui";

// Not found, by host (src/server/client-host.ts): the hub keeps the
// Ordering Desk page; a workspace's client host shows it in the workspace's
// theme with its name and a way back to its orders.
export default async function NotFound() {
  // Read the request first: it marks this page dynamic before anything
  // touches the Cloudflare context (there is none at build time).
  await headers();
  const view = signInView(await requestHost());
  if (view.kind !== "workspace") {
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
  return (
    <BrandScope branding={view.branding} accentColor={view.accent} className="min-h-dvh bg-bg font-sans text-ink">
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 sm:px-6">
        {view.symbol ? (
          <span role="img" aria-label={view.name} className="flex size-10">
            <ThemedImage paths={view.symbol} className="size-10 object-contain" />
          </span>
        ) : (
          <Monogram text={view.name.trim().charAt(0).toUpperCase() || "W"} size="lg" />
        )}
        <p className="text-sm font-medium text-ink-2">{view.name}</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">This page is not here</h1>
        <p className="text-sm text-ink-2">The link may be old or mistyped.</p>
        <Link href="/" className={`${ui.buttonSecondary} self-start`}>
          {`Go to ${view.name} orders`}
        </Link>
      </main>
    </BrandScope>
  );
}
