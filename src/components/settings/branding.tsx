"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { BRAND_FONTS, SYSTEM_FONT_ID } from "@/lib/brand-fonts";
import {
  checkBrandColors,
  contrastReport,
  DEFAULT_LIGHT_PALETTE,
  DEFAULT_PRIMARY,
  deriveDarkPalette,
  RADIUS_SCALE,
  type BrandColorIssue,
  type ContrastCheck,
} from "@/lib/brand-theme";
import { BRAND_RADII, type BrandColors, type BrandRadius, type WorkspaceBranding } from "@/lib/branding";
import {
  draftAfterColorsReset,
  draftColors,
  draftDark,
  draftWorkspaceBranding,
  emailPreviewQuery,
  themeSaveBody,
  type ThemeDraft,
} from "@/lib/branding-draft";
import type { BrandAssetView, BrandingView } from "@/server/branding/assets";
import { ui } from "@/components/ui";
import { Spinner } from "@/components/kit";
import { BrandImages } from "./brand-images";
import { EmailPreview, LivePreview } from "./brand-preview";
import {
  ConfirmStep,
  describedBy,
  Field,
  focusSoon,
  InlineMessage,
  Panel,
  requestJson,
  SaveStatus,
  Select,
  SettingsSection,
} from "./kit";

const FIELD_LABEL: Record<keyof BrandColors, string> = { primary: "Primary", ink: "Text", background: "Background" };
const FIELD_HELP: Record<keyof BrandColors, string> = {
  primary: "Buttons, highlights and the active filter.",
  ink: "Headings and body text.",
  background: "The page behind everything.",
};
const RADIUS_LABEL: Record<BrandRadius, string> = {
  sharp: "Sharp",
  subtle: "Subtle",
  soft: "Soft",
  rounded: "Rounded",
  pill: "Pill",
};

function draftOf(view: BrandingView, accentColor: string): ThemeDraft {
  return {
    colors: view.colors ?? {
      primary: accentColor,
      ink: DEFAULT_LIGHT_PALETTE.ink,
      background: DEFAULT_LIGHT_PALETTE.bg,
    },
    darkColors: { ...(view.darkColors ?? {}) },
    fonts: view.fonts ?? { heading: "sora", body: "red-hat-display" },
    radius: view.radius ?? "pill",
  };
}

// The stored images in the shape the preview renders (R2 keys are not
// exposed to the page; the served file names stand in for them).
function storedImages(view: BrandingView): WorkspaceBranding {
  const asset = (a: BrandAssetView) => ({ key: `branding/x/${a.file}`, contentType: a.contentType, pngKey: null });
  const image = (i: BrandingView["logo"]) => (i ? { light: asset(i.light), dark: i.dark ? asset(i.dark) : null } : null);
  return { logo: image(view.logo), symbol: image(view.symbol) };
}

