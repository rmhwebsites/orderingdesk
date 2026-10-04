"use client";

import { useId, useRef, useState } from "react";
import { ImageSquareIcon } from "@phosphor-icons/react/ImageSquare";
import { UploadSimpleIcon } from "@phosphor-icons/react/UploadSimple";
import type { BrandAssetView, BrandingView } from "@/server/branding/assets";
import { ui } from "@/components/ui";
import { ConfirmStep, focusSoon, InlineMessage, requestJson } from "./kit";
import { renderPngCopy } from "./png-copy";

type Slot = "logo-light" | "logo-dark" | "symbol-light" | "symbol-dark";

const MAX_BYTES = 512 * 1024;
const ACCEPT = "image/svg+xml,image/png,image/jpeg,image/webp";

function assetOf(view: BrandingView, slot: Slot): BrandAssetView | null {
  const [image, variant] = slot.split("-") as ["logo" | "symbol", "light" | "dark"];
  return view[image]?.[variant] ?? null;
}

function emailNote(asset: BrandAssetView): string {
  if (!asset.needsPng) {
    return "Email uses this file as is.";
  }
  return asset.hasPng ? "Email copy ready (PNG)." : "No email copy yet: email shows the workspace name. Upload the file again.";
}

function ImageSlot({
  workspaceId,
  slot,
  title,
  hint,
  dark,
  view,
  disabledReason,
  onChange,
}: {
  workspaceId: string;
  slot: Slot;
  title: string;
  hint: string;
  dark: boolean;
  view: BrandingView;
  disabledReason: string | null;
  onChange: (view: BrandingView) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const asset = assetOf(view, slot);
  // Every control names its slot (four slots share the same buttons).
  const what = title.toLowerCase();
  const describedBy = [
    `${inputId}-hint`,
    asset ? `${inputId}-email` : null,
    disabledReason && !asset ? `${inputId}-disabled` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/branding/${slot}`;

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(`Images must be 512 KB or smaller. This one is ${Math.ceil(file.size / 1024)} KB.`);
      return;
    }
    setBusy("Uploading");
    const result = await requestJson<{ branding: BrandingView }>(base, {
      method: "POST",
      body: file,
      contentType: file.type || "application/octet-stream",
    });
    if (!result.ok) {
      setBusy(null);
      setError(result.error);
      return;
    }
    let next = result.data.branding;
    onChange(next);
    const stored = assetOf(next, slot);
    if (stored?.needsPng) {
      setBusy("Making the email copy");
      try {
        const png = await renderPngCopy(file, slot);
        const copy = await requestJson<{ branding: BrandingView }>(`${base}/png?for=${encodeURIComponent(stored.file)}`, {
          method: "POST",
          body: png,
          contentType: "image/png",
        });
        if (copy.ok) {
          next = copy.data.branding;
          onChange(next);
        } else {
          setError(`The image is saved, but its email copy was not: ${copy.error}`);
        }
      } catch (e) {
        setError(`The image is saved, but its email copy was not: ${e instanceof Error ? e.message : "it could not be drawn"}`);
      }
    }
    setBusy(null);
  }

  async function remove() {
    setBusy("Removing");
    setError(null);
    const result = await requestJson<{ branding: BrandingView }>(base, { method: "DELETE" });
    setBusy(null);
    setConfirming(false);
    if (!result.ok) {
      setError(result.error);
      focusSoon(() => removeRef.current);
      return;
    }
    onChange(result.data.branding);
    // The image and its Remove button are gone: the upload control holds
    // focus next.
    focusSoon(() => inputRef.current);
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-panel border border-line p-3.5">
      <div>
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <p id={`${inputId}-hint`} className="text-xs text-ink-2">
          {hint}
        </p>
      </div>
      {/* Light versions sit on a light tile and dark versions on a dark one,
          whatever the app theme, so each shows as it will be used. */}
      <div
        className={`grid h-24 place-items-center rounded-panel border border-line px-3 ${
          dark ? "bg-tile-dark" : "bg-tile-light"
        }`}
      >
        {asset ? (
          <img src={asset.url} alt={`${title} preview`} className="max-h-16 max-w-full object-contain" />
        ) : (
          <ImageSquareIcon size={28} aria-hidden className={dark ? "text-tile-dark-ink" : "text-tile-light-ink"} />
        )}
      </div>
      {asset ? (
        <p id={`${inputId}-email`} className="text-xs text-ink-2">
          {emailNote(asset)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={ACCEPT}
          className="peer sr-only"
          aria-describedby={[describedBy, error ? `${inputId}-error` : null].filter(Boolean).join(" ")}
          disabled={busy !== null || disabledReason !== null}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              void upload(file);
            }
          }}
        />
        <label
          htmlFor={inputId}
          className={`${ui.buttonSecondary} h-9 cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:cursor-not-allowed peer-disabled:opacity-60`}
        >
          <UploadSimpleIcon size={16} aria-hidden />
          {busy ?? (asset ? "Replace" : "Upload")}
          <span className="sr-only"> {what}</span>
        </label>
        {asset && busy === null ? (
          <button
            ref={removeRef}
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Remove ${what}`}
            className={`${ui.buttonQuiet} h-9`}
          >
            Remove
          </button>
        ) : null}
      </div>
      {disabledReason && !asset ? (
        <p id={`${inputId}-disabled`} className="text-xs text-ink-2">
          {disabledReason}
        </p>
      ) : null}
      {confirming ? (
        <ConfirmStep
          message={slot.endsWith("light") ? `Remove the ${what}? Its dark mode version goes too.` : `Remove the ${what}?`}
          confirmLabel="Remove"
          busyLabel="Removing"
          busy={busy === "Removing"}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
          returnFocus={() => removeRef.current}
        />
      ) : null}
      {error ? (
        <div id={`${inputId}-error`}>
          <InlineMessage tone="bad">{error}</InlineMessage>
        </div>
      ) : null}
    </div>
  );
}

export function BrandImages({
  workspaceId,
  view,
  onChange,
}: {
  workspaceId: string;
  view: BrandingView;
  onChange: (view: BrandingView) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-display text-base font-semibold text-ink">Logo and symbol</h3>
        <p className="mt-1 text-sm text-ink-2">
          SVG, PNG, JPEG or WebP, up to 512 KB. The symbol is also the browser tab icon. An SVG gets a PNG copy for email.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <ImageSlot
          workspaceId={workspaceId}
          slot="logo-light"
          title="Logo"
          hint="The full horizontal logo, for light backgrounds."
          dark={false}
          view={view}
          disabledReason={null}
          onChange={onChange}
        />
        <ImageSlot
          workspaceId={workspaceId}
          slot="logo-dark"
          title="Logo for dark mode"
          hint="Optional. Shown on dark backgrounds."
          dark
          view={view}
          disabledReason={view.logo ? null : "Upload the logo first."}
          onChange={onChange}
        />
        <ImageSlot
          workspaceId={workspaceId}
          slot="symbol-light"
          title="Symbol"
          hint="A square mark, for small spaces and the tab icon."
          dark={false}
          view={view}
          disabledReason={null}
          onChange={onChange}
        />
        <ImageSlot
          workspaceId={workspaceId}
          slot="symbol-dark"
          title="Symbol for dark mode"
          hint="Optional. Shown on dark backgrounds."
          dark
          view={view}
          disabledReason={view.symbol ? null : "Upload the symbol first."}
          onChange={onChange}
        />
      </div>
    </div>
  );
}
