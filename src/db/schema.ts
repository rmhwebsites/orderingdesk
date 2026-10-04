import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { WorkspaceBranding } from "../lib/branding";
import { user } from "./auth-schema";

export * from "./auth-schema";

// Shopify customer tags that grant workspace access (platform amendment
// section 2). Stored per workspace in workspaces.roster_tags; null there
// means DEFAULT_ROSTER_TAGS (src/server/roster.ts).
export type RosterTags = { manager: string; staff: string };

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  accentColor: text("accent_color").notNull().default("#91d500"),
  logoUrl: text("logo_url"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  // Client host such as orders.impactrentals.store. Stored lowercased (the
  // code that writes it lowercases; SQLite cannot add a CHECK to an existing
  // table without rebuilding it, and every table references this one).
  customDomain: text("custom_domain"),
  customDomainStatus: text("custom_domain_status", { enum: ["pending", "active", "error"] }),
  // Per-workspace sender, normally orders@<client domain>. Until
  // sending_verified_at is set (a test send succeeded) the workspace sends
  // from the platform sender with its own name and reply-to.
  sendingAddress: text("sending_address"),
  sendingVerifiedAt: integer("sending_verified_at"),
  rosterTags: text("roster_tags", { mode: "json" }).$type<RosterTags>(),
  branding: text("branding", { mode: "json" }).$type<WorkspaceBranding>(),
}, (t) => [uniqueIndex("workspace_custom_domain_unique").on(t.customDomain)]);

export const workspaceMembers = sqliteTable("workspace_members", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull(),
  role: text("role", { enum: ["manager", "staff"] }).notNull(),
  // manual: invited by a manager or platform admin. shopify: granted by a
  // tagged Shopify customer (shopify_roster). Shopify sync only ever adds or
  // removes shopify memberships, never manual ones.
  source: text("source", { enum: ["manual", "shopify"] }).notNull().default("manual"),
  lastSeenAt: integer("last_seen_at").notNull().default(0),
}, (t) => [
  uniqueIndex("member_unique").on(t.workspaceId, t.userId),
  index("member_user").on(t.userId),
]);

// Platform admins promoted inside the app. The bootstrap list lives in the
// PLATFORM_ADMIN_EMAILS Worker secret instead; isPlatformAdmin
// (src/server/access.ts) accepts either.
export const platformAdmins = sqliteTable("platform_admins", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const storeConnections = sqliteTable("store_connections", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  shopDomain: text("shop_domain").notNull(),
  // legacy_token mode: the encrypted Admin API token (shpat_). Empty in
  // client_credentials mode and after a disconnect.
  encryptedToken: text("encrypted_token").notNull(),
  // legacy_token: a long-lived Admin API token (apps created before 2026).
  // client_credentials: a Dev Dashboard app's client ID and secret, traded
  // for a roughly 24 hour access token that is cached encrypted below.
  authMode: text("auth_mode", { enum: ["client_credentials", "legacy_token"] })
    .notNull()
    .default("legacy_token"),
  clientId: text("client_id"),
  // Encrypted like encrypted_token (src/server/crypto.ts, aad = workspaceId).
  encryptedClientSecret: text("encrypted_client_secret"),
  encryptedAccessToken: text("encrypted_access_token"),
  accessTokenExpiresAt: integer("access_token_expires_at"),
  // The granted scope handles as verified at connect time (JSON array).
  scopes: text("scopes", { mode: "json" }).$type<string[]>(),
  webhooksRegisteredAt: integer("webhooks_registered_at"),
  shopName: text("shop_name"),
  status: text("status", { enum: ["ok", "error", "disabled"] }).notNull().default("ok"),
  lastSyncAt: integer("last_sync_at").notNull().default(0),
  lastManualSyncAt: integer("last_manual_sync_at").notNull().default(0),
  runningUntil: integer("running_until").notNull().default(0),
  lastError: text("last_error"),
  // Cross-tick pagination state: when a fetch stops at the page cap, the
  // Shopify cursor and the exact since window it belongs to are persisted so
  // the next tick resumes mid-window instead of re-anchoring on a watermark
  // (which livelocks when 500+ orders share one updatedAt second).
  syncCursor: text("sync_cursor"),
  syncCursorSince: integer("sync_cursor_since"),
});

