import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedWorkspace } from "@/server/desk/test-helpers";

// The manifest and icon routes against an in-memory database, by routed
// host. No session anywhere: browsers fetch both without cookies.
const state: { db: Db | null; host: string; bucket: { get: ReturnType<typeof vi.fn> } } = {
  db: null,
  host: "orderingdesk.test",
  bucket: { get: vi.fn(async () => null) },
};

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: state.host }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { APP_URL: "https://orderingdesk.test", PO_BUCKET: state.bucket }, ctx: {} }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const { GET: MANIFEST } = await import("../site.webmanifest/route");
const { GET: ICON } = await import("./[file]/route");

const icon = (file: string) => ICON(new Request(`https://${state.host}/app-icon/${file}`), { params: Promise.resolve({ file }) });

function squarePng(size: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, size);
  new DataView(bytes.buffer).setUint32(20, size);
  return bytes;
}

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.host = "orderingdesk.test";
  state.bucket.get.mockReset();
  state.bucket.get.mockImplementation(async () => null);
  await seedWorkspace(db, "ws_impact");
  await db
    .update(schema.workspaces)
    .set({ name: "IMPACT Rentals", customDomain: "orders.impactrentals.store", customDomainStatus: "active" })
    .where(eq(schema.workspaces.id, "ws_impact"));
});

describe("GET /site.webmanifest", () => {
  it("is Ordering Desk on the hub", async () => {
    const response = await MANIFEST();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(await response.json()).toMatchObject({ name: "Ordering Desk", display: "standalone", start_url: "/" });
  });

  it("is the workspace on its client host", async () => {
    state.host = "orders.impactrentals.store";
    expect(await (await MANIFEST()).json()).toMatchObject({ name: "IMPACT Rentals orders", short_name: "IMPACT Rentals" });
  });

  it("uses the uploaded symbol when its PNG is usable", async () => {
    await state.db!
      .update(schema.workspaces)
      .set({
        branding: {
          symbol: { light: { key: "branding/ws_impact/symbol-light-1.png", contentType: "image/png", pngKey: null }, dark: null },
        },
      })
      .where(eq(schema.workspaces.id, "ws_impact"));
    state.bucket.get.mockImplementation(async () => ({ arrayBuffer: async () => squarePng(512).buffer }));
    state.host = "orders.impactrentals.store";
    const body = (await (await MANIFEST()).json()) as { icons: unknown };
    expect(body.icons).toEqual([
      { src: "/api/branding/ws_impact/symbol-light-1.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
    expect(state.bucket.get).toHaveBeenCalledWith("branding/ws_impact/symbol-light-1.png", { range: { offset: 0, length: 33 } });
  });

  it("answers 404 on an unknown host", async () => {
    state.host = "stranger.example";
    expect((await MANIFEST()).status).toBe(404);
  });
});

describe("GET /app-icon/[file]", () => {
  it("draws the icon as a PNG of the requested size", async () => {
    const response = await icon("192.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(new DataView(bytes.buffer).getUint32(16)).toBe(192);
  });

  it("serves the workspace symbol on its client host, but never for the maskable shape", async () => {
    await state.db!
      .update(schema.workspaces)
      .set({
        branding: {
          symbol: { light: { key: "branding/ws_impact/symbol-light-1.png", contentType: "image/png", pngKey: null }, dark: null },
        },
      })
      .where(eq(schema.workspaces.id, "ws_impact"));
    const symbol = squarePng(256);
    state.bucket.get.mockImplementation(async () => ({ arrayBuffer: async () => symbol.buffer }));
    state.host = "orders.impactrentals.store";
    expect(new Uint8Array(await (await icon("apple-180.png")).arrayBuffer())).toEqual(symbol);
    const maskable = new Uint8Array(await (await icon("maskable-512.png")).arrayBuffer());
    expect(new DataView(maskable.buffer).getUint32(16)).toBe(512);
  });

  it("answers 404 for any other file or an unknown host", async () => {
    expect((await icon("favicon.ico")).status).toBe(404);
    expect((await icon("..%2F192.png")).status).toBe(404);
    state.host = "stranger.example";
    expect((await icon("192.png")).status).toBe(404);
  });
});
