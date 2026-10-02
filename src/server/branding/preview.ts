// The email preview in Settings > Branding: the shared email layout
// (renderEmail) rendered with the draft theme the platform admin is
// editing, before it is saved. GET /api/workspaces/[id]/branding/preview
// takes the draft as query parameters and answers this document, which the
// page shows in a sandboxed iframe by URL. Draft values pass the same
// allowlists as saved ones (hex colors, listed fonts, known radius);
// anything else falls back to the stored value.

import { isBrandFontId, isBrandRadius } from "@/lib/brand-theme";
import { brandHex, type WorkspaceBranding } from "@/lib/branding";
import { escapeHtml } from "@/server/email/escape";
import { emailParagraph, renderEmail, type EmailWorkspace } from "@/server/email/layout";

export const EMAIL_PREVIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
} as const;

export function draftBranding(stored: WorkspaceBranding | null | undefined, query: URLSearchParams): WorkspaceBranding {
  const base: WorkspaceBranding = { ...(stored ?? {}) };
  const primary = brandHex(query.get("primary"));
  const ink = brandHex(query.get("ink"));
  const background = brandHex(query.get("background"));
  if (primary || ink || background) {
    const current = base.colors ?? null;
    const colors = {
      primary: primary ?? current?.primary ?? null,
      ink: ink ?? current?.ink ?? null,
      background: background ?? current?.background ?? null,
    };
    if (colors.primary && colors.ink && colors.background) {
      base.colors = { primary: colors.primary, ink: colors.ink, background: colors.background };
    }
  }
  const heading = query.get("heading");
  const body = query.get("body");
  if (isBrandFontId(heading) || isBrandFontId(body)) {
    base.fonts = {
      heading: isBrandFontId(heading) ? heading : (base.fonts?.heading ?? "system"),
      body: isBrandFontId(body) ? body : (base.fonts?.body ?? "system"),
    };
  }
  const radius = query.get("radius");
  if (isBrandRadius(radius)) {
    base.radius = radius;
  }
  return base;
}

export function renderEmailPreview(
  workspace: Required<Pick<EmailWorkspace, "id" | "name">> & Pick<EmailWorkspace, "accentColor" | "branding">,
  query: URLSearchParams,
  hubOrigin: string,
): string {
  const name = escapeHtml(workspace.name);
  const { html } = renderEmail({
    // A lone draft primary (no palette yet) still shows, as the accent.
    workspace: {
      ...workspace,
      accentColor: brandHex(query.get("primary")) ?? workspace.accentColor,
      branding: draftBranding(workspace.branding, query),
    },
    hubOrigin,
    preheader: `A preview of email from ${workspace.name}.`,
    heading: `Sign in to ${workspace.name} orders`,
    bodyHtml:
      emailParagraph("Press the button below to sign in. The link works once and expires in 5 minutes.") +
      emailParagraph(`This is how email from ${name} looks with these colors, fonts and corners.`),
    cta: { label: "Sign in", url: `${hubOrigin}/` },
    footerNote: "Preview only. Nothing was sent.",
  });
  return html;
}
