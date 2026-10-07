import { cache } from "react";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb, type Db } from "@/db";
import { orders, purchaseOrders, workspaces } from "@/db/schema";
import { roleAtLeast, type Role } from "@/lib/roles";
import { isPlatformAdmin } from "./access";
import { getAuth } from "./auth";
import type { HostResolution } from "./host";
import { requestHost } from "./request-host";
import { workspaceRoleOf } from "./workspace-role";

export { roleAtLeast, type Role };

export class AuthError extends Error {
  readonly status: 401 | 404;

  constructor(status: 401 | 404, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

// Who is asking. platformAdmin is the effective flag: a platform admin
// (bootstrap list or promoted, see src/server/access.ts) on the hub.
// platformAdminOnClientHost: the same person on a client host, where they
// get manager access to that host's workspace and no platform powers. A
// tenant controls their client host's DNS and can proxy it, so whatever a
// platform admin can do there, the tenant could do with a captured
// session; platform-wide actions and platform-only settings therefore
// answer only on the hub.
export type Viewer = { userId: string; email: string; platformAdmin: boolean; platformAdminOnClientHost?: boolean };

const notFound = () => new AuthError(404, "Not found");

// Session guard. 404 on a refused host (unknown, or a client domain that is
// not active; custom-worker.ts already answers those, this covers next dev),
// then 401 without a session. Every other guard builds on it. host is what
// the routed host resolved to (src/server/host.ts).
export async function requireSession() {
  const host = await requestHost();
  const auth = await getAuth(host);
  if (!auth) {
    throw notFound();
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new AuthError(401, "Not signed in");
  }
  const db = getDb();
  const { env } = getCloudflareContext();
  const admin = await isPlatformAdmin(db, env, session.user.id, session.user.email);
  const viewer: Viewer = {
    userId: session.user.id,
    email: session.user.email,
    platformAdmin: admin && host.kind === "hub",
    platformAdminOnClientHost: admin && host.kind === "workspace",
  };
  return { ...viewer, viewer, db, session, env, host };
}

// A client host exposes its own workspace and nothing else, to everyone
// (platform admins included): any other workspace is a 404 there, exactly
// like a missing one. The hub is unscoped.
export function assertHostAllows(host: HostResolution, workspaceId: string): void {
  if (host.kind === "unknown" || (host.kind === "workspace" && host.workspace.id !== workspaceId)) {
    throw notFound();
  }
}

// 404 (never 403) for anyone who is not a platform admin, so platform-only
// routes look exactly like missing ones.
export function assertPlatformAdmin(viewer: Viewer): void {
  if (!viewer.platformAdmin) {
    throw notFound();
  }
}

// Platform-admin-only operations: workspace creation, store connection,
// branding, custom domain, email sender, promoting platform admins. On the
// hub only (404 on a client host, see Viewer).
export async function requirePlatformAdmin() {
  const guarded = await requireSession();
  assertPlatformAdmin(guarded.viewer);
  return guarded;
}

// The caller's effective role in the workspace, or a 404.
// - A platform admin gets "platform" in every workspace that exists (ranked
//   above manager, so every check passes), whether or not they are a member.
// - A platform admin on a client host gets "manager" in the workspace (the
//   host scope, assertHostAllows, keeps it to the host's own), so
//   platform-only checks answer 404 there.
// - Anyone else needs a membership whose role is at least `required`.
// A missing workspace, a non-member and an under-ranked member all get the
// same 404, so nobody can tell "exists but forbidden" from "does not exist".
// Pass knownToExist when the caller has just read the workspace row.
export async function resolveWorkspaceRole(
  db: Db,
  viewer: Viewer,
  workspaceId: string,
  required: Role,
  knownToExist = false,
): Promise<Role> {
  const role = await workspaceRoleOf(db, viewer, workspaceId, knownToExist);
  if (!role || !roleAtLeast(role, required)) {
    throw notFound();
  }
  return role;
}

// Guard for workspace-scoped routes: 401 without a session, the host scope
// (assertHostAllows), then resolveWorkspaceRole.
export async function requireMember(workspaceId: string, required: Role) {
  const guarded = await requireSession();
  assertHostAllows(guarded.host, workspaceId);
  const role = await resolveWorkspaceRole(guarded.db, guarded.viewer, workspaceId, required);
  return { ...guarded, role };
}

// The db-taking core of requireMemberByOrder: resolves the order's
// workspace, then applies the workspace rule above. A missing order and a
// non-member (or under-ranked) caller get the same 404, so order ids reveal
// nothing to outsiders.
export async function resolveOrderAccess(
  db: Db,
  orderId: string,
  viewer: Viewer,
  required: Role,
): Promise<{ role: Role; workspaceId: string }> {
  const rows = await db
    .select({ workspaceId: orders.workspaceId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  const order = rows[0];
  if (!order) {
    throw notFound();
  }
  // The order's foreign key guarantees its workspace exists.
  const role = await resolveWorkspaceRole(db, viewer, order.workspaceId, required, true);
  return { role, workspaceId: order.workspaceId };
}

// Guard for order-scoped routes (/api/orders/[orderId]/...): 401 without a
// session first, then resolveOrderAccess and the host scope.
export async function requireMemberByOrder(orderId: string, required: Role) {
  const guarded = await requireSession();
  const { role, workspaceId } = await resolveOrderAccess(guarded.db, orderId, guarded.viewer, required);
  assertHostAllows(guarded.host, workspaceId);
  return { ...guarded, role, workspaceId };
}

// The db-taking core of requireMemberByPo: like resolveOrderAccess, for a
// purchase order. A missing PO and a non-member (or under-ranked) caller
// get the same 404.
export async function resolvePoAccess(
  db: Db,
  poId: string,
  viewer: Viewer,
  required: Role,
): Promise<{ role: Role; workspaceId: string; orderId: string }> {
  const rows = await db
    .select({ workspaceId: purchaseOrders.workspaceId, orderId: purchaseOrders.orderId })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, poId))
    .limit(1);
  const po = rows[0];
  if (!po) {
    throw notFound();
  }
  // The PO's foreign key guarantees its workspace exists.
  const role = await resolveWorkspaceRole(db, viewer, po.workspaceId, required, true);
  return { role, workspaceId: po.workspaceId, orderId: po.orderId };
}

// Guard for purchase-order-scoped routes (/api/pos/[poId]/...): 401
// without a session first, then resolvePoAccess and the host scope.
export async function requireMemberByPo(poId: string, required: Role) {
  const guarded = await requireSession();
  const access = await resolvePoAccess(guarded.db, poId, guarded.viewer, required);
  assertHostAllows(guarded.host, access.workspaceId);
  return { ...guarded, ...access };
}

// Guard for /w/[slug] server components. EVERY server component under
// /w/[slug] (layout, page, nested segments) must call this itself: layouts
// are NOT an auth boundary, because Next renders layouts and pages
// independently (and pages can be requested without their layout re-running).
// cache() dedupes the session and membership queries across the components
// of one request.
export const requireMemberBySlug = cache(async (slug: string, required: Role) => {
  const guarded = await requireSession();
  const rows = await guarded.db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  const workspace = rows[0];
  if (!workspace) {
    throw notFound();
  }
  assertHostAllows(guarded.host, workspace.id);
  const role = await resolveWorkspaceRole(guarded.db, guarded.viewer, workspace.id, required, true);
  return { ...guarded, workspace, role };
});

export function guardResponse(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  console.error("Unhandled route error", e);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
