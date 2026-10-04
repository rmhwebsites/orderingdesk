// The Shopify roster (platform amendment section 2): customers of the
// workspace's store tagged with its manager or staff tag (defaults
// "Ordering Desk Manager" and "Ordering Desk Staff", workspaces.roster_tags)
// REQUEST that role in the workspace, manager winning when both are
// present, and a manager approves each request once (the rules are in
// src/server/roster.ts: storefront forms can set customer tags, so a tag
// alone grants nothing). Relative imports on purpose: the cron path bundles
// this into the custom worker entrypoint.
//
// - Requesting: the customer's email goes on shopify_roster with the role,
//   unapproved. An approved row grants its approved role, claimed by the
//   person at their next sign-in or "/" load (claimAccessOnSignIn), account
//   or not: nothing here ever adds a membership, so neither approving nor a
//   sync shows a manager which emails have an account. Each write here
//   brings an EXISTING shopify membership in line with the row: a lowered
//   tag lowers it at once, a raised tag leaves it until the raise is
//   approved.
// - The same email on another customer means the old customer was deleted
//   (a missed customers/delete): the row starts over, unapproved, and the
//   membership goes.
// - Revoking (tag removed, customer deleted, or the email changed away):
//   the roster row goes, with its approval, and so does any source =
//   shopify membership for that email in that workspace. Tagging again
//   later is a fresh request.
// - A source = manual membership is never touched either way (a manager's
//   invite outranks a tag): granting leaves its role, revoking leaves it.
//
// Customer webhooks apply one customer as Shopify has it now
// (applyRosterCustomer, after a re-fetch); the cron run reconciles the
// whole roster (syncRoster) so missed webhooks heal. Emails are lowercased.
//
// - Disconnecting the store (deleteConnection) takes away every access a
//   tag gave in the workspace (clearShopifyAccess), approvals included:
//   with the store disconnected nothing would ever revoke it again. Both
//   writers check the connection again after writing and take back what
//   they wrote when the store was disconnected meanwhile, so no tag-based
//   access outlives a disconnect. After a reconnect the tags come back at
//   the next roster sync as new requests.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { applyBatch, rowsAffected } from "../../db/batch";
import { shopifyRoster, storeConnections, user, workspaceMembers, workspaces, type RosterTags } from "../../db/schema";
import { alignMembershipWithRoster, resolveRosterTags, revokeUngrantedMembership } from "../roster";
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

// The roster row for this email with this role and customer, then the
// existing user's shopify membership, if they have one, brought in line
// with what the row grants (never added here; a manual one is left as it
// is). A new row waits for approval. On
// an existing row:
// - the same customer with another role: a lowered role lowers the
//   approved role (manager approval covers staff); a raised one keeps it,
//   so the raise waits for its own approval. A denied row stays denied.
// - another customer with the email: the old customer is gone, so the row
//   starts over (no approval, no denial).
// Nothing is written when nothing changed. True when the user's membership
// went (their open sockets are then closed by the caller).
async function grant(
  db: Db,
  workspaceId: string,
  email: string,
  role: RosterRole,
  customerId: string,
  now: number,
  userId: string | undefined,
): Promise<boolean> {
  const sameCustomer = sql`${shopifyRoster.shopifyCustomerId} = ${customerId}`;
  const statements: PromiseLike<unknown>[] = [
    db
      .insert(shopifyRoster)
      .values({ id: crypto.randomUUID(), workspaceId, email, role, shopifyCustomerId: customerId, updatedAt: now })
      .onConflictDoUpdate({
        target: [shopifyRoster.workspaceId, shopifyRoster.email],
        set: {
          role,
          shopifyCustomerId: customerId,
          updatedAt: now,
          approvedRole: sql`case when not (${sameCustomer}) then null when ${role} = 'staff' and ${shopifyRoster.approvedRole} is not null then 'staff' else ${shopifyRoster.approvedRole} end`,
          approvedAt: sql`case when ${sameCustomer} then ${shopifyRoster.approvedAt} end`,
          approvedBy: sql`case when ${sameCustomer} then ${shopifyRoster.approvedBy} end`,
          deniedAt: sql`case when ${sameCustomer} then ${shopifyRoster.deniedAt} end`,
        },
        setWhere: sql`${shopifyRoster.role} <> ${role} or ${shopifyRoster.shopifyCustomerId} <> ${customerId}`,
      }),
  ];
  if (userId) {
    statements.push(
      alignMembershipWithRoster(db, workspaceId, email, userId),
      revokeUngrantedMembership(db, workspaceId, email, userId),
    );
  }
  const results = await applyBatch(db, statements);
  return userId !== undefined && rowsAffected(results[2], "roster") > 0;
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

// Takes away every access a Shopify tag gave in this workspace: its roster
// rows and every source = shopify membership (manual ones stay). Answers
// the users whose membership went, for the caller to close their sockets.
export async function clearShopifyAccess(db: Db, workspaceId: string): Promise<string[]> {
  const results = await applyBatch(db, [
    db.delete(shopifyRoster).where(eq(shopifyRoster.workspaceId, workspaceId)),
    db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.source, "shopify")))
      .returning({ userId: workspaceMembers.userId }),
  ]);
  const removed = Array.isArray(results[1]) ? (results[1] as Array<{ userId: string }>) : [];
  return removed.map((row) => row.userId);
}

async function storeConnected(db: Db, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ status: storeConnections.status })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  return rows[0] !== undefined && rows[0].status !== "disabled";
}

// After a roster write: when the store is no longer connected (it was
// disconnected while this ran), take back every tag-based access, this
// write's included. The disconnect disables the store before it clears,
// so whichever runs last leaves nothing behind.
async function afterRosterWrite(db: Db, workspaceId: string, revoked: string[]): Promise<string[]> {
  if (await storeConnected(db, workspaceId)) {
    return revoked;
  }
  return [...new Set([...revoked, ...(await clearShopifyAccess(db, workspaceId))])];
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
  if (email && role && (await grant(db, workspaceId, email, role, customerId, now, users.get(email)))) {
    revoked.push(users.get(email)!);
  }
  return afterRosterWrite(db, workspaceId, revoked);
}

export type RosterSyncResult =
  // revokedUserIds: users whose shopify membership went.
  | { kind: "ok"; complete: boolean; entries: number; removed: number; revokedUserIds: string[] }
  | { kind: "failed"; detail: string }
  | { kind: "skipped" };

// Reconciles the workspace's roster with every tagged customer in Shopify
// (both tags in one search, paginated; see fetchTaggedCustomers for the
// query cost). Everyone found is recorded as a request (see grant). Rows
// for emails no longer found are revoked only when every page was read: a
// partial read may simply not have reached them. Works for both connection modes (legacy stores have no
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
  const revoked: string[] = [];
  for (const [email, entry] of desired) {
    if (await grant(db, workspaceId, email, entry.role, entry.customerId, now, users.get(email))) {
      revoked.push(users.get(email)!);
    }
  }
  for (const email of stale) {
    const userId = users.get(email);
    if (await revoke(db, workspaceId, email, userId)) {
      revoked.push(userId!);
    }
  }
  const revokedUserIds = await afterRosterWrite(db, workspaceId, revoked);
  return { kind: "ok", complete: fetched.complete, entries: desired.size, removed: stale.length, revokedUserIds };
}
