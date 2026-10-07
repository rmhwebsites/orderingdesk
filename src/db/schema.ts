import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index, check, primaryKey } from "drizzle-orm/sqlite-core";
import type { WorkspaceBranding } from "../lib/branding";
import type { LocationAddress } from "../lib/address";
import { PRICE_DISPLAY_VALUES } from "../lib/queue-settings";
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
  // Order history import (src/server/sync/backfill.ts): a platform admin's
  // one-off import of orders the regular sync never fetched, advanced a few
  // pages per cron tick with its own cursor so the regular sync's cursor
  // and last_sync_at are never touched. Null status: never started.
  backfillStatus: text("backfill_status", { enum: ["running", "done", "cancelled", "failed"] }),
  // Orders created at or after this time (ms); null imports all orders.
  backfillSince: integer("backfill_since"),
  // The Shopify cursor the next tick resumes from (null before the first
  // page and once finished).
  backfillCursor: text("backfill_cursor"),
  // Orders this import inserted (orders already stored are not counted).
  backfillImported: integer("backfill_imported").notNull().default(0),
  // When the import was started; also tells one import from the next.
  backfillStartedAt: integer("backfill_started_at"),
  backfillFinishedAt: integer("backfill_finished_at"),
  backfillError: text("backfill_error"),
  // Draft orders (draft orders spec section 5), synced in the same run and
  // under the same lease as orders, with their own cursor: the same
  // "<ms>|<cursor>" resume token as sync_cursor, and the window it belongs
  // to.
  draftSyncCursor: text("draft_sync_cursor"),
  draftSyncCursorSince: integer("draft_sync_cursor_since"),
  // The window-open anchor of the last completed draft fetch; 0 means the
  // first draft sync (every open draft, inserted silently) is still pending.
  draftLastSyncAt: integer("draft_last_sync_at").notNull().default(0),
  // When the hourly check of every open draft card last ran to completion.
  draftCheckedAt: integer("draft_checked_at").notNull().default(0),
  // The store's own myshopify.com domain (shop.myshopifyDomain), recorded
  // when the connection is saved or refreshed. It can differ from
  // shop_domain, which may be an alias (IMPACT: impactrentals.myshopify.com
  // for 40kra0-b6.myshopify.com), and it is the domain Shopify puts in
  // X-Shopify-Shop-Domain, so the webhook receiver accepts exactly either.
  // Null until then, or when Shopify did not say.
  canonicalShopDomain: text("canonical_shop_domain"),
  // When a company location sync (src/server/sync/locations.ts) last ran,
  // complete, partial or failed: the cron runs the next one a day later.
  // Kept apart from locations.updated_at, which webhooks also touch. Null
  // until the first sync (0012).
  locationsSyncedAt: integer("locations_synced_at"),
});

// The Shopify states and draft order outcomes a status can follow (see
// statuses.shopify_link).
export const SHOPIFY_LINK_VALUES = ["fulfilled", "delivered", "draft_completed", "draft_rejected", "cancelled"] as const;
export type ShopifyLinkValue = (typeof SHOPIFY_LINK_VALUES)[number];

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
  // draft_completed: where Approve puts a request and where a request goes
  // when its draft is completed in Shopify. draft_rejected: where Reject
  // puts a request. cancelled: where Cancel order and Shopify's own
  // cancellations put an order (comprehensive design section 2). Plain
  // text column (no CHECK since 0004).
  shopifyLink: text("shopify_link", { enum: SHOPIFY_LINK_VALUES }),
  // Closed statuses are finished work: their cards leave the Open view and
  // show their age without a warning color (comprehensive desk design
  // section 1). Delivered and Rejected start closed (migration 0011).
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("status_key_unique").on(t.workspaceId, t.key)]);

