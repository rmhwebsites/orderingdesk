// Company locations (comprehensive design section 2): every Shopify B2B
// company location of the workspace's store, kept in the locations table so
// cards name their branch and show its address, and the request editor
// lists a company's branches. syncLocations runs when the connection is
// saved or refreshed and from the cron once a day (syncLocationsIfDue); the
// company_locations/* webhooks apply one location at a time. A location
// Shopify stops listing is kept, inactive, so cards still name it; rows are
// never deleted. After each sync, cards stored before 0012 get their
// location by name (backfillLocationIds). Needs a companies scope; never
// throws. Relative imports on purpose: the cron path bundles this.

import { and, asc, eq, isNull, lt, max, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "../../db";
import { rowsAffected } from "../../db/batch";
import { locations, orders, storeConnections } from "../../db/schema";
import { readLocationAddress, type LocationAddress } from "../../lib/address";
import { companiesEnabled, failureText } from "../shopify/admin";
import { fetchCompanyLocation, fetchCompanyLocations, type CompanyLocationRecord } from "../shopify/locations";
import { companyLocationIdOf } from "../shopify/normalize";
import { safeErrorReason } from "../shopify/status-sync";
import { getAccessToken } from "../shopify/token";

export const LOCATIONS_SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

export type LocationSyncResult =
  | { kind: "skipped"; reason: "no-connection" | "no-companies-scope" | "not-due" }
  | { kind: "ok"; upserted: number; deactivated: number; backfilled: number; complete: boolean }
  | { kind: "failed"; error: string };

export type LocationView = {
  shopifyLocationId: string;
  companyId: string | null;
  name: string;
  address: LocationAddress | null;
  active: boolean;
};

export type LocationJob = { kind: "location"; locationGid: string } | { kind: "location-deleted"; locationId: string };

type Deps = { fetchImpl?: typeof fetch; now?: () => number };

function locationView(row: typeof locations.$inferSelect): LocationView {
  return {
    shopifyLocationId: row.shopifyLocationId,
    companyId: row.companyId,
    name: row.name,
    address: readLocationAddress(row.address),
    active: row.active,
  };
}

// The connection's stored grant, or null without an enabled connection.
async function grantOf(db: Db, workspaceId: string): Promise<{ scopes: string[] | null } | null> {
  const rows = await db
    .select({ status: storeConnections.status, scopes: storeConnections.scopes })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const row = rows[0];
  return row && row.status !== "disabled" ? { scopes: Array.isArray(row.scopes) ? row.scopes : null } : null;
}

export async function upsertLocation(db: Db, workspaceId: string, record: CompanyLocationRecord, now: number): Promise<void> {
  await db
    .insert(locations)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      shopifyLocationId: record.shopifyLocationId,
      companyId: record.companyId,
      name: record.name,
      address: record.address,
      active: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [locations.workspaceId, locations.shopifyLocationId],
      set: { companyId: record.companyId, name: record.name, address: record.address, active: true, updatedAt: now },
    });
}

export async function deactivateLocation(db: Db, workspaceId: string, shopifyLocationId: string, now: number): Promise<void> {
  await db
    .update(locations)
    .set({ active: false, updatedAt: now })
    .where(and(eq(locations.workspaceId, workspaceId), eq(locations.shopifyLocationId, shopifyLocationId)));
}

// The location name a card stored before 0012 carries: the current
// snapshot's, else the draft snapshot's, trimmed; null when neither has one.
// Only draft snapshots name a location (an order snapshot has no location
// field), so backfillLocationIds first skips cards that never were drafts
// (no draft id, no draft snapshot) without reading any JSON.
const nameIn = (snapshot: AnyColumn) => sql`nullif(trim(json_extract(${snapshot}, '$.location')), '')`;
const cardLocationName = sql`coalesce(${nameIn(orders.shopify)}, ${nameIn(orders.draftSnapshot)})`;

// Cards stored before 0012 name their location only by the draft's
// location name: a name that exactly one location of the workspace has
// gives the card that location. Ambiguous or unknown names stay null. One
// statement over every card of the workspace still without a location, so
// cards that can never match (no name) cannot hide older ones that can.
export async function backfillLocationIds(db: Db, workspaceId: string): Promise<number> {
  const sameName = sql`${locations.workspaceId} = ${workspaceId} and ${locations.name} = ${cardLocationName}`;
  const result = await db
    .update(orders)
    .set({ locationId: sql`(select ${locations.shopifyLocationId} from ${locations} where ${sameName})` })
    .where(
      and(
        eq(orders.workspaceId, workspaceId),
        isNull(orders.locationId),
        sql`(${orders.shopifyDraftId} is not null or ${orders.draftSnapshot} is not null)`,
        sql`${cardLocationName} is not null`,
        sql`(select count(*) from ${locations} where ${sameName}) = 1`,
      ),
    );
  return rowsAffected(result, "locations");
}

