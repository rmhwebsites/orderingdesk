import { DEFAULT_PRIMARY } from "@/lib/brand-theme";
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import type { WorkspaceBranding } from "@/lib/branding";
import { openTestDb, seedWorkspace } from "@/server/desk/test-helpers";
import {
  BRAND_UPLOAD_MAX_BYTES,
  brandingView,
  removeBrandImage,
  saveBrandTheme,
  serveBrandFile,
  storePngCopy,
  uploadBrandImage,
  type BrandBucket,
} from "./assets";
import { SAMPLE_SVG, pngBytes } from "./test-images";

const WS = "ws_impact";
const encoder = new TextEncoder();

// An in-memory stand-in for the R2 binding.
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  const bucket: BrandBucket = {
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      const meta = options?.httpMetadata as { contentType?: string } | undefined;
      objects.set(key, { bytes, contentType: meta?.contentType });
      return null as never;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) {
        return null;
      }
      return { body: new Blob([object.bytes as BlobPart]).stream(), httpEtag: '"etag"' } as never;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key);
      }
    },
  };
  return { bucket, objects };
}

let db: Db;
let store: ReturnType<typeof fakeBucket>;

beforeEach(async () => {
  db = openTestDb().db;
  store = fakeBucket();
  await seedWorkspace(db, WS);
});

async function branding(): Promise<WorkspaceBranding | null> {
  const [row] = await db.select({ branding: schema.workspaces.branding }).from(schema.workspaces).where(eq(schema.workspaces.id, WS));
  return row.branding ?? null;
}

const svg = (text = SAMPLE_SVG) => encoder.encode(text);

describe("uploadBrandImage", () => {
  it("stores a checked SVG under the workspace prefix and records it", async () => {
    const result = await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: svg(), declaredType: "image/svg+xml" });
    expect(result.kind).toBe("saved");
    const logo = (await branding())?.logo;
    expect(logo?.light.key).toMatch(/^branding\/ws_impact\/logo-light-[0-9a-f]{32}\.svg$/);
    expect(logo?.light.contentType).toBe("image/svg+xml");
    expect(logo?.dark).toBeNull();
    expect(store.objects.get(logo!.light.key)?.contentType).toBe("image/svg+xml");
    if (result.kind === "saved") {
      expect(result.branding.logo?.light.url).toBe(`/api/branding/ws_impact/${logo!.light.key.split("/").pop()}`);
      expect(result.branding.logo?.light.needsPng).toBe(true);
    }
  });

  it("deletes the replaced file and its PNG copy", async () => {
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "symbol-light", bytes: svg(), declaredType: "image/svg+xml" });
    const first = (await branding())!.symbol!.light;
    await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "symbol-light", bytes: pngBytes(256, 256), forFile: first.key.split("/").pop()! });
    const withPng = (await branding())!.symbol!.light;
    expect(withPng.pngKey).toMatch(/^branding\/ws_impact\/symbol-light-[0-9a-f]{32}\.png$/);
    expect(store.objects.size).toBe(2);

    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "symbol-light", bytes: pngBytes(64, 64), declaredType: "image/png" });
    const second = (await branding())!.symbol!.light;
    expect(second.contentType).toBe("image/png");
    expect(second.pngKey).toBeNull();
    expect([...store.objects.keys()]).toEqual([second.key]);
  });

  it("refuses an unsafe SVG with the reason and stores nothing", async () => {
    const result = await uploadBrandImage(db, store.bucket, {
      workspaceId: WS,
      slot: "logo-light",
      bytes: svg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
      declaredType: "image/svg+xml",
    });
    expect(result).toEqual({ kind: "invalid", error: expect.stringMatching(/event handler/) });
    expect(store.objects.size).toBe(0);
    expect(await branding()).toBeNull();
  });

  it("refuses files that are not what they claim, other formats, empty and oversized files", async () => {
    const png = pngBytes(10, 10);
    expect((await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: png, declaredType: "image/svg+xml" })).kind).toBe("invalid");
    expect((await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: encoder.encode("GIF89a..."), declaredType: "image/gif" })).kind).toBe("invalid");
    expect((await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: new Uint8Array(), declaredType: null })).kind).toBe("invalid");
    const big = pngBytes(10, 10, BRAND_UPLOAD_MAX_BYTES);
    expect((await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: big, declaredType: "image/png" })).kind).toBe("too-large");
    expect((await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "favicon" as never, bytes: png, declaredType: null })).kind).toBe("invalid");
    expect(store.objects.size).toBe(0);
  });

  it("refuses an SVG that is not UTF-8 text", async () => {
    const bytes = new Uint8Array([...encoder.encode("<svg>"), 0xff, 0xfe, ...encoder.encode("</svg>")]);
    const result = await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes, declaredType: "image/svg+xml" });
    expect(result).toEqual({ kind: "invalid", error: expect.stringMatching(/UTF-8/) });
  });

  it("needs the light version before a dark one", async () => {
    const early = await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-dark", bytes: pngBytes(10, 10), declaredType: "image/png" });
    expect(early).toEqual({ kind: "invalid", error: expect.stringMatching(/light version first/) });
    expect(store.objects.size).toBe(0);
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: pngBytes(10, 10), declaredType: "image/png" });
    const dark = await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-dark", bytes: pngBytes(10, 10), declaredType: "image/png" });
    expect(dark.kind).toBe("saved");
    expect((await branding())?.logo?.dark?.key).toMatch(/logo-dark-/);
  });

  it("answers not-found for a missing workspace and leaves no file behind", async () => {
    const result = await uploadBrandImage(db, store.bucket, { workspaceId: "ws_missing", slot: "logo-light", bytes: pngBytes(10, 10), declaredType: "image/png" });
    expect(result.kind).toBe("not-found");
    expect(store.objects.size).toBe(0);
  });
});

