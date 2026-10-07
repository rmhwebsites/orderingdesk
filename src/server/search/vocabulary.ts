// The words AI search may use for one workspace (design section 3): status
// labels, active company location names and item titles, all controlled by
// staff. Nothing employees type (notes, personalization, cart attributes,
// names) is ever part of it. Relative imports only.

import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db";
import { locations, orders, statuses, workspaceSettings } from "../../db/schema";
import { DEFAULT_TIME_ZONE, isTimeZone } from "../../lib/date-range";
import type { SearchVocabulary } from "./ai-filter";

export const VOCAB_LOCATIONS_MAX = 100;
export const VOCAB_ITEMS_MAX = 150;
export const VOCAB_TEXT_MAX = 80;
// Item titles come from the newest cards' line items.
export const ITEM_SOURCE_ORDERS = 500;

export type LoadedVocabulary = { vocab: SearchVocabulary; timeZone: string; aiSearch: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Product titles by how often they were ordered lately, most common first.
// Custom line items (typed freehand on a draft) are left out.
export function topTitles(snapshots: readonly unknown[]): string[] {
  const counts = new Map<string, { title: string; count: number }>();
  for (const snapshot of snapshots) {
    const items = isRecord(snapshot) && Array.isArray(snapshot.items) ? snapshot.items : [];
    for (const item of items) {
      if (!isRecord(item) || item.custom === true || typeof item.title !== "string") {
        continue;
      }
      const title = item.title.replace(/\s+/g, " ").trim();
      if (title.length === 0 || title.length > VOCAB_TEXT_MAX) {
        continue;
      }
      const key = title.toLowerCase();
      const entry = counts.get(key) ?? { title, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, VOCAB_ITEMS_MAX)
    .map((entry) => entry.title);
}

export async function loadVocabulary(db: Db, workspaceId: string): Promise<LoadedVocabulary> {
  const [statusRows, locationRows, recent, settingsRows] = await Promise.all([
    db
      .select({ key: statuses.key, label: statuses.label })
      .from(statuses)
      .where(eq(statuses.workspaceId, workspaceId))
      .orderBy(asc(statuses.sort), asc(statuses.key)),
    // Keyed by the Shopify location id, the value orders.location_id holds.
    db
      .select({ id: locations.shopifyLocationId, name: locations.name })
      .from(locations)
      .where(and(eq(locations.workspaceId, workspaceId), sql`${locations.active} = 1`))
      .orderBy(asc(locations.name))
      .limit(VOCAB_LOCATIONS_MAX),
    db
      .select({ shopify: orders.shopify })
      .from(orders)
      .where(eq(orders.workspaceId, workspaceId))
      .orderBy(desc(orders.createdAt))
      .limit(ITEM_SOURCE_ORDERS),
    db
      .select({ timeZone: workspaceSettings.timeZone, aiSearch: workspaceSettings.aiSearch })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1),
  ]);
  const settings = settingsRows[0];
  return {
    vocab: {
      statuses: statusRows.map((row) => ({ key: row.key, label: row.label.slice(0, VOCAB_TEXT_MAX) })),
      locations: locationRows.map((row) => ({ id: row.id, name: row.name.slice(0, VOCAB_TEXT_MAX) })),
      items: topTitles(recent.map((row) => row.shopify)),
    },
    timeZone: settings && isTimeZone(settings.timeZone) ? settings.timeZone : DEFAULT_TIME_ZONE,
    aiSearch: settings ? Boolean(settings.aiSearch) : true,
  };
}