function ColorField({
  id,
  label,
  help,
  value,
  placeholder,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  // A #rrggbb shown while the field is empty (the derived color).
  placeholder?: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  const error = invalid ? "Use a hex color like #91d500." : null;
  return (
    <Field id={id} label={label} help={help} error={error}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} color picker`}
          value={valid ? value.toLowerCase() : /^#[0-9a-fA-F]{6}$/.test(placeholder ?? "") ? placeholder!.toLowerCase() : "#000000"}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-12 shrink-0 cursor-pointer rounded-control border border-line-strong bg-surface p-1"
        />
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value.trim())}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy(id, { help, error })}
          className={`${ui.input} font-mono uppercase`}
        />
      </div>
    </Field>
  );
}

function ratioText(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

const CHECK_LABEL: Record<ContrastCheck["kind"], string> = {
  text: "Text on every surface",
  status: "Warning and error text",
  button: "Button text on the primary color",
};

// One row per check that decides whether the colors can be saved
// (contrastReport, the same report checkBrandColors blocks on), so a row
// shows failing exactly when saving is blocked for it. Each row shows the
// worst ratio the check found.
function ContrastSummary({ colors, dark }: { colors: BrandColors; dark: Partial<BrandColors> | null }) {
  const report = contrastReport(colors, dark);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(["light", "dark"] as const).map((mode) => (
        <div key={mode} className="min-w-0">
          <h4 className="text-xs font-semibold text-ink-2">{mode === "light" ? "Light mode" : "Dark mode"}</h4>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {report
              .filter((check) => check.mode === mode)
              .map((check) => (
                <li key={check.kind} className="flex items-center gap-2 text-sm text-ink">
                  <span data-tone={check.pass ? "green" : "red"} className="text-tone-text">
                    {check.pass ? <CheckCircleIcon size={16} aria-hidden /> : <WarningIcon size={16} aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">{CHECK_LABEL[check.kind]}</span>
                  <span className="font-mono text-xs tabular-nums text-ink-2">
                    {ratioText(check.ratio)}
                    <span className="sr-only">{check.pass ? ", passes" : ", fails"}</span>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function BrandingSection({
  workspaceId,
  workspaceName,
  initial,
  accentColor,
}: {
  workspaceId: string;
  workspaceName: string;
  initial: BrandingView;
  accentColor: string;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  // The workspace accent: the primary color when no palette is saved (a
  // saved palette sets it to its primary).
  const [accent, setAccent] = useState(accentColor);
  const [saved, setSaved] = useState<ThemeDraft>(() => draftOf(initial, accentColor));
  const [draft, setDraft] = useState<ThemeDraft>(saved);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetRef = useRef<HTMLButtonElement>(null);

  const colors = draftColors(draft.colors);
  const dark = draftDark(draft.darkColors);
  const darkInvalid = (["primary", "ink", "background"] as const).filter(
    (field) => (draft.darkColors[field] ?? "").length > 0 && !/^#[0-9a-fA-F]{6}$/.test(draft.darkColors[field] ?? ""),
  );
  const issues: BrandColorIssue[] = colors ? checkBrandColors(colors, dark) : [];
  // What dark mode works out on its own, shown in the empty override fields.
  const derived = colors ? deriveDarkPalette(colors, null) : null;
  const derivedDark = derived && colors ? { primary: colors.primary, ink: derived.ink, background: derived.bg } : null;
  const body = themeSaveBody(draft, saved);
  const colorsBlocked = !colors || darkInvalid.length > 0 || issues.length > 0;
  const blocked = body !== null && "colors" in body && colorsBlocked;
  const previewBranding = draftWorkspaceBranding(draft, storedImages(view));
  const query = emailPreviewQuery(draft);

  function edit(patch: Partial<ThemeDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setDone(null);
  }

  function setColor(field: keyof BrandColors, value: string) {
    edit({ colors: { ...draft.colors, [field]: value } });
  }

  function setDarkColor(field: keyof BrandColors, value: string) {
    edit({ darkColors: { ...draft.darkColors, [field]: value } });
  }

  function applySuggestion(issue: BrandColorIssue) {
    if (!issue.suggestion) {
      return;
    }
    const darkField = issue.mode === "dark" && dark?.[issue.field];
    if (darkField) {
      setDarkColor(issue.field, issue.suggestion);
    } else {
      setColor(issue.field, issue.suggestion);
    }
    // The suggestion (and its button) goes once applied: focus the color
    // field it changed.
    focusSoon(() => document.getElementById(darkField ? `brand-dark-${issue.field}` : `brand-${issue.field}`));
  }

  async function put(json: Record<string, unknown>, kind: "save" | "reset") {
    setBusy(kind);
    setError(null);
    setDone(null);
    const result = await requestJson<{ branding: BrandingView }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/branding/theme`,
      { method: "PUT", json },
    );
    setBusy(null);
    setConfirmingReset(false);
    if (!result.ok) {
      setError(result.error);
      if (kind === "reset") {
        focusSoon(() => resetRef.current);
      }
      return;
    }
    setView(result.data.branding);
    // Clearing the colors also puts the accent back to the Ordering Desk
    // primary on the server (saveBrandTheme).
    const nextAccent = result.data.branding.colors?.primary ?? (kind === "reset" ? DEFAULT_PRIMARY : accent);
    setAccent(nextAccent);
    const next = draftOf(result.data.branding, nextAccent);
    setSaved(next);
    if (kind === "reset") {
      // Only the colors were reset: font and corner edits not saved yet
      // stay in the form, still waiting for Save.
      setDraft((current) => draftAfterColorsReset(current, next));
      const keptEdits = themeSaveBody(draftAfterColorsReset(draft, next), next) !== null;
      setDone(
        keptEdits
          ? "Back to the Ordering Desk colors. Your font and corner changes are not saved yet."
          : "Back to the Ordering Desk colors.",
      );
      // The reset button is gone: the first color field holds focus.
      focusSoon(() => document.getElementById("brand-primary"));
    } else {
      setDraft(next);
      setDone("Branding saved. The workspace now uses it.");
    }
    // The workspace shell renders the theme on the server.
    router.refresh();
  }

  return (
    <SettingsSection
      id="branding"
      title="Branding"
      description="Make the workspace feel like part of the client's store: their logo, colors, fonts and corners, on every workspace screen, the sign-in page on their own address, and their email."
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,21rem)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel>
            <BrandImages
              workspaceId={workspaceId}
              view={view}
              onChange={(next) => {
                setView(next);
                router.refresh();
              }}
            />
          </Panel>

          <Panel className="flex flex-col gap-4">
            <div>
              <h3 className="font-display text-base font-semibold text-ink">Colors</h3>
              <p className="mt-1 text-sm text-ink-2">
                For light mode; dark mode is worked out from these. Every pair must pass WCAG AA (4.5:1) before it can be
                saved. Status colors stay as they are.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              {(["primary", "ink", "background"] as const).map((field) => (
                <ColorField
                  key={field}
                  id={`brand-${field}`}
                  label={FIELD_LABEL[field]}
                  help={FIELD_HELP[field]}
                  value={draft.colors[field]}
                  invalid={!/^#[0-9a-fA-F]{6}$/.test(draft.colors[field])}
                  onChange={(value) => setColor(field, value)}
                />
              ))}
            </div>
            {colors ? <ContrastSummary colors={colors} dark={dark} /> : null}
            {issues.length > 0 ? (
              <InlineMessage tone="bad">
                <ul className="flex flex-col gap-2">
                  {issues.map((issue) => (
                    <li key={`${issue.mode}-${issue.field}-${issue.message}`} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                      <span className="min-w-0 flex-1">{issue.message}</span>
                      {issue.suggestion ? (
                        <button
                          type="button"
                          onClick={() => applySuggestion(issue)}
                          className={`${ui.buttonSecondary} h-8 gap-2 px-3 text-xs`}
                        >
                          <span
                            aria-hidden
                            className="size-3.5 rounded-control border border-line-strong"
                            style={{ background: issue.suggestion }}
                          />
                          Use {issue.suggestion}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </InlineMessage>
            ) : null}
            <details className="rounded-panel border border-line px-4 py-3" open={Object.keys(saved.darkColors).length > 0}>
              <summary className="cursor-pointer text-sm font-semibold text-ink">Dark mode overrides</summary>
              <p className="mt-2 text-sm text-ink-2">
                Optional. Leave a field empty to keep the color worked out from light mode (shown in the empty field).
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                {(["primary", "ink", "background"] as const).map((field) => (
                  <ColorField
                    key={field}
                    id={`brand-dark-${field}`}
                    label={`Dark ${FIELD_LABEL[field].toLowerCase()}`}
                    value={draft.darkColors[field] ?? ""}
                    placeholder={derivedDark?.[field]}
                    invalid={darkInvalid.includes(field)}
                    onChange={(value) => setDarkColor(field, value)}
                  />
                ))}
              </div>
            </details>
          </Panel>

          <Panel className="flex flex-col gap-4">
            <div>
              <h3 className="font-display text-base font-semibold text-ink">Fonts</h3>
              <p className="mt-1 text-sm text-ink-2">
                Loaded only for this workspace. Order numbers and money keep the monospace font so columns line up.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {(["heading", "body"] as const).map((role) => (
                <Field key={role} id={`brand-font-${role}`} label={role === "heading" ? "Heading font" : "Body font"}>
                  <Select
                    id={`brand-font-${role}`}
                    value={draft.fonts[role]}
                    onChange={(event) => edit({ fonts: { ...draft.fonts, [role]: event.target.value } })}
                  >
                    <option value={SYSTEM_FONT_ID}>System (the device&apos;s own font)</option>
                    <optgroup label="Sans serif">
                      {BRAND_FONTS.filter((font) => font.category === "sans").map((font) => (
                        <option key={font.id} value={font.id}>
                          {font.family}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Serif">
                      {BRAND_FONTS.filter((font) => font.category === "serif").map((font) => (
                        <option key={font.id} value={font.id}>
                          {font.family}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                </Field>
              ))}
            </div>
          </Panel>

          <Panel className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-3">
              <legend className="font-display text-base font-semibold text-ink">Corners</legend>
              <p className="-mt-1 text-sm text-ink-2">One choice for every button, field, card and panel.</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {BRAND_RADII.map((radius) => {
                  const scale = RADIUS_SCALE[radius];
                  const checked = draft.radius === radius;
                  return (
                    <label
                      key={radius}
                      className={`flex cursor-pointer flex-col items-start gap-2 rounded-panel border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                        checked ? "border-primary-strong bg-surface" : "border-line hover:bg-surface-2"
                      }`}
                    >
                      <input
                        type="radio"
                        name="brand-radius"
                        value={radius}
                        checked={checked}
                        onChange={() => edit({ radius })}
                        className="sr-only"
                      />
                      <span aria-hidden className="flex w-full items-end gap-1.5">
                        <span className="h-7 flex-1 border border-line-strong bg-surface-2" style={{ borderRadius: scale.panel }} />
                        <span className="h-4 w-8 bg-primary" style={{ borderRadius: scale.control }} />
                      </span>
                      <span className="text-sm font-medium text-ink">{RADIUS_LABEL[radius]}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </Panel>

          <div className="flex flex-col gap-3">
            {error ? <InlineMessage tone="bad">{error}</InlineMessage> : null}
            {blocked ? (
              <p className="text-sm text-ink-2">Fix the colors above to save. Fonts and corners save with them.</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => body && void put(body, "save")}
                disabled={busy !== null || body === null || blocked}
                aria-busy={busy === "save" || undefined}
                className={ui.buttonPrimary}
              >
                {busy === "save" ? <Spinner /> : null}
                {busy === "save" ? "Saving" : "Save branding"}
              </button>
              {body ? (
                <button type="button" onClick={() => setDraft(saved)} disabled={busy !== null} className={ui.buttonQuiet}>
                  Discard changes
                </button>
              ) : null}
              {view.colors ? (
                <button
                  ref={resetRef}
                  type="button"
                  onClick={() => setConfirmingReset(true)}
                  disabled={busy !== null}
                  className={ui.buttonQuiet}
                >
                  Use the Ordering Desk colors
                </button>
              ) : null}
              <SaveStatus text={done} />
            </div>
            {confirmingReset && view.colors ? (
              <ConfirmStep
                message="Remove the saved colors? Buttons go back to the Ordering Desk lime and the Ordering Desk neutrals return. Fonts, corners and images stay, and so do font and corner changes you have not saved yet."
                confirmLabel="Remove colors"
                busyLabel="Removing"
                busy={busy === "reset"}
                onConfirm={() => void put({ colors: null }, "reset")}
                onCancel={() => setConfirmingReset(false)}
                returnFocus={() => resetRef.current}
              />
            ) : null}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-20 xl:self-start">
          <LivePreview
            workspaceId={workspaceId}
            name={workspaceName}
            branding={previewBranding}
            accentColor={accent}
            colorsPass={colors !== null && issues.length === 0 && darkInvalid.length === 0}
          />
          <EmailPreview workspaceId={workspaceId} query={query} />
        </div>
      </div>
    </SettingsSection>
  );
}
