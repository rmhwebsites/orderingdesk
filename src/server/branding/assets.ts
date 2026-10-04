// Workspace branding (platform amendment section 6): uploaded images in R2
// and the theme values in workspaces.branding. Platform admins only; the
// routes check that. Everything here is validated server side because these
// values reach CSS, the page and email markup.
//
// Images: four slots (symbol-light, symbol-dark, logo-light, logo-dark).
// An upload is identified by its magic numbers (src/server/branding/
// images.ts), must be SVG, PNG, JPEG or WebP, at most 512 KB, and an SVG
// must pass the safety check. It is stored in R2 (the PO_BUCKET binding) at
// branding/<workspaceId>/<slot>-<32 random hex>.<ext>, and the file it
// replaces is deleted. SVG and WebP uploads get a PNG copy for email,
// rendered by the browser and stored through storePngCopy. Files are served
// publicly by serveBrandFile (mail clients cannot send a session).
//
// workspaces.branding is read, changed and written back only if it is still
// exactly what was read (compare and set, retried), so two saves in flight
// never undo each other.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { workspaces } from "@/db/schema";
import { checkBrandColors, DEFAULT_PRIMARY, isBrandFontId, isBrandRadius, type BrandColorIssue } from "@/lib/brand-theme";
import {
  brandAssetPath,
  brandHex,
  type BrandAsset,
  type BrandColors,
  type BrandImage,
  type BrandRadius,
  type WorkspaceBranding,
} from "@/lib/branding";
import { isRecord } from "@/server/desk/shapes";
import { pngWidth, sniffImage, unsafeSvgReason } from "./images";

export const BRAND_SLOTS = ["symbol-light", "symbol-dark", "logo-light", "logo-dark"] as const;
export type BrandSlot = (typeof BRAND_SLOTS)[number];

export const BRAND_UPLOAD_MAX_BYTES = 512 * 1024;
// The browser renders email copies at 2x: 512px wide for logos, 256px for
// symbols. Anything up to this width is accepted.
export const PNG_COPY_MAX_WIDTH = 1024;

export type BrandBucket = Pick<R2Bucket, "put" | "get" | "delete">;

export function isBrandSlot(value: unknown): value is BrandSlot {
  return typeof value === "string" && (BRAND_SLOTS as readonly string[]).includes(value);
}

function slotParts(slot: BrandSlot): { image: "logo" | "symbol"; variant: "light" | "dark" } {
  const [image, variant] = slot.split("-") as ["logo" | "symbol", "light" | "dark"];
  return { image, variant };
}

const fileOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);

function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type BrandAssetView = {
  url: string;
  file: string;
  contentType: BrandAsset["contentType"];
  // SVG and WebP need a PNG copy for email.
  needsPng: boolean;
  hasPng: boolean;
};

export type BrandingView = {
  logo: { light: BrandAssetView; dark: BrandAssetView | null } | null;
  symbol: { light: BrandAssetView; dark: BrandAssetView | null } | null;
  colors: BrandColors | null;
  darkColors: Partial<BrandColors> | null;
  fonts: { heading: string; body: string } | null;
  radius: BrandRadius | null;
};

function assetView(workspaceId: string, asset: BrandAsset): BrandAssetView {
  return {
    url: brandAssetPath(workspaceId, asset.key),
    file: fileOf(asset.key),
    contentType: asset.contentType,
    needsPng: asset.contentType === "image/svg+xml" || asset.contentType === "image/webp",
    hasPng: asset.pngKey !== null,
  };
}

function imageView(workspaceId: string, image: BrandImage | null | undefined) {
  return image ? { light: assetView(workspaceId, image.light), dark: image.dark ? assetView(workspaceId, image.dark) : null } : null;
}

