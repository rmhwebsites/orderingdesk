// The one branded email layout (platform amendment section 5). Every email
// renders through renderEmail: magic-link sign-in, team invites and the
// sender verification today. Phase 6 notifications and Phase 7 purchase
// orders reuse it too: pass the workspace, a heading, the body as escaped
// HTML (emailParagraph helps), and optionally one button.
//
// Built for Gmail, Outlook and Apple Mail: tables for layout, inline styles
// only (no <style>, <link> or script), at most 600px wide, a light
// background, and a bulletproof table button. A workspace's branding JSON
// (src/lib/branding.ts) supplies the logo (its PNG copy only, through the
// hub's public branding URL; mail clients do not render SVG, so a logo
// without a PNG copy shows the workspace name in the heading font instead),
// the primary color (top rule and button, button text picked by WCAG
// contrast), ink and background colors, font stacks with web-safe
// fallbacks (most mail clients ignore web fonts), and the corner radius.
// A null workspace is hub mail and keeps the Ordering Desk look.
//
// Escaping: every value interpolated here is escaped with escapeHtml,
// colors pass only as #rrggbb, fonts only from the curated list. bodyHtml
// is the one exception: it is HTML the caller has already escaped.
// Subjects are the caller's, through sanitizeSubject.

import { contrastRatio, DEFAULT_ACCENT } from "@/lib/accent";
import { APP_NAME } from "@/lib/brand";
import { fontStack, SYSTEM_FONT_STACK } from "@/lib/brand-fonts";
import { brandAssetPath, brandHex, emailPngKey, type BrandRadius, type WorkspaceBranding } from "@/lib/branding";
import { escapeHtml } from "./escape";

export type EmailWorkspace = {
  id: string;
  name: string;
  accentColor?: string | null;
  branding?: WorkspaceBranding | null;
};

export type RenderEmailOptions = {
  workspace: EmailWorkspace | null;
  // The hub origin (https://orderingdesk.com), where branding files are
  // public. Logos always load from the hub, whatever host the mail is about.
  hubOrigin: string;
  // The inbox preview line, hidden in the message itself.
  preheader: string;
  heading: string;
  // Already-escaped HTML.
  bodyHtml: string;
  cta?: { label: string; url: string };
  footerNote?: string;
};

const INK = "#101820";
const WHITE = "#ffffff";
const CARD = "#ffffff";
const LIGHT_BACKGROUND = "#f3f4f1";
const TEXT_MIN = 4.5;

const HUB_HEADING_STACK = "'Sora', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const HUB_BODY_STACK = "'Red Hat Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const BUTTON_RADIUS: Record<BrandRadius, number> = { sharp: 0, subtle: 4, soft: 8, rounded: 12, pill: 999 };
const CARD_RADIUS: Record<BrandRadius, number> = { sharp: 0, subtle: 4, soft: 8, rounded: 12, pill: 16 };

type Look = {
  name: string;
  logoUrl: string | null;
  primary: string;
  buttonText: string;
  ink: string;
  muted: string;
  line: string;
  background: string;
  headingFont: string;
  bodyFont: string;
  buttonRadius: number;
  cardRadius: number;
  footer: string[];
};

function mix(from: string, to: string, amount: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const channels = [16, 8, 0].map((shift) => {
    const x = (a >> shift) & 255;
    const y = (b >> shift) & 255;
    return Math.round(x + (y - x) * amount);
  });
  return "#" + channels.map((c) => c.toString(16).padStart(2, "0")).join("");
}

// Button text: white or the ink color, whichever contrasts more with the
// button's fill (WCAG 2 contrast ratio).
function textOn(fill: string, ink: string): string {
  return contrastRatio(ink, fill) >= contrastRatio(WHITE, fill) ? ink : WHITE;
}

function lookFor(workspace: EmailWorkspace | null, hubOrigin: string): Look {
  if (!workspace) {
    return {
      name: APP_NAME,
      logoUrl: null,
      primary: DEFAULT_ACCENT,
      buttonText: textOn(DEFAULT_ACCENT, INK),
      ink: INK,
      muted: mix(INK, CARD, 0.35),
      line: mix(INK, CARD, 0.88),
      background: LIGHT_BACKGROUND,
      headingFont: HUB_HEADING_STACK,
      bodyFont: HUB_BODY_STACK,
      buttonRadius: BUTTON_RADIUS.pill,
      cardRadius: CARD_RADIUS.rounded,
      footer: [APP_NAME],
    };
  }
  const branding = workspace.branding ?? null;
  const colors = branding?.colors ?? null;
  const primary = brandHex(colors?.primary) ?? brandHex(workspace.accentColor) ?? DEFAULT_ACCENT;
  // Text sits on the white card: an ink that would not read there falls
  // back to the default ink. The page around the card stays light.
  const brandInk = brandHex(colors?.ink);
  const ink = brandInk && contrastRatio(brandInk, CARD) >= TEXT_MIN ? brandInk : INK;
  const brandBackground = brandHex(colors?.background);
  const background =
    brandBackground && contrastRatio(brandBackground, INK) >= TEXT_MIN ? brandBackground : LIGHT_BACKGROUND;
  const muted = mix(ink, CARD, 0.35);
  const pngKey = emailPngKey(branding?.logo?.light ?? null);
  const radius = branding?.radius ?? null;
  return {
    name: workspace.name,
    logoUrl: pngKey ? `${hubOrigin}${brandAssetPath(workspace.id, pngKey)}` : null,
    primary,
    buttonText: textOn(primary, ink),
    ink,
    muted: contrastRatio(muted, CARD) >= TEXT_MIN ? muted : ink,
    line: mix(ink, CARD, 0.88),
    background,
    headingFont: fontStack(branding?.fonts?.heading) ?? SYSTEM_FONT_STACK,
    bodyFont: fontStack(branding?.fonts?.body) ?? SYSTEM_FONT_STACK,
    buttonRadius: radius ? BUTTON_RADIUS[radius] ?? BUTTON_RADIUS.pill : BUTTON_RADIUS.pill,
    cardRadius: radius ? CARD_RADIUS[radius] ?? CARD_RADIUS.rounded : CARD_RADIUS.rounded,
    footer: [workspace.name, `Sent with ${APP_NAME}`],
  };
}

