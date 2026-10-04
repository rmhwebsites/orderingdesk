// The Shopify roster (platform amendment section 2): customers of the
// workspace's store tagged with its manager or staff tag (defaults
// "Ordering Desk Manager" and "Ordering Desk Staff", workspaces.roster_tags)
// get that role in the workspace, manager winning when both are present.
// Relative imports on purpose: the cron path bundles this into the custom
// worker entrypoint.
//
// - Granting: the customer's email goes on shopify_roster with the role. A
//   user who already has an account gets a source = shopify membership at
//   once; a new email gets it at first sign-in (claimAccessOnSignIn).
// - Revoking (tag removed, customer deleted, or the email changed away):
//   the roster row goes, and so does any source = shopify membership for
//   that email in that workspace.
// - A source = manual membership is never touched either way (a manager's
//   invite outranks a tag): granting leaves its role, revoking leaves it.
//
// Customer webhooks apply one customer as Shopify has it now
// (applyRosterCustomer, after a re-fetch); the cron run reconciles the
// whole roster (syncRoster) so missed webhooks heal. Emails are lowercased.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { applyBatch, rowsAffected } from "../../db/batch";
import { shopifyRoster, user, workspaceMembers, workspaces, type RosterTags } from "../../db/schema";
import { resolveRosterTags } from "../roster";
import { failureText, fetchTaggedCustomers, type RosterCustomer } from "./admin";
import { getAccessToken } from "./token";

export type RosterRole = "manager" | "staff";

// D1 allows at most 100 bound parameters per statement.
const EMAIL_CHUNK = 50;

const tagKey = (tag: string) => tag.trim().toLowerCase();

export function rosterRoleFor(tags: readonly string[], rosterTags: RosterTags): RosterRole | null {
  const have = new Set(tags.map(tagKey));
  if (have.has(tagKey(rosterTags.manager))) {
    return "manager";
  }
  return have.has(tagKey(rosterTags.staff)) ? "staff" : null;
}

async function workspaceRosterTags(db: Db, workspaceId: string): Promise<RosterTags> {
  const rows = await db
    .select({ rosterTags: workspaces.rosterTags })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return resolveRosterTags(rows[0]?.rosterTags);
}

async function userIdsByEmail(db: Db, emails: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < emails.length; i += EMAIL_CHUNK) {
    const chunk = emails.slice(i, i + EMAIL_CHUNK);
    const rows = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.email, chunk));
    for (const row of rows) {
      found.set(row.email.toLowerCase(), row.id);
    }
  }
  return found;
}

// The roster row for this email with this role and customer, and the
// existing user's shopify membership (a manual one is left as it is). Both
// upserts write nothing when nothing changed.
async function grant(
  db: Db,
  workspaceId: string,
  email: string,
  role: RosterRole,
  customerId: string,
  now: number,
  userId: string | undefined,
): Promise<void> {
  const statements: PromiseLike<unknown>[] = [
    db
      .insert(shopifyRoster)
      .values({ id: crypto.randomUUID(), workspaceId, email, role, shopifyCustomerId: customerId, updatedAt: now })
      .onConflictDoUpdate({
        target: [shopifyRoster.workspaceId, shopifyRoster.email],
        set: { role, shopifyCustomerId: customerId, updatedAt: now },
        setWhere: sql`${shopifyRoster.role} <> ${role} or ${shopifyRoster.shopifyCustomerId} <> ${customerId}`,
      }),
  ];
  if (userId) {
    statements.push(
      db
        .insert(workspaceMembers)
        .values({ id: crypto.randomUUID(), workspaceId, userId, role, source: "shopify" })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role },
          setWhere: sql`${workspaceMembers.source} = 'shopify' and ${workspaceMembers.role} <> ${role}`,
        }),
    );
  }
  await applyBatch(db, statements);
}

// Removes the roster row for this email and the shopify membership of the
// user with this email, in this workspace only. True when a membership
// went (that user's open sockets are then closed by the caller).
async function revoke(db: Db, workspaceId: string, email: string, userId: string | undefined): Promise<boolean> {
  const statements: PromiseLike<unknown>[] = [
    db.delete(shopifyRoster).where(and(eq(shopifyRoster.workspaceId, workspaceId), eq(shopifyRoster.email, email))),
  ];
  if (userId) {
    statements.push(
      db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.source, "shopify"),
          ),
        ),
    );
  }
  const results = await applyBatch(db, statements);
  return userId !== undefined && rowsAffected(results[1], "roster") > 0;
}

