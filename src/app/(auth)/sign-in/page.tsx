import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { accentStyle } from "@/lib/accent";
import { APP_NAME } from "@/lib/brand";
import { signInView } from "@/server/client-host";
import { requestHost } from "@/server/request-host";
import { SignInForm } from "./sign-in-form";

// Reads the request host, so it is rendered per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const view = signInView(await requestHost());
  return view.kind === "workspace" ? { title: { absolute: view.heading } } : { title: "Sign in" };
}

// The hub keeps the Ordering Desk sign-in. A workspace's client host shows
// the workspace's logo and name and "Sign in to <workspace name> orders",
// with its primary color on the button (src/server/client-host.ts). An
// unknown host shows nothing.
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
    <main
      data-accent-scope
      style={accentStyle(view.accent)}
      className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 sm:px-6"
    >
      <div className="flex flex-col gap-4">
        {view.logo ? (
          // Uploaded branding files are served by /api/branding (plain img:
          // an SVG logo must not go through the image optimizer).
          <span className="block">
            <img
              src={view.logo.light}
              alt={view.name}
              className={`h-10 w-auto max-w-[240px] object-contain object-left ${view.logo.dark ? "od-logo-light" : ""}`}
            />
            {view.logo.dark ? (
              <img
                src={view.logo.dark}
                alt={view.name}
                className="od-logo-dark h-10 w-auto max-w-[240px] object-contain object-left"
              />
            ) : null}
          </span>
        ) : (
          <span
            aria-hidden
            className="grid size-10 place-items-center rounded-full bg-accent font-display text-base font-semibold text-accent-ink"
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
  );
}