// One body paragraph with the layout's spacing. html must already be
// escaped.
export function emailParagraph(html: string): string {
  return `<p style="margin:0 0 16px 0;">${html}</p>`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// The plain-text reading of the (simple) body HTML templates write: links
// become "label (url)", block ends become blank lines, tags go, entities
// are decoded.
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => `${label} (${href})`)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function brandHeader(look: Look): string {
  if (look.logoUrl) {
    return `<img src="${escapeHtml(look.logoUrl)}" alt="${escapeHtml(look.name)}" height="40" style="display:block;height:40px;width:auto;max-width:240px;border:0;outline:none;text-decoration:none;">`;
  }
  return `<div style="font-family:${look.headingFont};font-size:20px;line-height:28px;font-weight:700;color:${look.ink};">${escapeHtml(look.name)}</div>`;
}

function button(look: Look, cta: { label: string; url: string }): string {
  const url = escapeHtml(cta.url);
  return [
    `<tr><td style="padding:24px 32px 0 32px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td align="center" bgcolor="${look.primary}" style="border-radius:${look.buttonRadius}px;background-color:${look.primary};">`,
    `<a href="${url}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${look.bodyFont};font-size:16px;line-height:20px;font-weight:700;color:${look.buttonText};text-decoration:none;border-radius:${look.buttonRadius}px;">${escapeHtml(cta.label)}</a>`,
    `</td></tr></table>`,
    `</td></tr>`,
    // Some clients block buttons; the link itself always works.
    `<tr><td style="padding:16px 32px 0 32px;font-family:${look.bodyFont};font-size:13px;line-height:20px;color:${look.muted};word-break:break-all;">`,
    `If the button does not work, copy this link into your browser:<br><a href="${url}" target="_blank" style="color:${look.ink};text-decoration:underline;">${url}</a>`,
    `</td></tr>`,
  ].join("");
}

export function renderEmail(opts: RenderEmailOptions): { html: string; text: string } {
  if (opts.cta && !/^https?:\/\//i.test(opts.cta.url)) {
    throw new Error("renderEmail: the button URL must be an http or https URL");
  }
  const look = lookFor(opts.workspace, opts.hubOrigin);
  const cardTop = `${look.cardRadius}px ${look.cardRadius}px 0 0`;

  const html = [
    "<!doctype html>",
    '<html lang="en" xmlns="http://www.w3.org/1999/xhtml">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="color-scheme" content="light only">',
    '<meta name="supported-color-schemes" content="light only">',
    `<title>${escapeHtml(opts.heading)}</title>`,
    "</head>",
    `<body style="margin:0;padding:0;width:100%;background-color:${look.background};">`,
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${look.background};">${escapeHtml(opts.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${look.background}" style="background-color:${look.background};">`,
    `<tr><td align="center" style="padding:32px 16px;">`,
    `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="max-width:600px;width:100%;background-color:${CARD};border-radius:${look.cardRadius}px;">`,
    `<tr><td height="4" bgcolor="${look.primary}" style="height:4px;line-height:4px;font-size:4px;background-color:${look.primary};border-radius:${cardTop};">&nbsp;</td></tr>`,
    `<tr><td style="padding:28px 32px 0 32px;">${brandHeader(look)}</td></tr>`,
    `<tr><td style="padding:24px 32px 0 32px;"><h1 style="margin:0;font-family:${look.headingFont};font-size:22px;line-height:30px;font-weight:700;color:${look.ink};">${escapeHtml(opts.heading)}</h1></td></tr>`,
    `<tr><td style="padding:12px 32px 0 32px;font-family:${look.bodyFont};font-size:16px;line-height:24px;color:${look.ink};">${opts.bodyHtml}</td></tr>`,
    opts.cta ? button(look, opts.cta) : "",
    opts.footerNote
      ? `<tr><td style="padding:24px 32px 0 32px;font-family:${look.bodyFont};font-size:13px;line-height:20px;color:${look.muted};">${escapeHtml(opts.footerNote)}</td></tr>`
      : "",
    `<tr><td style="padding:28px 32px 28px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td style="border-top:1px solid ${look.line};padding-top:16px;font-family:${look.bodyFont};font-size:13px;line-height:20px;color:${look.muted};">${look.footer.map(escapeHtml).join("<br>")}</td>`,
    `</tr></table></td></tr>`,
    `</table>`,
    `<!--[if mso]></td></tr></table><![endif]-->`,
    `</td></tr></table>`,
    "</body>",
    "</html>",
  ].join("");

  const text = [
    opts.heading,
    htmlToText(opts.bodyHtml),
    opts.cta ? `${opts.cta.label}: ${opts.cta.url}` : "",
    opts.footerNote ?? "",
    `--\n${look.footer.join("\n")}`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");

  return { html, text };
}
