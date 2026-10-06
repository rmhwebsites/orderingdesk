// Work queue settings per workspace (comprehensive desk design section 1),
// on the workspace_settings row: when an open card's age turns amber and
// red, and whether the desk shows prices. Rules in src/lib/queue-settings.ts.

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { workspaceSettings } from "@/db/schema";
import { DEFAULT_QUEUE_SETTINGS, parseQueueSettings, type QueueSettingsView } from "@/lib/queue-settings";

type QueueRow = Pick<typeof workspaceSettings.$inferSelect, "ageAmberDays" | "ageRedDays" | "priceDisplay">;

export function queueSettingsView(row: QueueRow | undefined): QueueSettingsView {
  return row
    ? { ageAmberDays: row.ageAmberDays, ageRedDays: row.ageRedDays, priceDisplay: row.priceDisplay }
    : { ...DEFAULT_QUEUE_SETTINGS };
}

export async function getQueueSettings(db: Db, workspaceId: string): Promise<QueueSettingsView> {
  const rows = await db
    .select({
      ageAmberDays: workspaceSettings.ageAmberDays,
      ageRedDays: workspaceSettings.ageRedDays,
      priceDisplay: workspaceSettings.priceDisplay,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return queueSettingsView(rows[0]);
}

export type UpdateQueueSettingsResult = { kind: "invalid"; error: string } | { kind: "ok"; queue: QueueSettingsView };

// Replaces the whole setting. Upsert, like the workspace settings: a missing
// row is recreated with its column defaults. The caller has checked the
// workspace exists (the route's guard).
export async function updateQueueSettings(db: Db, workspaceId: string, body: unknown): Promise<UpdateQueueSettingsResult> {
  const queue = parseQueueSettings(body);
  if (typeof queue === "string") {
    return { kind: "invalid", error: queue };
  }
  await db
    .insert(workspaceSettings)
    .values({ workspaceId, ...queue })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: queue });
  return { kind: "ok", queue };
}
