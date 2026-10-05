// Each member's notification choices for one workspace (notification_prefs,
// one row per person and workspace, written on first change): push for new
// orders and sent purchase orders, email for the same, and push for all
// other activity. Defaults: on, on, off. Read by src/server/notify.ts and
// edited in Settings, Your notifications. A platform admin who is not a
// member of the workspace gets no notifications from it and has no choices
// to make here.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { notificationPrefs, workspaceMembers } from "../db/schema";
import { isRecord } from "./desk/shapes";

export type NotificationPrefsView = { pushNewOrders: boolean; emailNewOrders: boolean; pushAllActivity: boolean };

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefsView = {
  pushNewOrders: true,
  emailNewOrders: true,
  pushAllActivity: false,
};

const FIELDS = ["pushNewOrders", "emailNewOrders", "pushAllActivity"] as const;

async function isMember(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

async function storedPrefs(db: Db, workspaceId: string, userId: string): Promise<NotificationPrefsView> {
  const rows = await db
    .select({
      pushNewOrders: notificationPrefs.pushNewOrders,
      emailNewOrders: notificationPrefs.emailNewOrders,
      pushAllActivity: notificationPrefs.pushAllActivity,
    })
    .from(notificationPrefs)
    .where(and(eq(notificationPrefs.workspaceId, workspaceId), eq(notificationPrefs.userId, userId)))
    .limit(1);
  return rows[0] ?? DEFAULT_NOTIFICATION_PREFS;
}

export async function getNotificationPrefs(
  db: Db,
  workspaceId: string,
  userId: string,
): Promise<{ member: boolean; prefs: NotificationPrefsView }> {
  const [member, prefs] = await Promise.all([isMember(db, workspaceId, userId), storedPrefs(db, workspaceId, userId)]);
  return { member, prefs: member ? prefs : DEFAULT_NOTIFICATION_PREFS };
}

export type SavePrefsResult =
  | { kind: "saved"; prefs: NotificationPrefsView }
  | { kind: "invalid"; error: string }
  | { kind: "not-member" };

// Body: any of the three fields, each a boolean; the others keep their
// value.
export async function saveNotificationPrefs(db: Db, workspaceId: string, userId: string, body: unknown): Promise<SavePrefsResult> {
  if (!isRecord(body)) {
    return { kind: "invalid", error: "Send at least one notification setting" };
  }
  const changes: Partial<NotificationPrefsView> = {};
  for (const field of FIELDS) {
    if (field in body) {
      if (typeof body[field] !== "boolean") {
        return { kind: "invalid", error: `${field} must be true or false` };
      }
      changes[field] = body[field] as boolean;
    }
  }
  if (Object.keys(changes).length === 0) {
    return { kind: "invalid", error: "Send at least one notification setting" };
  }
  if (!(await isMember(db, workspaceId, userId))) {
    return { kind: "not-member" };
  }
  const current = await storedPrefs(db, workspaceId, userId);
  await db
    .insert(notificationPrefs)
    .values({ id: crypto.randomUUID(), userId, workspaceId, ...current, ...changes })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.workspaceId], set: changes });
  return { kind: "saved", prefs: await storedPrefs(db, workspaceId, userId) };
}