// One row per request (draft orders spec section 2): a draft card is a row
// with shopify_order_id null and shopify_draft_id set; when Shopify reports
// the order the draft became, the same row gets the order id (the attach
// compare-and-set in src/server/sync/drafts.ts) and keeps its id, status,
// notes, events and purchase orders. The kind is derived, never stored:
// shopifyOrderId === null means a draft card.
export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  // Null while the card is a draft. Set once, by the attach.
  shopifyOrderId: text("shopify_order_id"),
  // "#D12" while a draft, the order name after the attach.
  name: text("name").notNull(),
  // The current snapshot: the normalized draft, then the order.
  shopify: text("shopify", { mode: "json" }).notNull(),
  statusKey: text("status_key").notNull(),
  statusSetBy: text("status_set_by"),
  statusSetAt: integer("status_set_at"),
  createdAt: integer("created_at").notNull(),
  syncedAt: integer("synced_at").notNull(),
  // When the new-order notification was claimed (src/server/notify.ts).
  // notifyNewOrders sets it with one conditional UPDATE before anything is
  // sent, so an order is announced at most once, whichever of the cron
  // sync, the Sync button or a webhook landed it. Null for orders that were
  // never claimed, including every order stored before migration 0007.
  notifiedAt: integer("notified_at"),
  // Declared last, matching the physical column order after the 0010
  // rebuild (positional insert-selects depend on it).
  // The legacy numeric draft id, for cards that are or were drafts.
  shopifyDraftId: text("shopify_draft_id"),
  // "#D12", kept after the order attaches.
  draftName: text("draft_name"),
  // The draft's normalized snapshot as of the attach, refreshed by later
  // draft updates. Null for cards that never were drafts; the display
  // fallback for request fields on the order card.
  draftSnapshot: text("draft_snapshot", { mode: "json" }),
  // When Shopify reported the open draft gone (delete webhook, a null
  // re-fetch, or the hourly check). The card is kept.
  draftDeletedAt: integer("draft_deleted_at"),
  // The Shopify B2B company location the card ships to (comprehensive
  // design section 2): the legacy id of the purchasing entity's location,
  // the same value as locations.shopify_location_id (join on workspace and
  // that id; no foreign key, the location may not be synced yet). Written
  // by every snapshot writer; null for a card without a company location.
  locationId: text("location_id"),
}, (t) => [
  // SQLite UNIQUE allows many NULLs: open drafts never collide here, and
  // plain orders never collide in order_draft_unique.
  uniqueIndex("order_unique").on(t.workspaceId, t.shopifyOrderId),
  uniqueIndex("order_draft_unique").on(t.workspaceId, t.shopifyDraftId),
  index("order_ws_created").on(t.workspaceId, t.createdAt),
  index("order_ws_status").on(t.workspaceId, t.statusKey),
  // Bare column names on purpose in both SQL fragments below: drizzle-kit
  // builds this table as __new_orders and renames it, and a table-qualified
  // name would keep pointing at the temporary name.
  index("order_open_drafts").on(t.workspaceId, t.createdAt).where(sql`shopify_order_id is null`),
  check("order_source", sql`shopify_order_id is not null or shopify_draft_id is not null`),
]);