// What the settings page shows: file URLs instead of R2 keys.
export function brandingView(workspaceId: string, branding: WorkspaceBranding | null | undefined): BrandingView {
  return {
    logo: imageView(workspaceId, branding?.logo),
    symbol: imageView(workspaceId, branding?.symbol),
    colors: branding?.colors ?? null,
    darkColors: branding?.darkColors ?? null,
    fonts: branding?.fonts ?? null,
    radius: branding?.radius ?? null,
  };
}

type Change =
  | { error: string }
  | { branding: WorkspaceBranding; removedKeys?: string[]; accentColor?: string };

type UpdateResult =
  | { kind: "not-found" }
  | { kind: "invalid"; error: string }
  | { kind: "conflict" }
  | { kind: "saved"; branding: WorkspaceBranding; removedKeys: string[] };

// Compare and set on the stored JSON text, retried a few times.
async function updateBranding(db: Db, workspaceId: string, change: (current: WorkspaceBranding) => Change): Promise<UpdateResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await db
      .select({ raw: sql<string | null>`${workspaces.branding}` })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (rows.length === 0) {
      return { kind: "not-found" };
    }
    const raw = rows[0].raw;
    let current: WorkspaceBranding = {};
    try {
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      current = isRecord(parsed) ? (parsed as WorkspaceBranding) : {};
    } catch {
      current = {};
    }
    const next = change(current);
    if ("error" in next) {
      return { kind: "invalid", error: next.error };
    }
    const updated = await db
      .update(workspaces)
      .set({ branding: next.branding, ...(next.accentColor ? { accentColor: next.accentColor } : {}) })
      .where(and(eq(workspaces.id, workspaceId), raw === null ? isNull(workspaces.branding) : sql`${workspaces.branding} = ${raw}`))
      .returning({ id: workspaces.id });
    if (updated.length > 0) {
      return { kind: "saved", branding: next.branding, removedKeys: next.removedKeys ?? [] };
    }
  }
  return { kind: "conflict" };
}

async function deleteQuietly(bucket: BrandBucket, keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  try {
    await bucket.delete(keys);
  } catch (e) {
    // A leftover file is harmless (nothing references it); never fail the
    // save over it.
    console.warn("[branding] " + JSON.stringify({ deleteFailed: keys.length, error: e instanceof Error ? e.name : "failed" }));
  }
}

const keysOf = (asset: BrandAsset | null | undefined) => (asset ? [asset.key, ...(asset.pngKey ? [asset.pngKey] : [])] : []);

export type BrandingResult =
  | { kind: "invalid"; error: string }
  | { kind: "too-large"; error: string }
  | { kind: "conflict"; error: string }
  | { kind: "not-found" }
  | { kind: "saved"; branding: BrandingView };

const CONFLICT = "Branding was changed by someone else at the same moment. Reload the page and try again.";

function finish(workspaceId: string, result: UpdateResult): BrandingResult {
  switch (result.kind) {
    case "not-found":
      return { kind: "not-found" };
    case "invalid":
      return { kind: "invalid", error: result.error };
    case "conflict":
      return { kind: "conflict", error: CONFLICT };
    case "saved":
      return { kind: "saved", branding: brandingView(workspaceId, result.branding) };
  }
}

