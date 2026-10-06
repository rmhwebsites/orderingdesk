// The activity bell (design doc: "bell badge = events newer than
// member.last_seen_at"): the workspace's recent activity with each order's
// name and who did it, and the viewer's unread count, which is the events
// newer than their last visit (workspace_members.last_seen_at) that
// someone else made (a person, Shopify or the system). "Mark all read"
// moves last_seen_at to now.
//
// Bell-worthy: every event except a successful write of a status to
// Shopify (the routine echo of a status change; a failed one shows) and the
// order_new events of orders brought in by the order history import
// (meta.imported, src/server/sync/backfill.ts): those are old orders, not
// arrivals, and an import can add thousands. Likewise the requests the
// first draft sync inserts silently (meta.silent, src/server/sync/
// drafts.ts): they were already waiting in Shopify.
// A platform admin who is not a member of the workspace has no
// last_seen_at there: they get the feed with no unread count, and nothing
// to mark read.

import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { events, orders, user, workspaceMembers } from "../db/schema";
import type { EventView } from "./desk/shapes";

export const FEED_SIZE = 30;
// Counting stops one past this; the badge then says "99+".
export const UNREAD_CAP = 99;

export type ActivityItem = {
  id: string;
  type: EventView["type"];
  text: string;
  orderId: string | null;
  orderName: string | null;
  // null for Shopify and the system.
  actorId: string | null;
  // The person's name, else their email; null when nobody (or nobody who
  // still has an account) did it.
  actorName: string | null;
  source: EventView["source"];
  meta: unknown;
  createdAt: number;
  unread: boolean;
  mine: boolean;
};

export type ActivityFeed = {
  items: ActivityItem[];
  // null for a viewer who is not a member (no record of their visits).
  unread: number | null;
  lastSeenAt: number | null;
};

function bellWorthy(workspaceId: string) {
  return and(
    eq(events.workspaceId, workspaceId),
    or(ne(events.type, "shopify_write"), sql`json_extract(${events.meta}, '$.ok') = 0`),
    or(ne(events.type, "order_new"), sql`coalesce(json_extract(${events.meta}, '$.imported'), 0) = 0`),
    or(ne(events.type, "order_new"), sql`coalesce(json_extract(${events.meta}, '$.silent'), 0) = 0`),
  );
}

async function lastSeenOf(db: Db, workspaceId: string, userId: string): Promise<number | null> {
  const rows = await db
    .select({ lastSeenAt: workspaceMembers.lastSeenAt })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return rows[0]?.lastSeenAt ?? null;
}

async function unreadCount(db: Db, workspaceId: string, userId: string, lastSeenAt: number): Promise<number> {
  const recent = db
    .select({ one: sql<number>`1`.as("one") })
    .from(events)
    .where(
      and(
        bellWorthy(workspaceId),
        gt(events.createdAt, lastSeenAt),
        or(isNull(events.actorId), ne(events.actorId, userId)),
      ),
    )
    .limit(UNREAD_CAP + 1)
    .as("recent");
  const rows = await db.select({ count: sql<number>`count(*)` }).from(recent);
  return Number(rows[0]?.count ?? 0);
}

export async function loadActivityFeed(db: Db, workspaceId: string, viewerUserId: string): Promise<ActivityFeed> {
  const lastSeenAt = await lastSeenOf(db, workspaceId, viewerUserId);
  const [rows, unread] = await Promise.all([
    db
      .select({
        id: events.id,
        type: events.type,
        text: events.text,
        orderId: events.orderId,
        orderName: orders.name,
        actorId: events.actorId,
        actorUserName: user.name,
        actorEmail: user.email,
        source: events.source,
        meta: events.meta,
        createdAt: events.createdAt,
      })
      .from(events)
      .leftJoin(orders, and(eq(orders.id, events.orderId), eq(orders.workspaceId, events.workspaceId)))
      .leftJoin(user, eq(user.id, events.actorId))
      .where(bellWorthy(workspaceId))
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(FEED_SIZE),
    lastSeenAt === null ? Promise.resolve(null) : unreadCount(db, workspaceId, viewerUserId, lastSeenAt),
  ]);
  return {
    unread,
    lastSeenAt,
    items: rows.map((row) => {
      const mine = row.actorId === viewerUserId;
      return {
        id: row.id,
        type: row.type,
        text: row.text,
        orderId: row.orderId,
        orderName: row.orderName ?? null,
        actorId: row.actorId,
        actorName: row.actorId ? row.actorUserName?.trim() || row.actorEmail || null : null,
        source: row.source,
        meta: row.meta ?? null,
        createdAt: row.createdAt,
        unread: lastSeenAt !== null && !mine && row.createdAt > lastSeenAt,
        mine,
      };
    }),
  };
}

export type MarkReadResult = { kind: "marked"; lastSeenAt: number } | { kind: "not-member" };

// Moves the viewer's last visit to now, never backward.
export async function markAllRead(db: Db, workspaceId: string, userId: string, now = Date.now()): Promise<MarkReadResult> {
  const rows = await db
    .update(workspaceMembers)
    .set({ lastSeenAt: sql`max(${workspaceMembers.lastSeenAt}, ${now})` })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .returning({ lastSeenAt: workspaceMembers.lastSeenAt });
  return rows[0] ? { kind: "marked", lastSeenAt: rows[0].lastSeenAt } : { kind: "not-member" };
}