// The workspace's Shopify B2B company locations (comprehensive design
// section 2), synced by src/server/sync/locations.ts. shopify_location_id
// and company_id are Shopify legacy ids. active = false: Shopify no longer
// lists it (kept, so cards still name it). updated_at: when the desk last
// confirmed the row against Shopify (a complete sync deactivates the rows
// it did not touch); webhooks touch it too, so the cron times the daily
// sync by store_connections.locations_synced_at instead.
export const locations = sqliteTable("locations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  shopifyLocationId: text("shopify_location_id").notNull(),
  companyId: text("company_id"),
  name: text("name").notNull(),
  address: text("address", { mode: "json" }).$type<LocationAddress>(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("location_shopify_unique").on(t.workspaceId, t.shopifyLocationId)]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id"),
  // shopify_write: the outcome of writing a status to Shopify (the status
  // tag, and a fulfillment for a status linked to fulfilled). po_failed: a
  // purchase order send attempt that failed. TypeScript-only enum: the
  // column has no CHECK, so adding a value needs no migration.
  type: text("type", {
    enum: [
      "order_new",
      "status",
      "note",
      "po_sent",
      "po_draft",
      "po_failed",
      "sync_error",
      "shopify_write",
      // A draft card became the order Shopify made from it, and a draft
      // Shopify no longer has (draft orders spec sections 6.1 and 6.3).
      "draft_completed",
      "draft_deleted",
      // A manager edited a request before approval, and an order cancelled
      // from the desk (comprehensive design section 2).
      "draft_edited",
      "order_cancelled",
      // A manager placed a request through their AI app (Wave 2).
      "request_placed",
    ],
  }).notNull(),
  text: text("text").notNull(),
  actorId: text("actor_id"),
  meta: text("meta", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
  // Where the change came from: a person in the app, a person through their
  // AI app (Wave 2: meta.ai.client names the app, src/lib/via.ts), Shopify
  // (sync or webhook), or the system itself (sync failures and similar).
  // Declared last, matching the physical column order (migration 0004
  // appended it), because changeOrderStatus inserts with a positional
  // insert-select. TypeScript-only enum: the column has no CHECK.
  source: text("source", { enum: ["app", "ai", "shopify", "system"] }).notNull().default("app"),
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

// Purchase orders to vendors (src/server/po/). Never sent automatically: a
// manager reviews one and confirms its recipients every time.
export const purchaseOrders = sqliteTable("purchase_orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  orderId: text("order_id").notNull(),
  vendorId: text("vendor_id").notNull(),
  // <prefix>-<YYYY>-<NNNN>, minted at the first send attempt
  // (src/server/po/number.ts). Until then a placeholder, "draft:<id>",
  // which can never look like a minted number (prefixes are uppercase
  // letters and digits) and keeps the column unique.
  poNumber: text("po_number").notNull(),
  lineItems: text("line_items", { mode: "json" }).notNull(),
  // The ship-to address as lines of text.
  shipTo: text("ship_to", { mode: "json" }),
  notes: text("notes"),
  // draft: never sent; sent: the vendor email went out at least once;
  // failed: the last send attempt failed (last_error says why).
  status: text("status", { enum: ["draft", "sent", "failed"] }).notNull().default("draft"),
  // R2 key under pos/<workspaceId>/ of the PDF last rendered for a send.
  pdfKey: text("pdf_key"),
  // The first successful send.
  sentAt: integer("sent_at"),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull(),
  // Migration 0009 (all additive). The order's currency when the PO was
  // created; line costs are in it.
  currency: text("currency").notNull().default("USD"),
  // Why the last send attempt failed, in plain language; null otherwise.
  lastError: text("last_error"),
  // The send lease: set when a send attempt claims the PO, cleared when it
  // ends. A second attempt while it is fresh is refused, so one PO never
  // goes out twice from overlapping requests.
  sendStartedAt: integer("send_started_at"),
  // The request id of the attempt that last claimed the PO: the same
  // request repeated (a lost response, a retried tap) answers what that
  // attempt did instead of sending again.
  sendAttempt: text("send_attempt"),
  // The recipients of the last successful send.
  sentTo: text("sent_to", { mode: "json" }).$type<{ to: string[]; cc: string[] }>(),
  sentBy: text("sent_by"),
  // Successful sends (a resend after the first counts too).
  sendCount: integer("send_count").notNull().default(0),
  updatedAt: integer("updated_at"),
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
  // An open card's age turns amber, then red, after this many days in its
  // status (migration 0011).
  ageAmberDays: integer("age_amber_days").notNull().default(2),
  ageRedDays: integer("age_red_days").notNull().default(4),
  // Totals and the Paid chip on the desk (src/lib/queue-settings.ts).
  priceDisplay: text("price_display", { enum: PRICE_DISPLAY_VALUES }).notNull().default("auto"),
  // Migration 0013 (Wave 1c). The IANA time zone search dates ("today",
  // "last month") are computed in (src/lib/date-range.ts).
  timeZone: text("time_zone").notNull().default("America/New_York"),
  // AI search on or off for this workspace (Settings > Search).
  aiSearch: integer("ai_search", { mode: "boolean" }).notNull().default(true),
  // When the search backfill (src/server/search/search-tick.ts) finished its
  // first full pass over the workspace's cards; null while it runs.
  searchIndexedAt: integer("search_indexed_at"),
  // "<createdAt>~<orderId>" of the last card that pass indexed. Once the
  // pass finished, the same position for the tick's rolling verify pass
  // (null: start from the oldest card).
  searchBackfillCursor: text("search_backfill_cursor"),
  // Migration 0014 (Wave 2). Team members may connect AI apps while this is
  // on (platform admins switch it on the hub). Off in every workspace until
  // a platform admin turns it on (owner decision, Oct 7). Daily limits per
  // person (src/mcp/usage.ts); platform admins use the manager limit.
  aiTeam: integer("ai_team", { mode: "boolean" }).notNull().default(false),
  aiReadsPerDay: integer("ai_reads_per_day").notNull().default(1000),
  aiStaffChangesPerDay: integer("ai_staff_changes_per_day").notNull().default(50),
  aiManagerChangesPerDay: integer("ai_manager_changes_per_day").notNull().default(100),
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
  // The host the browser subscribed on (normalized, no port): the hub or a
  // client host. A service worker belongs to one origin, so a notification's
  // link opens the order on this host when it can (src/server/notify.ts).
  // Null reads as the hub.
  host: text("host"),
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
  // A tag only asks for access: any storefront visitor can create a
  // customer with tags (the newsletter form's contact[tags]), so a manager
  // approves each request once (src/server/roster.ts). approvedRole is the
  // role approved and the role the row grants. It never exceeds role: a
  // lowered tag lowers it at once, a raised tag leaves it until the raise
  // is approved. Null until a first approval. Rows start unapproved.
  approvedRole: text("approved_role", { enum: ["manager", "staff"] }),
  approvedAt: integer("approved_at"),
  // The approving user's id.
  approvedBy: text("approved_by"),
  // Denied by a manager: grants nothing, and stays denied until the tag is
  // removed (which deletes the row) and added again.
  deniedAt: integer("denied_at"),
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

// One search row per card (design section 3), rewritten after every
// snapshot write, edit and status change (src/server/search/index-orders.ts)
// and repaired by the cron's search tick. haystack: lowercased text with
// single spaces (order and draft numbers, requester name and email, request
// fields, location name, item titles, SKUs, sizes, personalization values,
// PO numbers). The other columns copy the card's filter fields. No foreign
// keys: a card folded into another (drafts.ts mergeOrderIntoDraft) is
// deleted, and its search row goes with the next index or sweep. No FTS5:
// D1 cannot export a database that has virtual tables.
export const orderSearch = sqliteTable("order_search", {
  orderId: text("order_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  haystack: text("haystack").notNull(),
  kind: text("kind", { enum: ["draft", "order"] }).notNull(),
  statusKey: text("status_key").notNull(),
  // 1 while the card's status is closed (statuses.closed), else 0.
  closed: integer("closed").notNull(),
  locationId: text("location_id"),
  // people.id of the requester, or null.
  requesterId: text("requester_id"),
  createdAt: integer("created_at").notNull(),
  statusSetAt: integer("status_set_at"),
}, (t) => [
  index("search_ws_closed_created").on(t.workspaceId, t.closed, t.createdAt),
  index("search_ws_status").on(t.workspaceId, t.statusKey),
  index("search_ws_location").on(t.workspaceId, t.locationId),
  index("search_ws_requester").on(t.workspaceId, t.requesterId),
]);

// The workspace's requesters (design section 3, employee pages), built
// from the cards' Shopify customers. The newest card a person is seen on
// decides their name, email, company contact and home location.
export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  // The Shopify customer's legacy id.
  shopifyCustomerId: text("shopify_customer_id").notNull(),
  name: text("name"),
  email: text("email"),
  // The B2B company contact's legacy id, when a draft named one.
  companyContactId: text("company_contact_id"),
  // The Shopify location id (as orders.location_id holds it) of their
  // newest card's company location.
  locationId: text("location_id"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
}, (t) => [uniqueIndex("people_customer_unique").on(t.workspaceId, t.shopifyCustomerId)]);

// Daily counters per principal (a member's user id now; Wave 3 requesters
// later) and kind ("search" for AI search questions). day is the UTC day,
// YYYY-MM-DD, because the Workers AI allowance resets at 00:00 UTC. Rows
// older than AI_USAGE_RETENTION_DAYS are pruned by the cron.
export const aiUsage = sqliteTable("ai_usage", {
  workspaceId: text("workspace_id").notNull(),
  principalId: text("principal_id").notNull(),
  day: text("day").notNull(),
  kind: text("kind").notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.principalId, t.day, t.kind] })]);