function sizeText(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

// The declared type, without parameters, when it says anything; the sniffed
// type always decides.
function declaredMismatch(declared: string | null | undefined, actual: string): boolean {
  const type = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (type === "" || type === "application/octet-stream") {
    return false;
  }
  return (type === "image/jpg" ? "image/jpeg" : type) !== actual;
}

export async function uploadBrandImage(
  db: Db,
  bucket: BrandBucket,
  input: { workspaceId: string; slot: BrandSlot; bytes: Uint8Array; declaredType: string | null },
): Promise<BrandingResult> {
  if (!isBrandSlot(input.slot)) {
    return { kind: "invalid", error: "Unknown image slot" };
  }
  const { bytes } = input;
  if (bytes.length === 0) {
    return { kind: "invalid", error: "The file is empty." };
  }
  if (bytes.length > BRAND_UPLOAD_MAX_BYTES) {
    return { kind: "too-large", error: `Images must be 512 KB or smaller. This one is ${sizeText(bytes.length)}.` };
  }
  const kind = sniffImage(bytes);
  if (!kind) {
    return { kind: "invalid", error: "Upload an SVG, PNG, JPEG or WebP image." };
  }
  if (declaredMismatch(input.declaredType, kind.type)) {
    return { kind: "invalid", error: "This file is not the image type its name says. Export it again as SVG, PNG, JPEG or WebP." };
  }
  if (kind.type === "image/svg+xml") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { kind: "invalid", error: "SVG files must be UTF-8 text." };
    }
    const reason = unsafeSvgReason(text);
    if (reason) {
      return { kind: "invalid", error: `This SVG cannot be used: ${reason}.` };
    }
  }

  const { image, variant } = slotParts(input.slot);
  const key = `branding/${input.workspaceId}/${input.slot}-${randomHex()}.${kind.ext}`;
  const asset: BrandAsset = { key, contentType: kind.type, pngKey: null };
  const lightFirst = { error: "Upload the light version first, then its dark mode version." };

  // Refuse early, before storing anything, when the light version is missing.
  const precheck = await readBranding(db, input.workspaceId);
  if (precheck === null) {
    return { kind: "not-found" };
  }
  if (variant === "dark" && !precheck[image]?.light) {
    return { kind: "invalid", error: lightFirst.error };
  }

  await bucket.put(key, bytes, { httpMetadata: { contentType: kind.type } });
  const result = await updateBranding(db, input.workspaceId, (current) => {
    const existing = current[image] ?? null;
    if (variant === "dark") {
      if (!existing?.light) {
        return lightFirst;
      }
      return { branding: { ...current, [image]: { ...existing, dark: asset } }, removedKeys: keysOf(existing.dark) };
    }
    return {
      branding: { ...current, [image]: { light: asset, dark: existing?.dark ?? null } },
      removedKeys: keysOf(existing?.light),
    };
  });
  if (result.kind !== "saved") {
    await deleteQuietly(bucket, [key]);
  } else {
    await deleteQuietly(bucket, result.removedKeys);
  }
  return finish(input.workspaceId, result);
}

