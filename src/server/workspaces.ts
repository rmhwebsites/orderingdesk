import { asc, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch } from "@/db/batch";
import { statuses, workspaceMembers, workspaces, workspaceSettings } from "@/db/schema";
import { brandImages } from "@/lib/brand-assets";
import type { WorkspaceBranding } from "@/lib/branding";
import type { Role } from "@/lib/roles";
import { isRecord } from "./desk/shapes";
import type { HubWorkspace } from "./hub";

export const WORKSPACE_NAME_MAX = 80;

// Default statuses seeded into every new workspace. Colors are design token
// names resolved by the UI, not hex values. Shipped and Delivered mirror
// Shopify's fulfilled and delivered states (platform amendment section 4).
export const DEFAULT_STATUSES = [
  { key: "new", label: "New", color: "lime", triggersPo: false, shopifyLink: null },
  { key: "processing", label: "Processing", color: "blue", triggersPo: false, shopifyLink: null },
  { key: "on_hold", label: "On Hold", color: "amber", triggersPo: false, shopifyLink: null },
  { key: "approved", label: "Approved", color: "green", triggersPo: true, shopifyLink: null },
  { key: "shipped", label: "Shipped", color: "violet", triggersPo: false, shopifyLink: "fulfilled" },
  { key: "delivered", label: "Delivered", color: "slate", triggersPo: false, shopifyLink: "delivered" },
  { key: "issue", label: "Issue", color: "red", triggersPo: false, shopifyLink: null },
] as const;

// The workspaces a viewer may see, by name. Shared by the hub page and GET
// /api/workspaces so the two cannot drift. A platform admin sees every
// workspace, each with the effective role "platform"; anyone else sees only
// their memberships, with their own role. Each carries its symbol's served
// paths (public already, through /api/branding), never the branding itself.
export async function listWorkspacesForViewer(
  db: Db,
  viewer: { userId: string; platformAdmin: boolean },
): Promise<HubWorkspace[]> {
  const fields = {
    id: workspaces.id,
    name: workspaces.name,
    slug: workspaces.slug,
    accentColor: workspaces.accentColor,
    branding: workspaces.branding,
  };
  type Row = { id: string; name: string; slug: string; accentColor: string; branding: WorkspaceBranding | null };
  const toHub = ({ branding, ...row }: Row, role: Role): HubWorkspace => ({
    ...row,
    symbol: brandImages(row.id, branding).symbol,
    role,
  });
  if (viewer.platformAdmin) {
    const rows = await db.select(fields).from(workspaces).orderBy(asc(workspaces.name), asc(workspaces.id));
    return rows.map((row) => toHub(row, "platform"));
  }
  const rows = await db
    .select({ ...fields, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, viewer.userId))
    .orderBy(asc(workspaces.name), asc(workspaces.id));
  return rows.map(({ role, ...row }) => toHub(row, role));
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

async function nextFreeSlug(db: Db, base: string): Promise<string> {
  let slug = base;
  for (let suffix = 2; ; suffix++) {
    const existing = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, slug))
      .limit(1);
    if (existing.length === 0) {
      return slug;
    }
    slug = `${base}-${suffix}`;
  }
}

// One batch so a failed statement cannot leave a half-created workspace.
async function insertWorkspace(db: Db, opts: { name: string; slug: string; userId: string }) {
  const workspaceId = crypto.randomUUID();
  await applyBatch(db, [
    db.insert(workspaces).values({
      id: workspaceId,
      name: opts.name,
      slug: opts.slug,
      createdBy: opts.userId,
      createdAt: Date.now(),
    }),
    db.insert(workspaceSettings).values({ workspaceId }),
    db.insert(statuses).values(
      DEFAULT_STATUSES.map((status, sort) => ({
        id: crypto.randomUUID(),
        workspaceId,
        sort,
        ...status,
      })),
    ),
  ]);
  return workspaceId;
}

function isSlugConflict(e: unknown): boolean {
  return e instanceof Error && e.message.includes("UNIQUE constraint failed") && e.message.includes("slug");
}

export type CreateWorkspaceResult =
  | { kind: "invalid"; error: string }
  | { kind: "conflict"; error: string }
  | { kind: "created"; workspace: { id: string; name: string; slug: string; role: Role } };

// Creates a workspace with its settings row and the default statuses.
// Platform admins only: the caller (POST /api/workspaces) has already
// checked that. No membership is created: a platform admin reaches every
// workspace as "platform", and the client team arrives by invite or tag.
export async function createWorkspace(
  db: Db,
  createdBy: string,
  body: unknown,
): Promise<CreateWorkspaceResult> {
  const raw = isRecord(body) ? body.name : undefined;
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) {
    return { kind: "invalid", error: "Workspace name is required" };
  }
  if (name.length > WORKSPACE_NAME_MAX) {
    return { kind: "invalid", error: `Workspace name must be ${WORKSPACE_NAME_MAX} characters or fewer` };
  }

  const base = slugify(name);
  let slug = await nextFreeSlug(db, base);
  let workspaceId: string;
  try {
    workspaceId = await insertWorkspace(db, { name, slug, userId: createdBy });
  } catch (e) {
    // A concurrent create can win the slug between the availability check
    // and the insert; recompute once and retry.
    if (!isSlugConflict(e)) {
      throw e;
    }
    slug = await nextFreeSlug(db, base);
    try {
      workspaceId = await insertWorkspace(db, { name, slug, userId: createdBy });
    } catch (retryError) {
      if (isSlugConflict(retryError)) {
        return { kind: "conflict", error: "Slug conflict, try again" };
      }
      throw retryError;
    }
  }
  return { kind: "created", workspace: { id: workspaceId, name, slug, role: "platform" } };
}