// ---------------------------------------------------------------------------
// MCP server for team members (comprehensive desk design section 4,
// migration 0014).

// One row per AI connection: an OAuth grant issued on the authorize page
// (src/mcp/oauth/authorize.ts). The OAuth library keeps the grant itself in
// OAUTH_KV; this mirror is what every MCP call checks (src/mcp/principal.ts),
// because D1 is consistent at once while a KV delete can take a minute to
// reach every location, so a revoke here is instant. id is the app's own
// id, carried in the grant's props and metadata. client is one of
// src/lib/via.ts's AI_CLIENTS, picked from the verified client domain or
// redirect host, never from the app's own name. workspace_id is null for a
// platform admin's hub connection for every workspace with AI on (owner
// decision 3, Oct 7: src/mcp/every-workspace.ts); every tool call on it
// names the workspace.
export const aiGrants = sqliteTable("ai_grants", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  userId: text("user_id").notNull(),
  // The host the connection was made on; its tokens work only there.
  host: text("host").notNull(),
  clientId: text("client_id").notNull(),
  client: text("client").notNull(),
  clientDomain: text("client_domain"),
  redirectHost: text("redirect_host").notNull(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  // The user who revoked it, or null for the system.
  revokedBy: text("revoked_by"),
  // person, manager, platform_admin, member_removed or replaced.
  revokeReason: text("revoke_reason"),
  // When the cron revoked the grant in OAUTH_KV too (src/mcp/prune.ts);
  // the D1 revoke above already blocks every call.
  kvRevokedAt: integer("kv_revoked_at"),
}, (t) => [index("ai_grants_ws_user").on(t.workspaceId, t.userId), index("ai_grants_user").on(t.userId)]);