export const statuses = sqliteTable("statuses", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  key: text("key").notNull(),
  label: text("label").notNull(),
  color: text("color").notNull(),
  sort: integer("sort").notNull(),
  triggersPo: integer("triggers_po", { mode: "boolean" }).notNull().default(false),
  // The Shopify state this status mirrors, or null. Moving an order into a
  // status linked to fulfilled creates a Shopify fulfillment; Shopify
  // reporting the order fulfilled or delivered moves it to the linked status.
  shopifyLink: text("shopify_link", { enum: ["fulfilled", "delivered"] }),
}, (t) => [uniqueIndex("status_key_unique").on(t.workspaceId, t.key)]);

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  shopifyOrderId: text("shopify_order_id").notNull(),
  name: text("name").notNull(),
  shopify: text("shopify", { mode: "json" }).notNull(),
  statusKey: text("status_key").notNull(),
  statusSetBy: text("status_set_by"),
  statusSetAt: integer("status_set_at"),
  createdAt: integer("created_at").notNull(),
  syncedAt: integer("synced_at").notNull(),
}, (t) => [
  uniqueIndex("order_unique").on(t.workspaceId, t.shopifyOrderId),
  index("order_ws_created").on(t.workspaceId, t.createdAt),
  index("order_ws_status").on(t.workspaceId, t.statusKey),
]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id"),
  // shopify_write: the outcome of writing a status to Shopify (the status
  // tag, and a fulfillment for a status linked to fulfilled). TypeScript-only
  // enum: the column has no CHECK, so adding a value needs no migration.
  type: text("type", {
    enum: ["order_new", "status", "note", "po_sent", "po_draft", "sync_error", "shopify_write"],
  }).notNull(),
  text: text("text").notNull(),
  actorId: text("actor_id"),
  meta: text("meta", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
  // Where the change came from: a person in the app, Shopify (sync or
  // webhook), or the system itself (sync failures and similar). Declared
  // last, matching the physical column order (migration 0004 appended it),
  // because changeOrderStatus inserts with a positional insert-select.
  source: text("source", { enum: ["app", "shopify", "system"] }).notNull().default("app"),
}, (t) => [index("events_ws_created").on(t.workspaceId, t.createdAt), index("events_order").on(t.orderId)]);

export const vendors = sqliteTable("vendors", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  cc: text("cc", { mode: "json" }).$type<string[]>(),
  notes: text("notes"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

export const purchaseOrders = sqliteTable("purchase_orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id").notNull(),
  vendorId: text("vendor_id").notNull(),
  poNumber: text("po_number").notNull(),
  lineItems: text("line_items", { mode: "json" }).notNull(),
  shipTo: text("ship_to", { mode: "json" }),
  notes: text("notes"),
  status: text("status", { enum: ["draft", "sent", "failed"] }).notNull().default("draft"),
  pdfKey: text("pdf_key"),
  sentAt: integer("sent_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  uniqueIndex("po_number_unique").on(t.workspaceId, t.poNumber),
  index("po_order").on(t.orderId),
]);

export const workspaceSettings = sqliteTable("workspace_settings", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  notificationEmails: text("notification_emails", { mode: "json" }).$type<string[]>().notNull().default([]),
  poPrefix: text("po_prefix").notNull().default("PO"),
  replyTo: text("reply_to"),
  fromName: text("from_name"),
});

export const notificationPrefs = sqliteTable("notification_prefs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  pushNewOrders: integer("push_new_orders", { mode: "boolean" }).notNull().default(true),
  emailNewOrders: integer("email_new_orders", { mode: "boolean" }).notNull().default(true),
  pushAllActivity: integer("push_all_activity", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("prefs_unique").on(t.userId, t.workspaceId)]);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  keys: text("keys", { mode: "json" }).$type<{ p256dh: string; auth: string }>().notNull(),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("push_user").on(t.userId)]);

// Invites for people who have no account yet; claimed at sign-in. Exactly
// one kind per row (the invite_kind check): a workspace invite (workspace_id
// and role set, platform_admin false) or a platform-admin invite
// (platform_admin true, workspace_id and role null). Emails are lowercased.
export const pendingInvites = sqliteTable("pending_invites", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  role: text("role", { enum: ["manager", "staff"] }),
  platformAdmin: integer("platform_admin", { mode: "boolean" }).notNull().default(false),
  invitedBy: text("invited_by").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  uniqueIndex("invite_unique").on(t.email, t.workspaceId),
  // NULL workspace ids never collide in invite_unique, so platform-admin
  // invites get their own one-per-email index.
  // Bare column names on purpose in both SQL fragments below: drizzle-kit
  // builds this table as __new_pending_invites and renames it, and a
  // table-qualified name would keep pointing at the temporary name.
  uniqueIndex("platform_invite_unique").on(t.email).where(sql`platform_admin = 1`),
  check(
    "invite_kind",
    sql`(platform_admin = 0 and workspace_id is not null and role is not null) or (platform_admin = 1 and workspace_id is null and role is null)`,
  ),
]);

// Tagged Shopify customers of a workspace's store (platform amendment
// section 2): who may sign in and with which role. The Shopify stage fills
// it from customer webhooks and the periodic sync; sign-in turns matching
// rows into source = shopify memberships. Emails are lowercased.
export const shopifyRoster = sqliteTable("shopify_roster", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  email: text("email").notNull(),
  role: text("role", { enum: ["manager", "staff"] }).notNull(),
  shopifyCustomerId: text("shopify_customer_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  uniqueIndex("roster_unique").on(t.workspaceId, t.email),
  index("roster_email").on(t.email),
  index("roster_customer").on(t.workspaceId, t.shopifyCustomerId),
]);

// Shopify webhook dedupe: one row per X-Shopify-Webhook-Id already applied.
// Old rows are pruned by received_at.
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  topic: text("topic").notNull(),
  receivedAt: integer("received_at").notNull(),
}, (t) => [index("webhook_received").on(t.receivedAt)]);

// Team invite emails a workspace has sent, for the hourly limit in
// src/server/members.ts (a withdrawn invite keeps its row, so inviting and
// withdrawing cannot send without limit). Rows older than the window are
// pruned as new ones arrive. No recipient is stored.
export const inviteSends = sqliteTable("invite_sends", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  sentAt: integer("sent_at").notNull(),
}, (t) => [index("invite_sends_window").on(t.workspaceId, t.sentAt)]);
