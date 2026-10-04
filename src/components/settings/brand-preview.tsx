"use client";

import { useEffect, useState } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { APP_NAME } from "@/lib/brand";
import { brandImages } from "@/lib/brand-assets";
import type { WorkspaceBranding } from "@/lib/branding";
import { BrandScope } from "@/components/shell/brand-scope";
import { WorkspaceBrandSlot } from "@/components/shell/workspace-brand-slot";
import { ui } from "@/components/ui";

// One themed copy of a few workspace surfaces: a mini desk header, a
// filter chip, an input, an order card and the buttons, rendered with the
// draft theme and forced to one theme so light and dark sit side by side.
function PreviewCopy({
  theme,
  workspaceId,
  name,
  branding,
  accentColor,
}: {
  theme: "light" | "dark";
  workspaceId: string;
  name: string;
  branding: WorkspaceBranding;
  accentColor: string;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-xs font-semibold text-ink-2">{theme === "light" ? "Light mode" : "Dark mode"}</figcaption>
      <BrandScope
        branding={branding}
        accentColor={accentColor}
        complete
        forceTheme={theme}
        hoistFonts={false}
        className="overflow-hidden rounded-panel border border-line bg-bg font-sans text-ink"
      >
        {/* Decorative: a picture of the theme, not working controls. */}
        <div aria-hidden inert className="pointer-events-none select-none">
          <div className="flex items-center gap-2.5 border-b border-line bg-surface px-3 py-2.5">
            <WorkspaceBrandSlot name={name} images={brandImages(workspaceId, branding)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-sm font-semibold leading-tight text-ink">{name}</span>
              <span className="block text-[11px] leading-tight text-ink-2">{APP_NAME}</span>
            </span>
            <span className={`${ui.buttonPrimary} h-8 px-3 text-xs`}>
              <ArrowsClockwiseIcon size={14} />
              Sync
            </span>
          </div>
          <div className="flex flex-col gap-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong bg-surface px-3 text-xs font-semibold text-ink shadow-panel">
                All orders
                <span className="font-mono text-[11px] tabular-nums text-ink-2">24</span>
                <span className="absolute inset-x-2.5 -bottom-px h-[3px] rounded-control bg-primary" />
              </span>
              <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line px-3 text-xs text-ink-2">
                Processing
                <span className="font-mono text-[11px] tabular-nums">6</span>
              </span>
            </div>
            <div className="relative">
              <MagnifyingGlassIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <span className={`${ui.input} flex h-9 items-center pl-8 text-xs text-ink-3`}>Search orders</span>
            </div>
            <div className={`${ui.panel} flex flex-col gap-2 p-3 shadow-panel`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold tabular-nums text-ink">#1042</span>
                <span className="font-mono text-sm tabular-nums text-ink">$1,284.00</span>
              </div>
              <p className="font-display text-sm font-semibold text-ink">Dana Whitfield</p>
              <p className="text-xs text-ink-2">3 items, ordered today</p>
              <p className="flex items-center gap-1.5 text-xs font-medium text-primary-strong">
                <CheckCircleIcon size={14} />
                Paid
              </p>
            </div>
            <div className="flex gap-2">
              <span className={`${ui.buttonPrimary} h-9 px-3.5 text-xs`}>Save</span>
              <span className={`${ui.buttonSecondary} h-9 px-3.5 text-xs`}>Cancel</span>
            </div>
          </div>
        </div>
      </BrandScope>
    </figure>
  );
}

export function LivePreview(props: {
  workspaceId: string;
  name: string;
  branding: WorkspaceBranding;
  accentColor: string;
  colorsPass: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Live preview</h3>
        <p className="mt-1 text-sm text-ink-2">
          {props.colorsPass
            ? "How the workspace looks with these choices, before you save."
            : "Fix the contrast issues to preview these colors. Until then the preview keeps the neutral background."}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        <PreviewCopy theme="light" {...props} />
        <PreviewCopy theme="dark" {...props} />
      </div>
    </div>
  );
}

// The sample workspace email for the draft theme, rendered by the server
// (GET .../branding/preview) as an inert document and shown by URL in a
// fully sandboxed iframe. The address follows the draft after a short
// pause, so typing a color does not reload it on every key.
export function EmailPreview({ workspaceId, query }: { workspaceId: string; query: string }) {
  const [src, setSrc] = useState(() => `/api/workspaces/${encodeURIComponent(workspaceId)}/branding/preview?${query}`);
  useEffect(() => {
    const timer = setTimeout(
      () => setSrc(`/api/workspaces/${encodeURIComponent(workspaceId)}/branding/preview?${query}`),
      500,
    );
    return () => clearTimeout(timer);
  }, [workspaceId, query]);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Email preview</h3>
        <p className="mt-1 text-sm text-ink-2">
          Workspace email with these colors, fonts and corners. Email uses the PNG copy of the logo and web-safe font
          fallbacks, since most mail apps ignore web fonts.
        </p>
      </div>
      <iframe
        title="Preview of a workspace email"
        src={src}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        className="h-[560px] w-full rounded-panel border border-line bg-surface"
      />
    </div>
  );
}
