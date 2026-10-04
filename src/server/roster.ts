// Tagged Shopify customers as workspace members (platform amendment
// section 2). The Shopify stage fills shopify_roster from customer webhooks
// and the periodic sync, and adds or removes source = shopify memberships as
// tags change (src/server/shopify/roster-sync.ts). This module holds the
// shared rules: the tag names and turning roster entries into memberships
// when the person signs in.

// Relative imports on purpose: the cron roster sync
// (src/server/shopify/roster-sync.ts) bundles this into the custom worker.

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { applyBatch } from "../db/batch";
import { shopifyRoster, workspaceMembers, workspaces, type RosterTags } from "../db/schema";
import { isRecord } from "./desk/shapes";

export const DEFAULT_ROSTER_TAGS: RosterTags = {
  manager: "Ordering Desk Manager",
  staff: "Ordering Desk Staff",
};

// The workspace's tag names: workspaces.roster_tags when set, each missing
// or blank tag falling back to its default.
export function resolveRosterTags(stored: unknown): RosterTags {
  const tags = isRecord(stored) ? stored : {};
  const pick = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  return {
    manager: pick(tags.manager, DEFAULT_ROSTER_TAGS.manager),
    staff: pick(tags.staff, DEFAULT_ROSTER_TAGS.staff),
  };
}

export const ROSTER_TAG_MAX = 40;

export type SetRosterTagsResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "saved"; tags: RosterTags };

// Platform admins (the route checks). Body {manager, staff}: the Shopify
// customer tags that grant each role here, or null for the defaults. Each
// is 1 to ROSTER_TAG_MAX characters with no comma (Shopify separates tags
// with commas), and the two must differ. The cron roster sync applies a
// change at its next run (grants the new tags, revokes the old ones).
export async function setRosterTags(db: Db, workspaceId: string, body: unknown): Promise<SetRosterTagsResult> {
  let next: RosterTags | null = null;
  if (body !== null) {
    if (!isRecord(body)) {
      return { kind: "invalid", error: "Send the manager and staff tags, or null for the defaults" };
    }
    const tags: Partial<RosterTags> = {};
    for (const role of ["manager", "staff"] as const) {
      const raw = body[role];
      const value = typeof raw === "string" ? raw.trim() : "";
      const label = role === "manager" ? "The manager tag" : "The staff tag";
      if (value.length === 0 || value.length > ROSTER_TAG_MAX) {
        return { kind: "invalid", error: `${label} must be 1 to ${ROSTER_TAG_MAX} characters` };
      }
      if (value.includes(",")) {
        return { kind: "invalid", error: `${label} cannot contain a comma: Shopify would read it as two tags` };
      }
      tags[role] = value;
    }
    if (tags.manager!.toLowerCase() === tags.staff!.toLowerCase()) {
      return { kind: "invalid", error: "The manager and staff tags must be different" };
    }
    next = { manager: tags.manager!, staff: tags.staff! };
  }
  const updated = await db
    .update(workspaces)
    .set({ rosterTags: next })
    .where(eq(workspaces.id, workspaceId))
    .returning({ id: workspaces.id });
  if (updated.length === 0) {
    return { kind: "not-found" };
  }
  return { kind: "saved", tags: resolveRosterTags(next) };
}

// Grants every roster entry for this email as a source = shopify membership
// with the roster's role. A manual membership in the same workspace is never
// touched (a manager's invite outranks a tag); an existing shopify
// membership takes the roster's current role. Removing memberships whose
// tag is gone is the Shopify stage's job, not sign-in's.
export async function materializeRoster(db: Db, userId: string, email: string): Promise<void> {
  const entries = await db
    .select({ workspaceId: shopifyRoster.workspaceId, role: shopifyRoster.role })
    .from(shopifyRoster)
    .where(eq(shopifyRoster.email, email.trim().toLowerCase()));
  await applyBatch(
    db,
    entries.map((entry) =>
      db
        .insert(workspaceMembers)
        .values({
          id: crypto.randomUUID(),
          workspaceId: entry.workspaceId,
          userId,
          role: entry.role,
          source: "shopify",
        })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role: entry.role },
          setWhere: sql`${workspaceMembers.source} = 'shopify'`,
        }),
    ),
  );
}
