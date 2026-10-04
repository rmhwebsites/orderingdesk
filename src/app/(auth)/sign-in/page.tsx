import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@/lib/brand";
import { workspaceIcons } from "@/lib/brand-assets";
import { signInView } from "@/server/client-host";
import { requestHost } from "@/server/request-host";
import { BrandScope } from "@/components/shell/brand-scope";
import { ThemedImage } from "@/components/shell/workspace-brand-slot";
import { SignInForm } from "./sign-in-form";

// Reads the request host, so it is rendered per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const view = signInView(await requestHost());
  return view.kind === "workspace"
    ? { title: { absolute: view.heading }, icons: workspaceIcons(view.workspaceId, view.branding) }
    : { title: "Sign in" };
}

// The hub keeps the Ordering Desk sign-in. A workspace's client host shows
// the page in the workspace's theme (colors, fonts and corners through the
// brand scope), with its logo (or symbol) and name and "Sign in to
// <workspace name> orders" (src/server/client-host.ts). An unknown host
// shows nothing.
export default async function SignInPage() {
  const view = signInView(await requestHost());
  if (view.kind === "not-found") {
    notFound();
  }

  if (view.kind === "hub") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 sm:px-6">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-ink-2">Sign in with your email address.</p>
        </div>
        <SignInForm />
      </main>
    );
  }

  return (
    <BrandScope branding={view.branding} accentColor={view.accent} className="min-h-dvh bg-bg font-sans text-ink">
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 sm:px-6">
        <div className="flex flex-col gap-4">
          {/* Uploaded branding files are served by /api/branding. */}
          {view.logo ? (
            <span role="img" aria-label={view.name} className="flex h-10">
              <ThemedImage paths={view.logo} className="h-10 w-auto max-w-[240px] object-contain object-left" />
            </span>
          ) : view.symbol ? (
            <span role="img" aria-label={view.name} className="flex size-10">
              <ThemedImage paths={view.symbol} className="size-10 object-contain" />
            </span>
          ) : (
            <span
              aria-hidden
              className="grid size-10 place-items-center rounded-control bg-primary font-display text-base font-semibold text-primary-ink"
            >
              {view.name.trim().charAt(0).toUpperCase() || "W"}
            </span>
          )}
          <div>
            <p className="text-sm font-medium text-ink-2">{view.name}</p>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">{view.heading}</h1>
            <p className="mt-1 text-sm text-ink-2">Sign in with your email address.</p>
          </div>
        </div>
        <SignInForm />
      </main>
    </BrandScope>
  );
}