describe("storePngCopy", () => {
  async function svgLogo() {
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: svg(), declaredType: "image/svg+xml" });
    return (await branding())!.logo!.light.key.split("/").pop()!;
  }

  it("refuses a copy made from an older upload", async () => {
    await svgLogo();
    const result = await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: pngBytes(512, 128), forFile: "logo-light-00000000000000000000000000000000.svg" });
    expect(result.kind).toBe("conflict");
    expect(store.objects.size).toBe(1);
  });

  it("refuses anything but a PNG of a sensible width, and uploads that need no copy", async () => {
    const file = await svgLogo();
    expect((await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: svg(), forFile: file })).kind).toBe("invalid");
    expect((await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: pngBytes(4096, 100), forFile: file })).kind).toBe("invalid");
    expect((await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "symbol-light", bytes: pngBytes(256, 256), forFile: file })).kind).toBe("invalid");
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "symbol-light", bytes: pngBytes(64, 64), declaredType: "image/png" });
    const pngFile = (await branding())!.symbol!.light.key.split("/").pop()!;
    expect((await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "symbol-light", bytes: pngBytes(256, 256), forFile: pngFile })).kind).toBe("invalid");
  });

  it("replaces an earlier copy", async () => {
    const file = await svgLogo();
    await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: pngBytes(512, 128), forFile: file });
    const firstCopy = (await branding())!.logo!.light.pngKey!;
    await storePngCopy(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: pngBytes(512, 128), forFile: file });
    const secondCopy = (await branding())!.logo!.light.pngKey!;
    expect(secondCopy).not.toBe(firstCopy);
    expect(store.objects.has(firstCopy)).toBe(false);
    expect(store.objects.has(secondCopy)).toBe(true);
  });
});

describe("removeBrandImage", () => {
  it("removes a dark version alone, or the whole image with its light version", async () => {
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: pngBytes(10, 10), declaredType: "image/png" });
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-dark", bytes: pngBytes(10, 10), declaredType: "image/png" });
    expect(store.objects.size).toBe(2);
    await removeBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-dark" });
    expect((await branding())?.logo?.dark).toBeNull();
    expect(store.objects.size).toBe(1);
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-dark", bytes: pngBytes(10, 10), declaredType: "image/png" });
    await removeBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light" });
    expect((await branding())?.logo).toBeNull();
    expect(store.objects.size).toBe(0);
  });
});

describe("serveBrandFile", () => {
  it("streams a stored file with immutable caching and locked-down headers", async () => {
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: svg(), declaredType: "image/svg+xml" });
    const file = (await branding())!.logo!.light.key.split("/").pop()!;
    const response = await serveBrandFile(store.bucket, WS, file);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(await response.text()).toBe(SAMPLE_SVG);
  });

  it("answers 404 for names outside the branding pattern, other workspaces and missing files", async () => {
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: svg(), declaredType: "image/svg+xml" });
    const file = (await branding())!.logo!.light.key.split("/").pop()!;
    for (const [workspaceId, name] of [
      ["ws_other", file],
      [WS, "../ws_other/" + file],
      [WS, "logo-light.svg"],
      [WS, file.replace(".svg", ".html")],
      ["..", file],
      [WS, "logo-light-" + "0".repeat(32) + ".svg"],
    ]) {
      expect((await serveBrandFile(store.bucket, workspaceId, name)).status).toBe(404);
    }
  });
});

