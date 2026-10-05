// The installable app, per host (platform amendment section 1): the web app
// manifest (GET /site.webmanifest) and its icons (GET /app-icon/<file>).
// - The hub (orderingdesk.com) is Ordering Desk: its name and the OD
//   monogram in the Ordering Desk lime on ink.
// - An active client host is its workspace: the workspace name, and the
//   workspace's symbol as the icon when it has a usable PNG of it (the PNG
//   copy made for email, or a PNG upload; square and at least 144px, which
//   browsers need to install), else the first letter of its name drawn in
//   the workspace primary color (src/server/pwa/icon.ts).
// - Anything else has no manifest.
// Both are public (browsers fetch manifests and icons without cookies),
// and say nothing a signed-out visitor of the client host's sign-in page
// cannot already see.

import { DEFAULT_ACCENT } from "@/lib/accent";
import { APP_NAME } from "@/lib/brand";
import { brandTokens, DEFAULT_LIGHT_PALETTE } from "@/lib/brand-theme";
import { brandAssetPath, emailPngKey } from "@/lib/branding";
import type { HostResolution } from "../host";
import { iconText, type IconOptions } from "./icon";

const INK = "#101820";
// Browsers want at least a 144px icon to offer installation.
const MIN_SYMBOL_PX = 144;

export type AppIdentity = {
  name: string;
  shortName: string;
  description: string;
  background: string;
  theme: string;
  letter: { text: string; background: string; foreground: string };
  // The workspace id and R2 key of the symbol's PNG, when there is one.
  workspaceId: string | null;
  symbolKey: string | null;
};

export function appIdentity(host: HostResolution): AppIdentity | null {
  if (host.kind === "hub") {
    return {
      name: APP_NAME,
      shortName: APP_NAME,
      description: "Orders, statuses and notes for every workspace.",
      background: DEFAULT_LIGHT_PALETTE.bg,
      theme: DEFAULT_LIGHT_PALETTE.surface,
      letter: { text: "OD", background: INK, foreground: DEFAULT_ACCENT },
      workspaceId: null,
      symbolKey: null,
    };
  }
  if (host.kind !== "workspace") {
    return null;
  }
  const { workspace } = host;
  const tokens = brandTokens(workspace.branding, workspace.accentColor);
  const palette = tokens.palette?.light ?? DEFAULT_LIGHT_PALETTE;
  const symbol = workspace.branding?.symbol?.light ?? null;
  // Only a PNG: the copy made for email, or the upload itself.
  const pngKey = emailPngKey(symbol);
  const symbolKey = pngKey && (symbol?.pngKey || symbol?.contentType === "image/png") ? pngKey : null;
  const name = workspace.name.trim() || APP_NAME;
  return {
    name: `${name} orders`,
    shortName: name.slice(0, 30),
    description: `Orders, statuses and notes for ${name}.`,
    background: palette.bg,
    theme: palette.surface,
    letter: { text: iconText(name), background: tokens.primary.light.fill, foreground: tokens.primary.light.ink },
    workspaceId: workspace.id,
    symbolKey,
  };
}

// A PNG's pixel size from its IHDR chunk (the first 24 bytes), or null.
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) {
    return null;
  }
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function symbolUsable(size: { width: number; height: number } | null): size is { width: number; height: number } {
  if (!size || Math.min(size.width, size.height) < MIN_SYMBOL_PX) {
    return false;
  }
  return Math.abs(size.width - size.height) <= Math.max(size.width, size.height) * 0.05;
}

// symbol: when the shape counts as the app icon, its file is the icon
// whenever the workspace has a usable symbol.
export const ICON_VARIANTS = {
  "192.png": { size: 192, shape: "rounded", symbol: true },
  "512.png": { size: 512, shape: "rounded", symbol: true },
  "maskable-512.png": { size: 512, shape: "square", symbol: false },
  // The iPhone home screen icon: full bleed, the phone rounds it.
  "apple-180.png": { size: 180, shape: "square", symbol: true },
} as const satisfies Record<string, { size: number; shape: IconOptions["shape"]; symbol: boolean }>;

export type IconVariantName = keyof typeof ICON_VARIANTS;

export function iconVariant(file: string): (typeof ICON_VARIANTS)[IconVariantName] | null {
  return Object.prototype.hasOwnProperty.call(ICON_VARIANTS, file) ? ICON_VARIANTS[file as IconVariantName] : null;
}

// A short hash of what the generated icon shows, so the manifest's icon
// links change when the workspace's name or color does.
function iconVersion(letter: AppIdentity["letter"]): string {
  let hash = 0x811c9dc5;
  for (const char of `${letter.text}|${letter.background}|${letter.foreground}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// symbol: the symbol's size when the route found a usable one.
export function manifestFor(identity: AppIdentity, symbol: { width: number; height: number } | null): Record<string, unknown> {
  const version = iconVersion(identity.letter);
  const icons =
    identity.symbolKey && identity.workspaceId && symbolUsable(symbol)
      ? [
          {
            src: brandAssetPath(identity.workspaceId, identity.symbolKey),
            sizes: `${symbol.width}x${symbol.height}`,
            type: "image/png",
            purpose: "any",
          },
        ]
      : [
          { src: `/app-icon/192.png?v=${version}`, sizes: "192x192", type: "image/png", purpose: "any" },
          { src: `/app-icon/512.png?v=${version}`, sizes: "512x512", type: "image/png", purpose: "any" },
          { src: `/app-icon/maskable-512.png?v=${version}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
        ];
  return {
    id: "/",
    name: identity.name,
    short_name: identity.shortName,
    description: identity.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: identity.background,
    theme_color: identity.theme,
    icons,
  };
}

type SymbolBucket = Pick<R2Bucket, "get">;

// The workspace symbol's PNG when it is usable as the app icon (with its
// bytes when whole is set, else only the size from the first bytes), or
// null. A storage failure reads as no symbol: the letter icon stands in.
export async function loadSymbol(
  bucket: SymbolBucket | undefined,
  identity: AppIdentity,
  whole: boolean,
): Promise<{ width: number; height: number; bytes: Uint8Array | null } | null> {
  if (!bucket || !identity.symbolKey) {
    return null;
  }
  try {
    const object = await bucket.get(identity.symbolKey, whole ? undefined : { range: { offset: 0, length: 33 } });
    if (!object) {
      return null;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const size = pngSize(bytes);
    return symbolUsable(size) ? { ...size, bytes: whole ? bytes : null } : null;
  } catch {
    return null;
  }
}