// The writes a prepare tool stores and its confirm tool carries out once
// (src/mcp/actions.ts). Single use: confirm claims the row with a
// conditional UPDATE. content_hash covers the payload and the target's
// state at preview time. unknown: a request whose create timed out; the same
// confirmation may only look it up again, never send it again.
export const AI_ACTION_TOOLS = ["status", "note", "approve", "reject", "cancel", "edit", "place_request"] as const;
export type AiActionTool = (typeof AI_ACTION_TOOLS)[number];

export const aiActions = sqliteTable("ai_actions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  grantId: text("grant_id").notNull(),
  userId: text("user_id").notNull(),
  tool: text("tool", { enum: AI_ACTION_TOOLS }).notNull(),
  // The card, or null for a request not placed yet.
  targetId: text("target_id"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  contentHash: text("content_hash").notNull(),
  status: text("status", { enum: ["pending", "executing", "done", "failed", "unknown"] }).notNull().default("pending"),
  // A short outcome code (ok, changed, refused, limit_reached, ...).
  outcome: text("outcome"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
}, (t) => [index("ai_actions_grant").on(t.grantId), index("ai_actions_expires").on(t.expiresAt)]);

// The 6-digit codes of the authorize page (src/mcp/oauth/codes.ts). The
// code itself is never stored: code_hash is SHA-256 of the origin, the row
// id and the code. user_id is null when the email may not connect (the row
// exists anyway, so every email gets the same page and timing; no code is
// sent then). verified_at: the code was right; consumed_at: the consent
// that followed used the sign-in. Emails are lowercased; ip_hash is SHA-256
// of the client IP and the origin.
export const aiSignInCodes = sqliteTable("ai_sign_in_codes", {
  id: text("id").primaryKey(),
  origin: text("origin").notNull(),
  email: text("email").notNull(),
  userId: text("user_id"),
  clientId: text("client_id").notNull(),
  codeHash: text("code_hash").notNull(),
  ipHash: text("ip_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  verifiedAt: integer("verified_at"),
  consumedAt: integer("consumed_at"),
}, (t) => [
  index("ai_codes_email").on(t.origin, t.email, t.createdAt),
  index("ai_codes_ip").on(t.ipHash, t.createdAt),
  index("ai_codes_expires").on(t.expiresAt),
]);

// One row per MCP tool call (src/mcp/audit.ts): who, through which
// connection and app, which tool, on what, and how it ended. Never
// arguments, payloads or text. Kept 400 days (src/mcp/prune.ts).
// workspace_id is null only for an every-workspace connection's
// list_workspaces call and for a call naming a workspace that does not exist.
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  actorId: text("actor_id").notNull(),
  grantId: text("grant_id"),
  client: text("client"),
  tool: text("tool").notNull(),
  // order, person, location or product.
  targetKind: text("target_kind"),
  targetId: text("target_id"),
  // ok, or the tool error code.
  outcome: text("outcome").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("audit_ws_created").on(t.workspaceId, t.createdAt), index("audit_grant").on(t.grantId, t.createdAt)]);