describe("saveBrandTheme", () => {
  const theme = {
    colors: { primary: "#91D500", ink: "#101820", background: "#FFFFFF" },
    fonts: { heading: "playfair-display", body: "inter" },
    radius: "soft",
  };

  it("stores validated colors, fonts and radius, keeps the images, and syncs the accent", async () => {
    await uploadBrandImage(db, store.bucket, { workspaceId: WS, slot: "logo-light", bytes: pngBytes(10, 10), declaredType: "image/png" });
    const result = await saveBrandTheme(db, WS, theme);
    expect(result.kind).toBe("saved");
    const stored = await branding();
    expect(stored?.colors).toEqual({ primary: "#91d500", ink: "#101820", background: "#ffffff" });
    expect(stored?.fonts).toEqual({ heading: "playfair-display", body: "inter" });
    expect(stored?.radius).toBe("soft");
    expect(stored?.logo?.light.contentType).toBe("image/png");
    const [row] = await db.select({ accent: schema.workspaces.accentColor }).from(schema.workspaces).where(eq(schema.workspaces.id, WS));
    expect(row.accent).toBe("#91d500");
  });

  it("refuses values that are not hex colors, listed fonts or a known radius", async () => {
    for (const body of [
      { colors: { primary: "red", ink: "#101820", background: "#ffffff" } },
      { colors: { primary: "#91d500;", ink: "#101820", background: "#ffffff" } },
      { colors: { primary: "#91d500", ink: "#101820" } },
      { fonts: { heading: "Comic Sans", body: "inter" } },
      { fonts: { heading: "inter" } },
      { radius: "blob" },
      { darkColors: { ink: "url(x)" } },
      {},
      "nope",
    ]) {
      expect((await saveBrandTheme(db, WS, body)).kind, JSON.stringify(body)).toBe("invalid");
    }
    expect(await branding()).toBeNull();
  });

  it("refuses colors that fail contrast, with every issue and its suggestion", async () => {
    const result = await saveBrandTheme(db, WS, { colors: { primary: "#91d500", ink: "#9aa0a6", background: "#ffffff" } });
    expect(result.kind).toBe("contrast");
    if (result.kind === "contrast") {
      expect(result.issues.some((issue) => issue.field === "ink" && issue.suggestion)).toBe(true);
    }
    expect(await branding()).toBeNull();
  });

  // "Use the Ordering Desk colors": no palette, and the buttons go back to
  // the Ordering Desk primary instead of keeping the old brand primary,
  // whose text color was only checked against the brand's own ink.
  it("puts the accent back to the Ordering Desk primary when the colors are cleared", async () => {
    await saveBrandTheme(db, WS, { colors: { primary: "#757575", ink: "#000000", background: "#ffffff" } });
    const accent = async () =>
      (await db.select({ accent: schema.workspaces.accentColor }).from(schema.workspaces).where(eq(schema.workspaces.id, WS)))[0]
        .accent;
    expect(await accent()).toBe("#757575");
    await saveBrandTheme(db, WS, { colors: null });
    expect(await accent()).toBe(DEFAULT_PRIMARY);
    // Saving fonts alone leaves the accent as it is.
    await saveBrandTheme(db, WS, { fonts: { heading: "inter", body: "inter" } });
    expect(await accent()).toBe(DEFAULT_PRIMARY);
  });

  it("clears parts with null and drops dark overrides without light colors", async () => {
    await saveBrandTheme(db, WS, { ...theme, darkColors: { background: "#0b0f14" } });
    expect((await branding())?.darkColors).toEqual({ background: "#0b0f14" });
    await saveBrandTheme(db, WS, { colors: null, radius: null });
    const stored = await branding();
    expect(stored?.colors).toBeNull();
    expect(stored?.darkColors).toBeNull();
    expect(stored?.radius).toBeNull();
    expect(stored?.fonts).toEqual({ heading: "playfair-display", body: "inter" });
  });
});

describe("brandingView", () => {
  it("describes files by URL and says which still need an email copy", () => {
    const view = brandingView(WS, {
      symbol: { light: { key: "branding/ws_impact/symbol-light-ab.webp", contentType: "image/webp", pngKey: null }, dark: null },
    });
    expect(view.symbol?.light).toEqual({
      url: "/api/branding/ws_impact/symbol-light-ab.webp",
      file: "symbol-light-ab.webp",
      contentType: "image/webp",
      needsPng: true,
      hasPng: false,
    });
    expect(view.logo).toBeNull();
    expect(view.colors).toBeNull();
  });
});