export async function syncLocations(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  deps: Deps = {},
): Promise<LocationSyncResult> {
  try {
    const grant = await grantOf(db, workspaceId);
    if (!grant) {
      return { kind: "skipped", reason: "no-connection" };
    }
    if (!companiesEnabled(grant.scopes)) {
      return { kind: "skipped", reason: "no-companies-scope" };
    }
    const clock = deps.now ?? Date.now;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const token = await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
    if (token.kind === "unavailable") {
      return { kind: "skipped", reason: "no-connection" };
    }
    if (token.kind !== "ok") {
      return { kind: "failed", error: token.kind === "unreadable" ? "store credentials unreadable" : token.detail };
    }
    const fetched = await fetchCompanyLocations(token.shopDomain, token.token, fetchImpl);
    if (fetched.kind !== "ok") {
      return { kind: "failed", error: failureText(fetched).slice(0, 200) };
    }
    const now = clock();
    for (const record of fetched.locations) {
      await upsertLocation(db, workspaceId, record, now);
    }
    let deactivated = 0;
    if (fetched.complete) {
      // Every location Shopify listed was just touched with `now`; the rest
      // are gone from Shopify.
      const result = await db
        .update(locations)
        .set({ active: false, updatedAt: now })
        .where(and(eq(locations.workspaceId, workspaceId), eq(locations.active, true), lt(locations.updatedAt, now)));
      deactivated = rowsAffected(result, "locations");
    }
    const backfilled = await backfillLocationIds(db, workspaceId);
    return { kind: "ok", upserted: fetched.locations.length, deactivated, backfilled, complete: fetched.complete };
  } catch (e) {
    return { kind: "failed", error: safeErrorReason(e) };
  }
}

// The cron's pass: when the workspace has no locations yet, or its newest
// confirmation is a day old.
export async function syncLocationsIfDue(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  deps: Deps = {},
): Promise<LocationSyncResult> {
  const clock = deps.now ?? Date.now;
  const newest = await db
    .select({ at: max(locations.updatedAt) })
    .from(locations)
    .where(eq(locations.workspaceId, workspaceId));
  const at = newest[0]?.at ?? null;
  if (at !== null && clock() - at < LOCATIONS_SYNC_EVERY_MS) {
    return { kind: "skipped", reason: "not-due" };
  }
  return syncLocations(db, env, workspaceId, deps);
}

export async function listLocations(
  db: Db,
  workspaceId: string,
  opts: { companyId?: string | null; activeOnly?: boolean } = {},
): Promise<LocationView[]> {
  const conditions = [eq(locations.workspaceId, workspaceId)];
  if (opts.companyId) {
    conditions.push(eq(locations.companyId, opts.companyId));
  }
  if (opts.activeOnly) {
    conditions.push(eq(locations.active, true));
  }
  const rows = await db
    .select()
    .from(locations)
    .where(and(...conditions))
    .orderBy(asc(locations.name), asc(locations.shopifyLocationId));
  return rows.map(locationView);
}

export async function getLocation(db: Db, workspaceId: string, shopifyLocationId: string): Promise<LocationView | null> {
  const rows = await db
    .select()
    .from(locations)
    .where(and(eq(locations.workspaceId, workspaceId), eq(locations.shopifyLocationId, shopifyLocationId)))
    .limit(1);
  return rows[0] ? locationView(rows[0]) : null;
}

// One company_locations/* webhook (src/server/shopify/webhooks.ts): the
// location is read fresh and stored, or kept inactive when deleted or gone.
export async function applyLocationWebhook(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  job: LocationJob,
  deps: Deps = {},
): Promise<void> {
  const grant = await grantOf(db, workspaceId);
  if (!grant || !companiesEnabled(grant.scopes)) {
    return;
  }
  const clock = deps.now ?? Date.now;
  if (job.kind === "location-deleted") {
    await deactivateLocation(db, workspaceId, job.locationId, clock());
    return;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
  if (token.kind !== "ok") {
    return;
  }
  const fetched = await fetchCompanyLocation(token.shopDomain, token.token, job.locationGid, fetchImpl);
  if (fetched.kind !== "ok") {
    console.warn("[locations] " + JSON.stringify({ workspaceId, webhook: failureText(fetched).slice(0, 200) }));
    return;
  }
  const now = clock();
  if (fetched.location === null) {
    const id = companyLocationIdOf(job.locationGid);
    if (id) {
      await deactivateLocation(db, workspaceId, id, now);
    }
    return;
  }
  await upsertLocation(db, workspaceId, fetched.location, now);
  await backfillLocationIds(db, workspaceId);
}