// The stored branding, or null when the workspace does not exist.
async function readBranding(db: Db, workspaceId: string): Promise<WorkspaceBranding | null> {
  const rows = await db.select({ branding: workspaces.branding }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return rows.length === 0 ? null : (rows[0].branding ?? {});
}

// Stores the browser-rendered PNG copy of an SVG or WebP upload, for email.
// forFile names the upload the copy was made from: a copy of an image that
// has since been replaced is refused.
export async function storePngCopy(
  db: Db,
  bucket: BrandBucket,
  input: { workspaceId: string; slot: BrandSlot; bytes: Uint8Array; forFile: string },
): Promise<BrandingResult> {
  if (!isBrandSlot(input.slot)) {
    return { kind: "invalid", error: "Unknown image slot" };
  }
  const { image, variant } = slotParts(input.slot);
  const current = await readBranding(db, input.workspaceId);
  if (current === null) {
    return { kind: "not-found" };
  }
  const asset = current[image]?.[variant] ?? null;
  if (!asset) {
    return { kind: "invalid", error: "Upload the image first." };
  }
  if (asset.contentType !== "image/svg+xml" && asset.contentType !== "image/webp") {
    return { kind: "invalid", error: "Only SVG and WebP uploads need an email copy." };
  }
  if (fileOf(asset.key) !== input.forFile) {
    return { kind: "conflict", error: "The image changed while its email copy was being made. Upload it again." };
  }
  if (input.bytes.length > BRAND_UPLOAD_MAX_BYTES) {
    return { kind: "too-large", error: `The email copy must be 512 KB or smaller. This one is ${sizeText(input.bytes.length)}.` };
  }
  const width = pngWidth(input.bytes);
  if (width === null || width < 16 || width > PNG_COPY_MAX_WIDTH) {
    return { kind: "invalid", error: "The email copy must be a PNG between 16 and 1024 pixels wide." };
  }
  const key = `branding/${input.workspaceId}/${input.slot}-${randomHex()}.png`;
  await bucket.put(key, input.bytes, { httpMetadata: { contentType: "image/png" } });
  const result = await updateBranding(db, input.workspaceId, (latest) => {
    const now = latest[image]?.[variant] ?? null;
    if (!now || now.key !== asset.key) {
      return { error: "The image changed while its email copy was being made. Upload it again." };
    }
    const updated: BrandAsset = { ...now, pngKey: key };
    const imageNow = latest[image]!;
    return {
      branding: { ...latest, [image]: { ...imageNow, [variant]: updated } },
      removedKeys: now.pngKey ? [now.pngKey] : [],
    };
  });
  if (result.kind !== "saved") {
    await deleteQuietly(bucket, [key]);
  } else {
    await deleteQuietly(bucket, result.removedKeys);
  }
  return finish(input.workspaceId, result);
}

// Removes a dark version alone, or the whole image (light and dark) when
// the light version is removed. Removing what is not there is a no-op.
export async function removeBrandImage(
  db: Db,
  bucket: BrandBucket,
  input: { workspaceId: string; slot: BrandSlot },
): Promise<BrandingResult> {
  if (!isBrandSlot(input.slot)) {
    return { kind: "invalid", error: "Unknown image slot" };
  }
  const { image, variant } = slotParts(input.slot);
  const result = await updateBranding(db, input.workspaceId, (current) => {
    const existing = current[image] ?? null;
    if (!existing) {
      return { branding: current };
    }
    if (variant === "dark") {
      return { branding: { ...current, [image]: { ...existing, dark: null } }, removedKeys: keysOf(existing.dark) };
    }
    return { branding: { ...current, [image]: null }, removedKeys: [...keysOf(existing.light), ...keysOf(existing.dark)] };
  });
  if (result.kind === "saved") {
    await deleteQuietly(bucket, result.removedKeys);
  }
  return finish(input.workspaceId, result);
}

export type ThemeResult =
  | BrandingResult
  // Colors that fail WCAG AA (400 with every issue and its suggestion).
  | { kind: "contrast"; error: string; issues: BrandColorIssue[] };

const HEX = /^#[0-9a-fA-F]{6}$/;

function parseColors(value: unknown, partial: boolean): Partial<BrandColors> | string {
  if (!isRecord(value)) {
    return "Colors must be an object of #rrggbb values";
  }
  const out: Partial<BrandColors> = {};
  for (const field of ["primary", "ink", "background"] as const) {
    const raw = value[field];
    if (raw === undefined || raw === null || raw === "") {
      if (!partial) {
        return `The ${field === "ink" ? "text" : field} color is required`;
      }
      continue;
    }
    if (typeof raw !== "string" || !HEX.test(raw)) {
      return `The ${field === "ink" ? "text" : field} color must be a hex color like #91d500`;
    }
    out[field] = raw.toLowerCase();
  }
  return out;
}

// Body: any of {colors: {primary, ink, background} | null, darkColors:
// {primary?, ink?, background?} | null, fonts: {heading, body} | null,
// radius: sharp | subtle | soft | rounded | pill | null}. A key that is
// present replaces that part (null clears it); a missing key keeps it.
// Colors that fail contrast are refused with every issue. Saving colors
// also sets the workspace accent to the primary color, so the hub list and
// older readers agree.
export async function saveBrandTheme(db: Db, workspaceId: string, body: unknown): Promise<ThemeResult> {
  if (!isRecord(body)) {
    return { kind: "invalid", error: "Send the theme as a JSON object" };
  }
  const patch: Partial<Pick<WorkspaceBranding, "colors" | "darkColors" | "fonts" | "radius">> = {};
  if (body.colors !== undefined) {
    if (body.colors === null) {
      patch.colors = null;
    } else {
      const colors = parseColors(body.colors, false);
      if (typeof colors === "string") {
        return { kind: "invalid", error: colors };
      }
      patch.colors = colors as BrandColors;
    }
  }
  if (body.darkColors !== undefined) {
    if (body.darkColors === null) {
      patch.darkColors = null;
    } else {
      const dark = parseColors(body.darkColors, true);
      if (typeof dark === "string") {
        return { kind: "invalid", error: `Dark mode: ${dark}` };
      }
      patch.darkColors = Object.keys(dark).length > 0 ? dark : null;
    }
  }
  if (body.fonts !== undefined) {
    if (body.fonts === null) {
      patch.fonts = null;
    } else if (!isRecord(body.fonts) || !isBrandFontId(body.fonts.heading) || !isBrandFontId(body.fonts.body)) {
      return { kind: "invalid", error: "Choose the heading and body fonts from the list" };
    } else {
      patch.fonts = { heading: body.fonts.heading, body: body.fonts.body };
    }
  }
  if (body.radius !== undefined) {
    if (body.radius !== null && !isBrandRadius(body.radius)) {
      return { kind: "invalid", error: "Corner radius must be sharp, subtle, soft, rounded or pill" };
    }
    patch.radius = body.radius;
  }
  if (Object.keys(patch).length === 0) {
    return { kind: "invalid", error: "Nothing to update: send colors, darkColors, fonts or radius" };
  }

  let contrast: BrandColorIssue[] = [];
  const result = await updateBranding(db, workspaceId, (current) => {
    const next: WorkspaceBranding = { ...current, ...patch };
    const colors = next.colors ?? null;
    // Dark overrides only make sense on top of light colors.
    if (!colors) {
      next.darkColors = null;
    } else {
      const valid = { primary: brandHex(colors.primary), ink: brandHex(colors.ink), background: brandHex(colors.background) };
      if (!valid.primary || !valid.ink || !valid.background) {
        return { error: "The stored colors are not valid; set all three colors again." };
      }
      contrast = checkBrandColors(valid as BrandColors, next.darkColors ?? null);
      if (contrast.length > 0) {
        return { error: contrast[0].message };
      }
    }
    // The accent follows the palette: its primary when one is saved, and
    // the Ordering Desk primary when the colors are cleared ("Use the
    // Ordering Desk colors"), so buttons never keep a brand primary whose
    // text color was only checked against the brand's own ink.
    const accentColor = patch.colors ? patch.colors.primary : patch.colors === null ? DEFAULT_PRIMARY : null;
    return { branding: next, ...(accentColor ? { accentColor } : {}) };
  });
  if (result.kind === "invalid" && contrast.length > 0) {
    return { kind: "contrast", error: result.error, issues: contrast };
  }
  return finish(workspaceId, result);
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const BRAND_FILE = /^(symbol|logo)-(light|dark)-[0-9a-f]{32}\.(svg|png|jpg|webp)$/;
const FILE_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

// GET /api/branding/<workspaceId>/<file>: public (mail clients and the
// signed-out sign-in page load these). Only names in the branding pattern,
// only under that workspace's prefix. Served immutable (every upload gets a
// new random name), never sniffed, never as a document that can run
// anything: an SVG opened directly is sandboxed with no script or network.
export async function serveBrandFile(bucket: Pick<R2Bucket, "get">, workspaceId: string, file: string): Promise<Response> {
  const match = WORKSPACE_ID.test(workspaceId) ? file.match(BRAND_FILE) : null;
  if (!match) {
    return notFound();
  }
  const object = await bucket.get(`branding/${workspaceId}/${file}`);
  if (!object) {
    return notFound();
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": FILE_TYPES[match[3]],
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      ...(object.httpEtag ? { etag: object.httpEtag } : {}),
    },
  });
}
