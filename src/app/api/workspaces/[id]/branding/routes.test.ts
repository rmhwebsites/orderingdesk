import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";
import { SAMPLE_SVG, pngBytes } from "@/server/branding/test-images";

// The branding routes for real against an in-memory database and an
// in-memory bucket, on the hub; session, routed host and env are stood in.
const objects = new Map<string, Uint8Array>();
const bucket = {
  async put(key: string, value: Uint8Array) {
    objects.set(key, value);
    return null;
  },
  async get(key: string) {
    const bytes = objects.get(key);
    return bytes ? { body: new Blob([bytes as BlobPart]).stream(), httpEtag: '"e"' } : null;
  },
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      objects.delete(key);
    }
  },
};
const state: { db: Db | null; session: { user: { id: string; email: string } } | null } = { db: null, session: null };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "boss@example.com", PO_BUCKET: bucket },
    ctx: {},
  }),
}));
vi.mock("@/server/auth", () => ({
  getAuth: async () => ({ api: { getSession: async () => state.session } }),
}));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));

const slotRoute = await import("./[slot]/route");
const pngRoute = await import("./[slot]/png/route");
const themeRoute = await import("./theme/route");
const previewRoute = await import("./preview/route");
const fileRoute = await import("@/app/api/branding/[workspaceId]/[file]/route");

const slotContext = (slot: string) => ({ params: Promise.resolve({ id: "ws_impact", slot }) });
const context = { params: Promise.resolve({ id: "ws_impact" }) };
const upload = (body: BodyInit, type: string, query = "") =>
  new Request(`https://orderingdesk.test/api/workspaces/ws_impact/branding/logo-light${query}`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });

beforeEach(async () => {
  objects.clear();
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  await seedWorkspace(db, "ws_impact");
  await seedUser(db, "u_boss", "boss@example.com");
  await seedUser(db, "u_manager", "manager@example.com");
  await seedMember(db, "ws_impact", "u_manager", "manager");
});

async function stored() {
  const [row] = await state.db!.select().from(schema.workspaces).where(eq(schema.workspaces.id, "ws_impact"));
  return row.branding;
}

describe("branding routes", () => {
  it("answer 401 signed out and 404 to a workspace manager, storing nothing", async () => {
    expect((await slotRoute.POST(upload(SAMPLE_SVG, "image/svg+xml"), slotContext("logo-light"))).status).toBe(401);
    state.session = { user: { id: "u_manager", email: "manager@example.com" } };
    expect((await slotRoute.POST(upload(SAMPLE_SVG, "image/svg+xml"), slotContext("logo-light"))).status).toBe(404);
    expect((await slotRoute.DELETE(new Request("https://x/"), slotContext("logo-light"))).status).toBe(404);
    expect((await pngRoute.POST(upload(pngBytes(512, 64) as BodyInit, "image/png"), slotContext("logo-light"))).status).toBe(404);
    const theme = new Request("https://x/", { method: "PUT", body: JSON.stringify({ radius: "sharp" }) });
    expect((await themeRoute.PUT(theme, context)).status).toBe(404);
    expect((await previewRoute.GET(new Request("https://x/?primary=%23000000"), context)).status).toBe(404);
    expect(objects.size).toBe(0);
    expect(await stored()).toBeNull();
  });

  it("let a platform admin upload, copy, preview and remove a logo", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const saved = await slotRoute.POST(upload(SAMPLE_SVG, "image/svg+xml"), slotContext("logo-light"));
    expect(saved.status).toBe(200);
    const { branding } = (await saved.json()) as { branding: { logo: { light: { file: string; url: string } } } };
    const file = branding.logo.light.file;

    const copy = await pngRoute.POST(upload(pngBytes(512, 128) as BodyInit, "image/png", `/png?for=${file}`), slotContext("logo-light"));
    expect(copy.status).toBe(200);

    const served = await fileRoute.GET(new Request("https://x/"), { params: Promise.resolve({ workspaceId: "ws_impact", file }) });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(SAMPLE_SVG);

    const preview = await previewRoute.GET(new Request("https://x/?primary=%230a7cff&radius=sharp"), context);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox",
    );
    expect(await preview.text()).toContain('bgcolor="#0a7cff"');

    const removed = await slotRoute.DELETE(new Request("https://x/"), slotContext("logo-light"));
    expect(removed.status).toBe(200);
    expect(objects.size).toBe(0);
  });

  it("refuse an oversized upload by its length, an unknown slot, and failing colors", async () => {
    state.session = { user: { id: "u_boss", email: "boss@example.com" } };
    const big = pngBytes(10, 10, 600 * 1024);
    expect((await slotRoute.POST(upload(big as BodyInit, "image/png"), slotContext("logo-light"))).status).toBe(413);
    expect((await slotRoute.POST(upload(SAMPLE_SVG, "image/svg+xml"), slotContext("favicon"))).status).toBe(404);
    const theme = new Request("https://x/", {
      method: "PUT",
      body: JSON.stringify({ colors: { primary: "#91d500", ink: "#cccccc", background: "#ffffff" } }),
    });
    const refused = await themeRoute.PUT(theme, context);
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { issues: Array<{ field: string }> };
    expect(body.issues.some((issue) => issue.field === "ink")).toBe(true);
    expect(objects.size).toBe(0);
  });
});
