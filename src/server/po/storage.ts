// Where purchase order PDFs live in R2 (the PO_BUCKET binding, shared with
// branding uploads): pos/<workspaceId>/<poId>-<32 random hex>.pdf. They are
// served only by GET /api/pos/[poId]/pdf to members of that workspace; the
// public branding route reads only branding/<workspaceId>/ names
// (src/server/branding/assets.ts serveBrandFile), so it can never serve
// one. Also the logo bytes a PDF shows.

import { emailPngKey, type WorkspaceBranding } from "@/lib/branding";

export type PoBucket = Pick<R2Bucket, "put" | "get" | "delete">;

const LOGO_MAX_BYTES = 1_000_000;

function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function poPdfKey(workspaceId: string, poId: string, random: string = randomHex()): string {
  return `pos/${workspaceId}/${poId}-${random}.pdf`;
}

// Whether key is one of this PO's PDFs (what the PDF route will read).
export function isPoPdfKeyFor(key: string, workspaceId: string, poId: string): boolean {
  const head = `pos/${workspaceId}/${poId}-`;
  return key.startsWith(head) && /^[0-9a-f]{32}\.pdf$/.test(key.slice(head.length));
}

// The workspace logo for a PDF: the light logo's PNG copy, or the upload
// itself when it is a PNG or JPEG (emailPngKey; never an SVG or WebP),
// read from its branding/ key. null when there is none or it cannot be
// read, and the PDF shows the workspace name instead.
export async function loadLogoBytes(
  bucket: Pick<R2Bucket, "get">,
  workspaceId: string,
  branding: WorkspaceBranding | null | undefined,
): Promise<Uint8Array | null> {
  const key = emailPngKey(branding?.logo?.light ?? null);
  if (!key || !key.startsWith(`branding/${workspaceId}/`) || !/\.(png|jpg)$/.test(key)) {
    return null;
  }
  try {
    const object = await bucket.get(key);
    if (!object) {
      return null;
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    return bytes.length > 0 && bytes.length <= LOGO_MAX_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

// Base64 for an Email Service attachment, in chunks (a spread of the whole
// array would overflow the call stack for a large PDF).
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