// One customer as Shopify has it now (null: the customer no longer exists).
// customerId is the numeric Shopify id the webhook named. Answers the users
// whose shopify membership went.
export async function applyRosterCustomer(
  db: Db,
  workspaceId: string,
  customerId: string,
  customer: RosterCustomer | null,
  now: number,
): Promise<string[]> {
  const rosterTags = await workspaceRosterTags(db, workspaceId);
  const email = customer?.email ?? null;
  const role = customer && email ? rosterRoleFor(customer.tags, rosterTags) : null;

  const held = await db
    .select({ email: shopifyRoster.email })
    .from(shopifyRoster)
    .where(and(eq(shopifyRoster.workspaceId, workspaceId), eq(shopifyRoster.shopifyCustomerId, customerId)));
  const stale = held.map((row) => row.email).filter((heldEmail) => role === null || heldEmail !== email);
  const users = await userIdsByEmail(db, [...stale, ...(email && role ? [email] : [])]);
  const revoked: string[] = [];
  for (const staleEmail of stale) {
    const userId = users.get(staleEmail);
    if (await revoke(db, workspaceId, staleEmail, userId)) {
      revoked.push(userId!);
    }
  }
  if (email && role) {
    await grant(db, workspaceId, email, role, customerId, now, users.get(email));
  }
  return revoked;
}

export type RosterSyncResult =
  // revokedUserIds: users whose shopify membership went.
  | { kind: "ok"; complete: boolean; entries: number; removed: number; revokedUserIds: string[] }
  | { kind: "failed"; detail: string }
  | { kind: "skipped" };

// Reconciles the workspace's roster with every tagged customer in Shopify
// (both tags in one search, paginated; see fetchTaggedCustomers for the
// query cost). Everyone found is granted. Rows for emails no longer found
// are revoked only when every page was read: a partial read may simply not
// have reached them. Works for both connection modes (legacy stores have no
// webhooks, so this is how their roster moves).
export async function syncRoster(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  opts?: { fetchImpl?: typeof fetch; now?: () => number },
): Promise<RosterSyncResult> {
  const now = opts?.now?.() ?? Date.now();
  const token = await getAccessToken(db, env, workspaceId, opts);
  if (token.kind === "unavailable") {
    return { kind: "skipped" };
  }
  if (token.kind !== "ok") {
    return {
      kind: "failed",
      detail: token.kind === "unreadable" ? "store credentials unreadable" : token.detail,
    };
  }
  const rosterTags = await workspaceRosterTags(db, workspaceId);
  const fetched = await fetchTaggedCustomers(
    token.shopDomain,
    token.token,
    [rosterTags.manager, rosterTags.staff],
    opts?.fetchImpl,
  );
  if (fetched.kind !== "ok") {
    return { kind: "failed", detail: failureText(fetched) };
  }

  const desired = new Map<string, { role: RosterRole; customerId: string }>();
  for (const found of fetched.customers) {
    const role = found.email ? rosterRoleFor(found.tags, rosterTags) : null;
    if (!found.email || !role) {
      continue;
    }
    const already = desired.get(found.email);
    if (!already || (already.role === "staff" && role === "manager")) {
      desired.set(found.email, { role, customerId: found.customerId });
    }
  }

  const existing = await db
    .select({ email: shopifyRoster.email })
    .from(shopifyRoster)
    .where(eq(shopifyRoster.workspaceId, workspaceId));
  const stale = fetched.complete ? existing.map((row) => row.email).filter((email) => !desired.has(email)) : [];
  const users = await userIdsByEmail(db, [...desired.keys(), ...stale]);
  for (const [email, entry] of desired) {
    await grant(db, workspaceId, email, entry.role, entry.customerId, now, users.get(email));
  }
  const revokedUserIds: string[] = [];
  for (const email of stale) {
    const userId = users.get(email);
    if (await revoke(db, workspaceId, email, userId)) {
      revokedUserIds.push(userId!);
    }
  }
  return { kind: "ok", complete: fetched.complete, entries: desired.size, removed: stale.length, revokedUserIds };
}
