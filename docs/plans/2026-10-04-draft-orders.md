# Ordering Desk: Draft Orders (build spec, Oct 4, 2026)

Status: ready to build. The owner decisions listed in section 0 are binding.
Read section 18 first: store facts verified on Oct 4 and the resolved open
questions. Where section 18 differs from earlier text, section 18 wins.
Base: branch `build/m1-core` (Phase 6 notifications are committed there as
1184599 and fe3be05; the activity bell is still uncommitted). Production is
3cb5cac on `main`. This spec adds one migration and touches the sync engine,
webhooks, status sync, the desk and notifications.

---

## What changes for the team

**New requests show up in Ordering Desk the moment they are submitted.**
When an employee checks out on the IMPACT store, Shopify makes a draft order
("submitted for review"). Today nobody sees it in the desk until a manager
marks it paid in Shopify. After this change:

- The request appears right away as a card with a **Draft** badge and its
  draft number, for example **#D12**.
- Everyone who gets new-order alerts today gets a phone push and a branded
  email that says **New request #D12**.
- The card shows who asked, their company branch, **Ship to Branch**,
  **For Employee Name**, **Reason for Request**, **Internal Notes**, and every
  item with its personalization. For business cards that means the preview
  image and a link to the PDF proof.
- Statuses, notes, the activity timeline and live updates work exactly like
  they do for orders.

**Managers get two buttons on a request: Approve and Reject.**

- **Approve** asks you to confirm, then creates the order in Shopify. This is
  exactly what pressing Mark as paid on the $0 draft does today. The card
  becomes that order (it shows **#1234**, with "from draft #D12" underneath)
  and keeps every note, status change and purchase order. Nobody gets a
  second "new order" alert for it.
- **Reject** asks for a reason, saves the reason as a note, moves the card to
  a new **Rejected** status, and tags the draft "Ordering Desk: Rejected" in
  Shopify. Nothing is deleted. Nobody is emailed.
- If someone marks the draft paid in Shopify instead, or edits the Ordering
  Desk tag there, the card follows on its own.
- Staff can move a request between New, Processing, On Hold and Issue and add
  notes. Only managers (and platform admins) approve, reject, or reopen a
  rejected request.

**Good to know**

- Approve only works on drafts that total $0.00. A draft with a price has to
  be completed in Shopify, so the desk can never record a payment that did
  not happen.
- Shopify may send its own order confirmation email when a draft is
  completed. Mark as paid does the same today. That email comes from
  Shopify's notification settings, not from Ordering Desk.
- Shopify deletes a draft after one year with no activity. A rejected request
  kept in Shopify will eventually disappear there. The card stays in the desk
  with its history and is marked "Deleted in Shopify".
- Every open draft in the store becomes a card, including drafts someone
  creates by hand in Shopify admin.
- The desk now shows the first 35 items of an order or request (it was 48),
  so it can also load each item's personalization. Larger orders say so on
  the card, as they do today.
- Requests already waiting in Shopify when this goes live show up quietly,
  with no burst of alerts.
- The status list gets one new entry, **Rejected** (pink, at the end).
  **Approved** becomes the status Approve uses.

**What Ryan does once**

1. Nothing to add for permissions: the IMPACT app already has
   `read_draft_orders`, `write_draft_orders` and `read_companies` (checked
   Oct 4). Optional: in the Shopify Dev Dashboard, set the app's webhook API
   version to 2026-10 and release it.
2. After this ships, in Ordering Desk, Settings > Store connection, press
   **Refresh connection** once. That registers the draft webhooks; until
   then drafts still arrive with the 10 minute sync.

A store whose app lacks the draft permissions keeps working as today, and
platform admins see a reminder on the desk.

**Also in this work:** the app asks Shopify for API version 2025-07, which
Shopify no longer serves. Shopify quietly answers with an older fallback
version, and that fallback changes again on October 16. This work pins the
app to the current version, 2026-10.

---

## Engineering spec

### 0. Owner decisions (binding) and the decisions this spec makes

Binding owner decisions:

- Drafts are first-class cards: Draft badge, draft name (#D12), full detail,
  statuses, notes, timeline, realtime. A new-draft notification (push plus
  branded email) fires because the draft is when a request arrives. The order
  made from a draft never notifies as new.
- APPROVE is manager-only, confirmed in the page, and completes the draft in
  Shopify (the same effect as Mark as paid on a $0 draft). The card becomes
  that order and keeps notes, status history, events and purchase orders.
  Completing the draft in Shopify makes the card follow.
- REJECT is manager-only, needs a reason (saved as a note), moves the card to
  a Rejected status, writes the "Ordering Desk: Rejected" tag on the draft,
  deletes nothing, emails nobody.

Decisions made here (reasons in the sections):

| # | Decision | Section |
|---|---|---|
| D1 | One row per request in `orders` (model A): the draft row becomes the order row, keeping its id. `shopify_order_id` becomes nullable; `shopify_draft_id`, `draft_name`, `draft_snapshot`, `draft_deleted_at` are added. | 2 |
| D2 | Drafts sync in the same run and under the same lease as orders, drafts first, with their own cursor columns. | 5 |
| D3 | Every OPEN and INVOICE_SENT draft becomes a card. COMPLETED drafts are read only to link them to orders. | 5 |
| D4 | A completed draft is linked to its order by whichever signal comes first (draft update, order webhook with a live parent lookup, approve response, hourly check). A true duplicate row is merged into the draft row. | 6 |
| D5 | Two new status links, `draft_completed` and `draft_rejected`. The migration links Approved to `draft_completed` and adds Rejected (pink, last). New workspaces get both. | 8 |
| D6 | Completion from Shopify moves the card to the `draft_completed` status from any status (an explicit exception to "never backward"). | 10 |
| D7 | Approve calls `draftOrderComplete(id)` with no other argument, only for OPEN or INVOICE_SENT drafts that are `ready` and total exactly 0. | 9 |
| D8 | Draft scopes are an optional feature: drafts sync only when `write_draft_orders` is granted. `REQUIRED_SCOPES` does not change. | 14 |
| D9 | Pin Shopify Admin API 2026-10. | 3 |
| D10 | Orders and drafts both fetch cart attributes and line item properties, 35 line items each. Orders: 5 per page (783 points). Drafts: 4 per page (639 points). | 3 |
| D11 | Purchase orders only for order cards. The history import never creates draft rows. | 13 |
| D12 | Drafts already open when the feature turns on are inserted silently (no notification). | 5, 12 |

### 1. Sequencing and ground rules

- Start from `build/m1-core` after the activity bell work is committed
  (it edits notify-adjacent files and the event type list). If Phase 7 (POs)
  or the order history import land first, rebase and apply section 13.
- The migration takes the next free number after every migration on the
  branch at the time it is written (`0008_draft_orders` if nothing else has
  landed). Generate it with `npm run db:generate`, then append the
  hand-written data steps (section 2.3). Never hand-edit the journal. Raise
  the migration pin in `src/server/sync/run.test.ts`.
- Do not stage, commit or deploy from any other branch. Follow the repo's
  existing conventions: relative imports in anything the cron bundle
  reaches, typed results instead of throws in the Shopify layer, every
  runtime value in GraphQL variables, never log payloads or addresses.
- Stage 0 (section 17, task T0) runs read-only checks against the real store
  before the code depends on unverified Shopify behaviour.

### 2. Data model and migration

#### 2.1 Why model A (one row per request)

Every app-facing reference uses the internal `orders.id`: the `?order=` deep
link, realtime events, `events.order_id`, `purchase_orders.order_id`, the
access guard (`resolveOrderAccess`), desk reads and counts, the statuses
in-use guard, notification links and the `notified_at` claim. If the draft
and its order are the same row, all of these keep working unchanged, the
order inherits notes, history and POs with no re-pointing, and the
once-per-row `notified_at` claim guarantees the order never announces again.
A separate drafts table (model B) would need a union or re-pointing in every
one of those places and would change the card's identity under open drawers
and links in emails already sent. The cost of A is one table rebuild, with
precedent (migration 0004 rebuilt `pending_invites` in production).

The card's kind is derived, never stored: `shopifyOrderId === null` means a
draft card; otherwise an order card. A single source of truth means kind and
ids can never disagree.

#### 2.2 Schema (`src/db/schema.ts`)

`orders`:

```ts
export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  // Null while the card is a draft (shopify_draft_id set). Set once, by the
  // attach compare-and-set (src/server/sync/drafts.ts), when Shopify reports
  // the order the draft became.
  shopifyOrderId: text("shopify_order_id"),
  name: text("name").notNull(),           // "#D12" while a draft, the order name after
  shopify: text("shopify", { mode: "json" }).notNull(), // current snapshot: draft, then order
  statusKey: text("status_key").notNull(),
  statusSetBy: text("status_set_by"),
  statusSetAt: integer("status_set_at"),
  createdAt: integer("created_at").notNull(), // the draft's createdAt for a draft-born card; never changed by attach
  syncedAt: integer("synced_at").notNull(),
  notifiedAt: integer("notified_at"),
  // Declared last, matching the physical column order after the rebuild.
  shopifyDraftId: text("shopify_draft_id"),   // legacy numeric draft id
  draftName: text("draft_name"),              // "#D12", kept after the order attaches
  // The draft's normalized snapshot as of the attach, refreshed by later
  // draft updates. Null for cards that never were drafts. Display fallback
  // for request fields on the order card.
  draftSnapshot: text("draft_snapshot", { mode: "json" }),
  // When Shopify reported the open draft gone (delete webhook, a null
  // re-fetch, or the hourly check). The card is kept.
  draftDeletedAt: integer("draft_deleted_at"),
}, (t) => [
  uniqueIndex("order_unique").on(t.workspaceId, t.shopifyOrderId),
  uniqueIndex("order_draft_unique").on(t.workspaceId, t.shopifyDraftId),
  index("order_ws_created").on(t.workspaceId, t.createdAt),
  index("order_ws_status").on(t.workspaceId, t.statusKey),
  // Bare column names on purpose (the rebuild renames __new_orders).
  index("order_open_drafts").on(t.workspaceId, t.createdAt).where(sql`shopify_order_id is null`),
  check("order_source", sql`shopify_order_id is not null or shopify_draft_id is not null`),
]);
```

SQLite UNIQUE allows many NULLs, so open drafts (NULL order id) never collide
in `order_unique`, and plain orders (NULL draft id) never collide in
`order_draft_unique`.

`store_connections`, additive:

```ts
draftSyncCursor: text("draft_sync_cursor"),               // "<ms>|<cursor>", same format as sync_cursor
draftSyncCursorSince: integer("draft_sync_cursor_since"),
draftLastSyncAt: integer("draft_last_sync_at").notNull().default(0), // 0 = first draft sync pending
draftCheckedAt: integer("draft_checked_at").notNull().default(0),    // last full open-draft check
```

`statuses.shopifyLink` enum becomes
`["fulfilled", "delivered", "draft_completed", "draft_rejected"]` (plain text
column, no CHECK since 0004, so no schema change).

`events.type` enum gains `"draft_completed"` and `"draft_deleted"`
(TypeScript only).

#### 2.3 Migration SQL

drizzle-kit generates the `orders` rebuild (`PRAGMA foreign_keys=OFF`,
`CREATE TABLE __new_orders` with the CHECK, `INSERT INTO __new_orders(...)
SELECT ... FROM orders` naming the eleven existing columns, `DROP TABLE
orders`, rename, `PRAGMA foreign_keys=ON`, then the five indexes) and the four
`ALTER TABLE store_connections ADD` statements. Check by hand that:

- the INSERT copies `notified_at` and every other existing column;
- the CHECK and the partial index use bare column names;
- no other table references `orders` by foreign key (true today: `events`
  and `purchase_orders` hold `order_id` as plain text).

Append the hand-written data steps (each ending with
`--> statement-breakpoint`):

```sql
-- Data steps (hand-written). Approved becomes the status Approve uses, in
-- each workspace that has no draft_completed link yet.
UPDATE `statuses` SET `shopify_link` = 'draft_completed'
WHERE `key` = 'approved' AND `shopify_link` IS NULL
  AND NOT EXISTS (SELECT 1 FROM `statuses` s2
                  WHERE s2.`workspace_id` = `statuses`.`workspace_id` AND s2.`shopify_link` = 'draft_completed');
-- A Rejected status at the end of every workspace that has room and none yet.
INSERT INTO `statuses` (`id`, `workspace_id`, `key`, `label`, `color`, `sort`, `triggers_po`, `shopify_link`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
             || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       w.`id`, 'rejected', 'Rejected', 'pink',
       COALESCE((SELECT max(s.`sort`) FROM `statuses` s WHERE s.`workspace_id` = w.`id`), -1) + 1,
       0, 'draft_rejected'
FROM `workspaces` w
WHERE NOT EXISTS (SELECT 1 FROM `statuses` s WHERE s.`workspace_id` = w.`id`
                  AND (s.`key` = 'rejected' OR s.`shopify_link` = 'draft_rejected'))
  AND (SELECT count(*) FROM `statuses` s WHERE s.`workspace_id` = w.`id`) < 20;
```

The id expression yields a UUID-shaped string like the app's own ids.
`20` is `STATUS_LIST_MAX`. Pink is the one color not used by the defaults
for a negative outcome (red is Issue, slate is Delivered), and status colors
always carry their text label.

`DEFAULT_STATUSES` (`src/server/workspaces.ts`) changes to match:
`approved` gets `shopifyLink: "draft_completed"`; append
`{ key: "rejected", label: "Rejected", color: "pink", triggersPo: false, shopifyLink: "draft_rejected" }`.

Production data survives: the rebuild copies every row and column; nothing is
dropped or renamed; old code running during the migration window writes only
columns that still exist.

#### 2.4 The one-row rule, stated once

- A draft row is inserted only for an OPEN or INVOICE_SENT draft that has no
  row (`order_draft_unique`).
- **Attach** is the only way a draft row gets an order id:
  `UPDATE orders SET shopify_order_id = :x, name = :orderName, ... WHERE id = :d AND workspace_id = :ws AND shopify_order_id IS NULL`.
  It is idempotent: if the row already carries `:x`, the caller treats it as
  done. It never changes `id`, `created_at`, `status_*`, `notified_at`.
- If another row O already carries `:x` (an order row inserted before the
  link was known), O is **merged into** the draft row D (section 6.4). D's id
  survives. O is deleted.
- After attach, draft writes touch only `draft_snapshot` and
  `draft_deleted_at` is never set. The order snapshot owns `shopify`.

### 3. Shopify client (`src/server/shopify/client.ts`, `admin.ts`)

#### 3.1 API version

`SHOPIFY_API_VERSION = "2026-10"`. 2025-07 stopped being accessible on
July 16, 2026; Shopify falls forward to the oldest accessible stable version
(2025-10 until October 16, 2026 15:00 UTC, then 2026-01), so production is
already not on 2025-07. All documents in this spec and the existing ones
validate against the Shopify schema validator (which runs a 2026-01 or
2026-04 schema); the research found no 2026-04 to 2026-10 change touching
these fields. Two deprecations to clean up while here: use
`countryCodeV2` instead of `MailingAddress.countryCode` (normalizer reads
`countryCodeV2`, falling back to `countryCode` for stored old shapes);
`Customer.email` stays (deprecated, still present in 2026-10).

Add a diagnostic: when a response's `X-Shopify-API-Version` header differs
from `SHOPIFY_API_VERSION`, log `[shopify] {"apiVersionServed": "<value>"}`
once per isolate. This version bump can ship on its own before October 16 if
the rest of the work is not ready.

#### 3.2 Order selection (changed)

```graphql
      id
      legacyResourceId
      name
      createdAt
      updatedAt
      email
      tags
      note
      sourceName
      displayFinancialStatus
      displayFulfillmentStatus
      customAttributes { key value }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { firstName lastName displayName email }
      shippingAddress { name firstName lastName address1 address2 city provinceCode zip countryCodeV2 }
      fulfillments(first: 3) { displayStatus }
      lineItems(first: 35) {
        nodes { title quantity sku variantTitle customAttributes { key value } originalUnitPriceSet { shopMoney { amount } } }
        pageInfo { hasNextPage }
      }
```

`ORDERS_PER_PAGE = 5`, `LINE_ITEMS = 35` (one constant shared by orders and
drafts, so a draft and the order it becomes list the same lines). Estimator
cost: `3 + 5 * (16 + 4 * 35) = 783` (was 798). Update the pinned assertion
and its comment in `client.test.ts`. Line item properties are documented as
copied to the order on completion, so the order card shows personalization
from its own snapshot; cart attributes fall back to `draft_snapshot`
(whether `note_attributes` carry over is unverified).

#### 3.3 Draft selection (new, `DRAFT_FIELDS`)

Shared by the page query, the single fetch and the approve mutation, so all
three normalize to the same snapshot:

```graphql
      id
      legacyResourceId
      name
      status
      createdAt
      updatedAt
      completedAt
      email
      tags
      note2
      poNumber
      discountCodes
      customAttributes { key value }
      order { id legacyResourceId name }
      customer { firstName lastName displayName email }
      purchasingEntity {
        __typename
        ... on PurchasingCompany { company { id name } location { id name } }
      }
      shippingAddress { name firstName lastName company address1 address2 city provinceCode zip countryCodeV2 phone }
      appliedDiscount { title value valueType }
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      lineItems(first: 35) {
        nodes { title quantity sku variantTitle custom customAttributes { key value } originalUnitPriceSet { shopMoney { amount } } }
        pageInfo { hasNextPage }
      }
```

Left out on purpose: `product` and `variant` (need `read_products`),
`paymentTerms` (needs `read_payment_terms`), `image` and per-line discounted
totals (cost; the draft-level totals and discount are shown instead),
`ready` (changes while Shopify calculates and would churn the snapshot; it
is read fresh at approve time), deprecated money fields.

```graphql
query DraftOrdersUpdatedSince($cursor: String, $search: String) {
  draftOrders(first: 4, after: $cursor, sortKey: UPDATED_AT, query: $search) {
    nodes { ...DRAFT_FIELDS spliced as in ORDERS_QUERY }
    pageInfo { hasNextPage endCursor }
  }
}
```

`DRAFTS_PER_PAGE = 4`, `MAX_DRAFT_PAGES = 100` (400 drafts per run). Estimator
cost `3 + 4 * (19 + 4 * 35) = 639` (the estimator prices the
`... on PurchasingCompany` fragment as an object, which overstates Shopify's
"maximum of possible selections" rule by 1 per draft). Five per page would
be 798, at the edge; four leaves room for any manual field cost Shopify sets,
and drafts are far fewer than orders. Add a pinned test like the orders one.

Single fetch (webhooks): `query DraftOrderById($id: ID!) { draftOrder(id: $id) { DRAFT_FIELDS } }`
(about 159 points).

Search strings (variables, never spliced):

- first draft sync: `FIRST_DRAFT_SEARCH = "status:open OR status:invoice_sent"`
- every later window: `updated_at:>='<since ISO>'` with no status filter
  (a status filter would miss completions).

#### 3.4 Draft link lookup and open-draft check (new)

```graphql
query DraftLinks($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on DraftOrder { id legacyResourceId status updatedAt order { id legacyResourceId name } }
  }
}
```

`DRAFT_LINK_CHUNK = 100` ids per request. A deleted draft comes back as
`null` in its position. Returns, per requested id:
`{ kind: "open" | "completed" | "gone", orderId?, orderName? }`.

#### 3.5 Tags for either kind (replaces `ORDER_TAGS_QUERY`)

```graphql
query StatusTags($id: ID!) {
  node(id: $id) {
    ... on Order { id tags }
    ... on DraftOrder { id tags }
  }
}
```

`tagsAdd` and `tagsRemove` accept a `DraftOrder` id unchanged. Never use
`draftOrderUpdate` for tags (it overwrites all tags, and updating a draft
with a started checkout unlinks the checkout).

#### 3.6 Approve documents

```graphql
query DraftBeforeApprove($id: ID!) {
  draftOrder(id: $id) {
    id name status ready completedAt
    order { id legacyResourceId name }
    totalPriceSet { shopMoney { amount currencyCode } }
  }
}

mutation ApproveDraft($id: ID!) {
  draftOrderComplete(id: $id) {
    draftOrder { DRAFT_FIELDS }
    userErrors { field message }
  }
}
```

The variables sent are exactly `{ id }`. Never `paymentGatewayId`, never
`sourceName`, never `paymentPending` (deprecated; its default false is what
Mark as paid does).

#### 3.7 Fetch generalization

Refactor `fetchOrdersUpdatedSince` into one page loop parameterized by a feed
`{ query, rootField: "orders" | "draftOrders", maxPages }`, keeping every
existing behaviour (truncation, resume cursor, retryable rules, `maxUpdatedAt`
from `node.updatedAt`, auth, fatal in Shopify's words, token scrubbing).
Export two thin wrappers:

- `fetchOrdersUpdatedSince(shop, token, sinceIso, fetchImpl, opts)` (unchanged signature)
- `fetchDraftsUpdatedSince(shop, token, sinceIso | null, fetchImpl, opts)`
  where `null` means `FIRST_DRAFT_SEARCH`.

New in `admin.ts`: `fetchDraftNode`, `fetchDraftLinks(ids)`,
`fetchStatusTags(gid)` (replaces `fetchOrderTags`), `completeDraft(id)` and
`fetchDraftForApprove(id)`, all returning the existing `AdminFailure` union.

### 4. Normalization (`src/server/shopify/normalize.ts`)

Both shapes are built with keys in one fixed order (the snapshot compare is
`JSON.stringify` equality). Text passes through untouched; rendering escapes.

```ts
export type Attribute = { key: string; value: string };
export type Item = {
  title: string; qty: number; price: string | null; sku: string; variant: string;
  props: Attribute[];                 // line item customAttributes, Shopify's order
};

export type NormalizedOrder = {
  kind: "order";
  shopifyOrderId: string;
  name: string;
  createdAt: number;
  customerName: string;
  email: string;
  total: string;
  currency: string;
  financialStatus: string;
  fulfillmentStatus: string;
  delivered: boolean;
  items: Item[];
  itemsTruncated: boolean;
  shipping: Shipping | null;
  tags: string;
  note: string;
  sourceName: string;
  attributes: Attribute[];            // order customAttributes (cart attributes)
};

export type NormalizedDraft = {
  kind: "draft";
  shopifyDraftId: string;             // legacyResourceId, else the gid tail
  name: string;                       // "#D12"
  status: "open" | "invoice_sent" | "completed";
  createdAt: number;
  completedAt: number | null;
  orderId: string | null;             // legacy id of the order it became
  orderName: string | null;
  customerName: string;               // displayName, else first + last, else shipping name
  email: string;                      // draft email, else customer email, lowercased
  company: string;                    // purchasingEntity PurchasingCompany company.name, else ""
  location: string;                   // ... location.name, else ""
  attributes: Attribute[];
  discountCodes: string[];
  discount: { title: string; value: string; valueType: string } | null;
  subtotal: string;
  discounts: string;
  total: string;
  currency: string;
  items: (Item & { custom: boolean })[];
  itemsTruncated: boolean;
  shipping: (Shipping & { company: string; phone: string }) | null;
  tags: string;                       // joined with ", " like orders
  note: string;                       // note2
  poNumber: string;
};
```

Rules:

- Status: `OPEN` to `open`, `INVOICE_SENT` to `invoice_sent`, `COMPLETED`
  to `completed`, anything else `open`.
- Attributes and props keep Shopify's order, drop entries with an empty key,
  read a null value as `""`, cap key at 200 and value at 2,000 characters,
  at most 50 attributes and 30 props per item. Underscore keys (`_pdf`,
  `_pplr...`) are kept: hiding them is a display decision (section 11.4).
- Money amounts are strings as today; `discount.value` is
  `String(number)`.
- A snapshot without `kind` (stored before this change) reads as an order
  everywhere. Add `snapshotKind(snapshot)` and use it instead of ad hoc
  checks.
- `normalizeDrafts(payload)` accepts a nodes array or a raw
  `{data:{draftOrders}}` response, like `normalizeOrders`.

### 5. Sync engine (`src/server/sync/run.ts`, new `src/server/sync/drafts.ts`)

#### 5.1 Shape of a run

Decision D2: one run, one lease, two phases with the same `now`, drafts
first. Reasons: the claim rule (`synced_at` stamped with the run's start
time) stays coherent because both phases stamp the same `now`; the drafts
phase usually attaches a completion before the orders phase fetches that
order, so the order lands as an update of the draft row; and there is still
one fenced terminal write. Drafts need their own cursor columns because the
resume token and terminal write describe a single fetch.

```
runSync:
  lease, token (unchanged)
  draftsOn = draftsEnabled(connection.scopes)           // section 14
  draft = draftsOn ? await runDraftPhase(ctx) : null
    auth       -> return like today's order auth case
    superseded -> return superseded (nothing written)
    failed     -> remember draft.error; draft.terminal holds only cursor cleanup
  orders phase (today's code) with two changes:
    - unknown orders go through the parent lookup (6.2) before insert
    - every fenced terminal or early-return write spreads draft.terminal,
      so draft progress is kept even when the orders feed fails
  ensureOrderSnapshots (6.5)
  terminal lastError = ordersError ?? (draft.error ? "Drafts: " + draft.error : null)
```

`SyncResult` gains `mergedOrders?: { fromId: string; toId: string }[]`.
`addedOrderIds` includes new draft rows (so `notifyNewOrders` and the
broadcast work unchanged); `updatedOrderIds` includes draft snapshot
changes, attaches and deletions; `statusChanges` includes completion moves.

#### 5.2 `runDraftPhase`

1. Window:
   - `first = connection.draftLastSyncAt === 0`
   - `resume = parseResumeToken(connection.draftSyncCursor)`,
     `resuming = resume !== null && typeof connection.draftSyncCursorSince === "number"`
   - `sinceMs = resuming ? draftSyncCursorSince : first ? 0 : max(draftLastSyncAt - OVERLAP_MS, 0)`
   - search: `first ? FIRST_DRAFT_SEARCH : updated_at window`. Because
     `draftLastSyncAt` stays 0 until the first chain completes, a resumed
     first chain keeps the same search its cursor belongs to.
2. `fetchDraftsUpdatedSince`. Results map like the orders phase: `auth`
   ends the run; `transient` leaves the draft cursor and anchor untouched;
   `fatal` also clears a resumed draft cursor and writes one `sync_error`
   event per text per hour (existing dedupe, text prefixed "Drafts: ").
3. `holdsLease` after the fetch, between existence chunks, and once before
   the writes, as the orders phase does.
4. `claimAndLoadDrafts(db, ws, draftIds, now, into)`: same claim-then-read
   rule as `claimAndLoad`, keyed by `shopify_draft_id`, loading
   `{ id, shopifyOrderId, shopify, draftSnapshot, draftDeletedAt }`. For
   completed drafts whose draft id has no row, also run the existing
   `claimAndLoad` on their order ids (for the backfill case below).
5. For each normalized draft, `writeDraftSnapshot` (5.3).
6. Open-draft check (6.6) when `now - draftCheckedAt >= DRAFT_CHECK_EVERY_MS`
   (1 hour).
7. Terminal fields, exactly mirroring the orders rules: truncated sets
   `draftSyncCursor = resumeToken(windowOpenedAt, endCursor)` and
   `draftSyncCursorSince = sinceMs`; complete sets `draftLastSyncAt` to the
   window-open anchor and clears the cursor; `draftCheckedAt = now` when the
   check ran to completion.

#### 5.3 `writeDraftSnapshot(db, ws, draft, now, statusRows, known, opts)`

| Row state | Draft status | Action | Outcome |
|---|---|---|---|
| no row | open / invoice_sent | Insert row (`shopifyOrderId: null`, `shopifyDraftId`, `draftName = name = draft.name`, `shopify = draft`, `statusKey = initialStatusFor(draft)`, `createdAt = draft.createdAt or now`, `syncedAt = now`, `notifiedAt = opts.silent ? now : null`) plus an `order_new` event with id `evt-draft-new-${ws}-${draftId}`, text `New request ${name} from ${customerName}` (or without "from" when empty), meta `{ orderName: name, kind: "draft" }`, source shopify. Both conflict no-ops, one batch. Conflict: claim, load, continue as known. | `added` |
| no row | completed | If a row carries `shopify_order_id = draft.orderId` and `shopify_draft_id IS NULL`: backfill `shopify_draft_id`, `draft_name`, `draft_snapshot` on it (guarded on `shopify_draft_id IS NULL`). Otherwise skip: the order path makes its card and announces it once as a new order. | `none` (backfill counts as `updated`) |
| row, not attached | open / invoice_sent | If the snapshot changed: `UPDATE orders SET shopify = :draft, synced_at = :now WHERE id = :d AND synced_at <= :now AND shopify_order_id IS NULL`. A draft row with `draft_deleted_at` set that reappears: clear `draft_deleted_at` in the same update (Shopify answered for it). | `updated` (transition before/after) |
| row, not attached | completed, `orderId` set | Attach (6.1) with `completedDraft = draft`. | `attached` (transition before = stored draft, after = completed draft) |
| row, attached | any | If `draft_snapshot` differs, write `draft_snapshot` only. | `none` |

`opts.silent` is true during the first draft sync (decision D12): those
requests were already sitting in Shopify, so the feature turning on must not
send a burst of alerts. The same option is used by the history import
(section 13).

#### 5.4 Webhook path: `upsertFetchedDraft(db, ws, draft, now, link)`

Claims with `claimAndLoadDrafts` for the one id, calls `writeDraftSnapshot`,
evaluates transitions for `updated` and `attached`, and returns
`added | updated | attached (with orderGid, merged?) | unchanged`. `now` is
taken before the fetch, as for orders.

### 6. Linking a draft to its order

The order carries no reference to its draft (verified: no field on Order or in
the orders/create payload). Only `DraftOrder.order` links them. Four signals
can link them, in any order, and every one goes through the same attach.

#### 6.1 `attachOrderToDraft(db, ws, { draftRowId, orderId, orderName, completedDraft? , now, source, actorId? })`

One batch:

1. `UPDATE orders SET shopify_order_id = :orderId, name = :orderName, draft_snapshot = COALESCE(:completedDraftJson, shopify), shopify = COALESCE(:completedDraftJson, shopify), synced_at = max(synced_at, :now) WHERE id = :d AND workspace_id = :ws AND shopify_order_id IS NULL`
2. the event `evt-draft-order-${ws}-${draftId}` as an insert-select that
   yields its row only when the row now carries `:orderId`, ignoring a
   duplicate id (`INSERT OR IGNORE`, so whichever signal attached first
   writes it once): type `draft_completed`, text
   `Order ${orderName} created from draft ${draftName}`, meta
   `{ orderName, draftName, shopifyOrderId }`, source `app` with the actor
   when approved in the desk, else `shopify` with no actor.

Results:

- `attached`: statement 1 changed one row.
- `already`: no change and the row carries `:orderId`.
- `conflict`: statement 1 failed on `order_unique` (another row O has it):
  merge (6.4), then report `attached` with `merged`.
- `missing` / `other`: row gone or attached to a different order (should not
  happen; log the ids only, write nothing).

`max(synced_at, :now)` never moves the claim stamp backwards. Attach is not
guarded on `synced_at` because it records a fact; a newer run's draft write
is then refused by its own `shopify_order_id IS NULL` guard.

#### 6.2 Order arrives first: parent lookup

In both the sync orders phase and `upsertFetchedOrder`, after the claim, an
order with no row (unknown) is checked before it is inserted, when drafts are
enabled and **candidates** exist:

- candidates: rows with `shopify_order_id IS NULL AND draft_deleted_at IS NULL
  AND created_at <= max(order.createdAt of the unknown orders)`, newest first,
  at most `DRAFT_LINK_MAX_CANDIDATES = 200` (two requests of 100).
- `fetchDraftLinks(candidate gids)`; for each candidate:
  - `completed` with an order id among the unknown orders: attach (6.1, no
    completed draft snapshot, so `shopify` keeps the stored draft snapshot);
    put `orderId -> { id: draftRowId, shopify: storedDraftSnapshot }` into
    the known map, so `writeOrderSnapshot` takes the update path with
    `before = open draft` and the completion move fires (section 10);
  - `completed` with another order id: attach too (6.5 loads its order);
  - `gone`: mark deleted (6.3).
- Lookup failure:
  - webhook path: write nothing for that order, log
    `{ topic, error: "draft link lookup failed" }`, return `deferred`. The
    cron sync lands it within 10 minutes.
  - sync orders phase: treat as a transient orders-feed failure (no order
    writes this run, orders cursor and anchor untouched, draft progress kept,
    `lastError` "Could not check which draft an order came from: <detail>").
- No candidates, or no match: insert as a new order (announced as today).

This lookup reads live objects, not the search index, so a draft completed a
second ago is found.

#### 6.3 Deletion: `markDraftDeleted(db, ws, draftId, now)`

One batch: `UPDATE orders SET draft_deleted_at = :now WHERE workspace_id = :ws
AND shopify_draft_id = :draftId AND shopify_order_id IS NULL AND
draft_deleted_at IS NULL`, plus an insert-select event (yields its row only
when the row now has `draft_deleted_at = :now`): id
`evt-draft-deleted-${ws}-${draftId}`, type `draft_deleted`, text
`Draft ${draftName} was deleted in Shopify. This card and its history are kept.`,
source shopify. Attached rows are ignored ("Deleting a completed draft
order doesn't delete the order"). Unknown draft ids are ignored. Status is
not changed. Approve is refused from then on.

Sources: the `draft_orders/delete` webhook (payload `{ id }` only), a
webhook re-fetch that returns `null`, the approve pre-check returning
`null`, the parent lookup or the hourly check returning `null`.

#### 6.4 Merge: `mergeOrderIntoDraft(db, ws, { draftRowId: D, orphanId: O, orderId: X, orderName, completedDraft? })`

Only when O has `shopify_order_id = X` and `shopify_draft_id IS NULL`. One
batch, in this order:

1. `DELETE FROM events WHERE id = 'evt-order-new-' || :ws || '-' || :x` (the
   orphan's "New order" entry; D already has its request entry).
2. `UPDATE events SET order_id = :d WHERE workspace_id = :ws AND order_id = :o`
3. `UPDATE purchase_orders SET order_id = :d WHERE workspace_id = :ws AND order_id = :o`
4. `UPDATE orders SET shopify = (SELECT shopify FROM orders WHERE id = :o), notified_at = COALESCE(notified_at, (SELECT notified_at FROM orders WHERE id = :o)), synced_at = max(synced_at, (SELECT synced_at FROM orders WHERE id = :o), :now) WHERE id = :d AND shopify_order_id IS NULL`
5. `DELETE FROM orders WHERE id = :o AND workspace_id = :ws AND shopify_order_id = :x AND shopify_draft_id IS NULL`
6. `UPDATE orders SET shopify_order_id = :x, name = :orderName, draft_snapshot = :draftJson WHERE id = :d AND shopify_order_id IS NULL`
   where `:draftJson` is the completed draft snapshot when the caller has
   one, else D's stored draft snapshot (its `shopify` value, read before the
   batch; statement 4 has replaced `shopify` by then)
7. the `draft_completed` event (6.1 statement 2).

If O changed in between, statement 5 deletes nothing and statement 6 trips
`order_unique`, so the whole batch rolls back; the next signal retries. D
keeps its status (the team's choice while it was a draft); the completion
move then applies (before = D's draft snapshot, after = the order snapshot).
After the batch, broadcast `{ kind: "order.merged", fromId: O, toId: D }`.

#### 6.5 `ensureOrderSnapshots`

Rows attached this run whose `shopify` is still a draft snapshot and whose
order was not written by the orders phase: `fetchOrderNode` plus
`upsertFetchedOrder`, at most `ENSURE_ORDER_MAX = 20` per run (the rest wait
for the next run's window). The webhook draft job does the same for its one
row right after attaching.

#### 6.6 Hourly open-draft check

`fetchDraftLinks` over every unattached, not deleted draft row (newest first,
up to 1,000, chunks of 100): `gone` marks deleted, `completed` attaches.
This catches deletions the cron cannot see (and Shopify's one-year purge,
which may send no webhook) and completions whose signals were all missed.

#### 6.7 Arrival orders, summarized

| What arrives first | What happens |
|---|---|
| `draft_orders/update` (completed) | Draft job attaches with the completed snapshot, completion move, then fetches and writes the order. The later `orders/create` finds the row known: update, no notification. |
| `orders/create` | Order job's parent lookup finds D completed with this order: attach, write the order snapshot onto D, completion move. The later draft update is an attached row: `draft_snapshot` only. |
| Both at once | Attach is a compare-and-set; the loser sees `already`. Deterministic event ids prevent duplicate entries. |
| Approve in the desk | The approve route attaches from the mutation response before any webhook arrives (section 9). |
| Both webhooks lost | The next cron run: drafts phase attaches (completion is in the window), orders phase writes the order onto D. |
| Orphan row exists (lookup capped, or the race in 18.1) | Attach reports `conflict`, merge, `order.merged` broadcast. |

### 7. Webhooks and registration

#### 7.1 Receiver (`src/server/shopify/webhooks.ts`)

- `DRAFT_TOPICS = new Set(["draft_orders/create", "draft_orders/update", "draft_orders/delete"])`,
  accepted next to the existing sets. HMAC, shop domain check and
  `webhook_deliveries` dedupe are reused unchanged.
- `gidOf` accepts type `"DraftOrder"`. The delete payload has only `id`
  (number); the numeric fallback builds `gid://shopify/DraftOrder/<id>`.
- Jobs: `{ kind: "draft"; draftGid }` and `{ kind: "draft-deleted"; draftId }`.
- `runJob` for `draft`: token, `fetchDraftNode`; `null` means deleted
  (`markDraftDeleted`); otherwise normalize, `stillConnected`, skip if drafts
  are not enabled for the stored scopes, `upsertFetchedDraft`, then:
  - `added`: `broadcastSync` and `notifyNewOrders([id])`
  - `updated`: `broadcastSync` and `shareShopifyMoves`
  - `attached`: `broadcastSync`, merged broadcast if any, `shareShopifyMoves`,
    then `fetchOrderNode` plus `upsertFetchedOrder` and another
    `broadcastSync` (never a notification: that write is an update)
- `runJob` for `draft-deleted`: `markDraftDeleted`, broadcast the row as
  updated and the event as `order.activity`, `notifyActivity`.
- `runJob` for orders: `upsertFetchedOrder` gains `link?: { shopDomain, token, fetchImpl }`
  and the outcomes `attached` and `deferred` (section 6.2).

#### 7.2 Registration (`admin.ts`, `connection.ts`)

- Split `WEBHOOK_TOPICS` into `BASE_WEBHOOK_TOPICS` (the 10 today) and
  `DRAFT_WEBHOOK_TOPICS = ["DRAFT_ORDERS_CREATE", "DRAFT_ORDERS_UPDATE", "DRAFT_ORDERS_DELETE"]`.
  `webhookTopicsFor(scopes)` returns the base list, plus the draft list
  appended at the end when drafts are enabled. Shopify refuses draft
  subscriptions without the scope, and `replaceWebhookSubscriptions` stops at
  the first refusal, so draft topics must never be requested for a store
  without the scope, and must come last.
- `replaceWebhookSubscriptions(shop, token, callbackUrl, topics, fetchImpl)`
  takes the list. `saveConnection` passes `webhookTopicsFor(check.accessScopes)`.
- `saveConnection` resets the draft columns exactly like the order ones on a
  store change: `draftLastSyncAt` and `draftCheckedAt` to 0 and the draft
  cursor to null unless it is the same shop.

#### 7.3 Refresh connection (new)

`POST /api/workspaces/[id]/connection/refresh`, platform admins only (same
guard as `PUT .../connection`). Service `refreshConnection(db, env, ws, ctx)`:

1. No connection or disabled: 409 "Connect the store first."
2. client_credentials: `getAccessToken(..., { forceRenew: true })` (new
   option in `token.ts`: ignore the cached token and mint, keeping the
   compare-and-set cache write), so the token carries newly approved scopes.
   legacy_token: the stored token.
3. `testShopConnection`: `auth` gives 409 "Shopify rejected the store
   credentials. Reconnect the store in Settings."; `transient` gives 502 with
   the detail.
4. Save `scopes` (`WHERE workspace_id = :ws AND status <> 'disabled'`).
5. Missing required scopes: a `warning` naming them (the store stays
   connected).
6. client_credentials with `APP_URL`: `replaceWebhookSubscriptions` with
   `webhookTopicsFor(scopes)`; success sets `webhooksRegisteredAt = now`;
   failure adds the warning "Webhooks were not registered: <detail>".
7. 200 `{ connection: ConnectionSettingsView, warning? }`.

The first sync after drafts become enabled runs the first draft sync by
itself (`draftLastSyncAt = 0`).

### 8. Statuses

#### 8.1 Links

`SHOPIFY_LINKS = ["fulfilled", "delivered", "draft_completed", "draft_rejected"]`
(`src/server/desk/statuses.ts`). The "one status per link" loop and the
in-use guard cover the new values with no other change. Error text becomes
"the Shopify link must be fulfilled, delivered, draft completed, draft
rejected or none". `StatusView.shopifyLink` and `StatusRow.shopifyLink` widen
to the same union.

- `draft_completed`: where Approve puts a request, and where a request goes
  when its draft is completed in Shopify. On an order card it has no Shopify
  effect beyond the tag (today's Approved behaviour, including triggersPo).
- `draft_rejected`: where Reject puts a request. Not a Shopify state; the
  link only marks which status Reject uses. The tag shows it in Shopify.

Settings (`src/components/settings/statuses.tsx`) link options:
"No Shopify link", "Fulfilled in Shopify", "Delivered in Shopify",
"Draft approved (order created)", "Draft rejected". Add to the help copy:
"For draft orders: Approve moves a request into the status linked to Draft
approved and creates the order in Shopify; completing the draft in Shopify
does the same. Reject moves it into the status linked to Draft rejected."

#### 8.2 Rules (`changeOrderStatus`, `src/server/desk/mutations.ts`)

`MutationContext` gains `role: Role`; the status route passes the role from
`requireMemberByOrder`. The order lookup also reads `shopifyOrderId` and the
current status's link. New result kind `forbidden` (route answers 403).

| Card | Target status link | Result |
|---|---|---|
| draft | `fulfilled` / `delivered` | 400 "A draft cannot be marked <label> until it is approved and becomes an order." |
| draft | `draft_completed` | 400 "Use Approve to approve this request. It creates the order in Shopify." |
| draft | `draft_rejected` | 400 "Use Reject to reject this request. It asks for a reason." |
| draft, currently in a `draft_rejected` status, caller staff | any | 403 "Only a manager can reopen a rejected request." |
| draft | none | allowed (staff and up) |
| order | `draft_rejected` | 400 "Rejected is for requests that were not approved. An order cannot be rejected." |
| order | anything else | allowed, as today |

`triggersPo` in the response is `status.triggersPo && card is an order`.

### 9. Approve and Reject

Both live in `src/server/desk/review.ts` (service, injectable fetch and
clock) behind `POST /api/orders/[orderId]/approve` and
`POST /api/orders/[orderId]/reject`. Routes guard with
`requireMemberByOrder(orderId, "staff")` (outsiders get the same 404 as
today) and then require `roleAtLeast(role, "manager")`, else 403 "Only a
manager can approve or reject requests." Platform admins pass (role
`platform`).

#### 9.1 Approve

Preconditions, in order (each a 409 with the copy in section 15 unless
noted):

1. Row is a draft: if it already has `shopifyOrderId`, answer 200
   `{ kind: "already-approved", ... }` (double click, retry).
2. `draft_deleted_at` is null.
3. A status with link `draft_completed` exists.
4. Drafts are enabled for the stored scopes.
5. `fetchDraftForApprove`:
   - transport failure: 502.
   - `null`: `markDraftDeleted`, then 409.
   - `COMPLETED` with an order: someone completed it in Shopify. Attach
     (source shopify) and apply the completion move through
     `evaluateShopifyTransitions`; answer 200 `{ kind: "completed-in-shopify", orderName }`.
   - total amount not exactly zero (`Number(amount) !== 0`): 409; the
     mutation is never called.
   - `ready` false: re-query up to 3 times, 500 ms apart; still false gives
     409.
   - `OPEN` or `INVOICE_SENT`: continue.
6. `completeDraft(id)`:
   - `ok` with `draftOrder.order`: continue to 7.
   - userErrors containing "not finished calculating": wait 500 ms,
     re-check `ready`, try once more.
   - other userErrors: re-query the draft. `COMPLETED` with an order: treat as
     success (another approve or a Shopify user won the race). Otherwise 409
     with Shopify's words.
   - timeout or transport failure: re-query, never blind-retry. `COMPLETED`:
     success. `OPEN`: 502 "Shopify did not confirm the approval. Nothing
     changed. Try again." Re-query also failed: 502 "Shopify did not answer.
     Check the draft in Shopify before trying again. The card updates on the
     next sync."
7. Commit, one batch:
   1. attach (6.1 statement 1) with the completed draft snapshot normalized
      from the mutation's `draftOrder`;
   2. `UPDATE orders SET status_key = :approvedKey, status_set_by = :actor, status_set_at = :now WHERE id = :d AND workspace_id = :ws AND shopify_order_id = :x AND status_key <> :approvedKey AND <status still exists>`
      (no from-key compare: approval is decisive, including from Rejected);
   3. status event insert-select, yielding only when the row now carries this
      move: type `status`, actor, source app, text
      `Approved the request. Status set to ${label}`, meta
      `{ from, to, action: "approve", orderName }`;
   4. the `draft_completed` event (6.1 statement 2) with the actor.

   If statement 1 trips `order_unique` (an orphan row exists): merge (6.4),
   then run the batch again once.
8. Respond 200:
   `{ kind: "approved", order: { id, statusKey, statusSetBy, statusSetAt }, orderName, shopifyOrderId, events: EventView[], triggersPo }`
   where `triggersPo` is the approved status's flag (the card is an order
   now, so Phase 7's review opens right after approval).
9. After the response (`ctx.waitUntil`): broadcast `order.status`,
   `orders.synced` with the row as updated, and `order.activity` for the
   `draft_completed` event; `notifyActivity(statusEvent)`; `fetchOrderNode` plus
   `upsertFetchedOrder` (order snapshot onto D, no notification); then
   `pushAndShare` (tags the ORDER "Ordering Desk: Approved", replacing the
   tag inherited from the draft).

Money: a $0 draft completed with no gateway and no pending flag is marked
paid with nothing captured, which is what Mark as paid does. Completion
commits inventory. Shopify may send its order confirmation email to the
buyer, per the store's notification settings (the Help Center says Mark as
paid does); the desk cannot suppress it and sends nothing itself.

Idempotency summary: double click returns `already-approved`; two managers
at once both call Shopify, one completion succeeds, the other re-queries and
finds COMPLETED; the status update and both events are guarded or
deterministic, so nothing is duplicated.

#### 9.2 Reject

Body `{ reason }`, trimmed, 1 to `NOTE_MAX` characters, else 400 "Give a
reason (up to 4000 characters). It is saved as a note."

1. Row attached: 409. A status with link `draft_rejected` missing: 409.
2. One batch:
   1. `UPDATE orders SET status_key = :rejectedKey, status_set_by = :actor, status_set_at = :now WHERE id = :d AND workspace_id = :ws AND shopify_order_id IS NULL AND status_key <> :rejectedKey AND <status still exists>`
   2. status event insert-select (yields only on the move): text
      `Rejected the request. Status set to ${label}`, meta
      `{ from, to, action: "reject" }`, actor, source app
   3. note event insert-select (yields only on the move): text = the
      reason, meta `{ rejectReason: true }`, actor, source app
3. Statement 1 changed nothing: re-read. Attached: 409. Already in the
   rejected status: 200 `{ kind: "unchanged" }` (no second note). Status
   gone: 409.
4. Respond 200 `{ kind: "rejected", order, events }`.
5. After the response: broadcast `order.status` and `order.note`;
   `notifyActivity(statusEvent)` only (one push per action; a note's text
   never goes into a push anyway); `pushAndShare`, which writes
   "Ordering Desk: Rejected" on the DraftOrder (section 10.2).

Rejecting a draft already deleted in Shopify is allowed (it records the
team's decision); the tag push is skipped for deleted drafts. Nothing is
deleted anywhere and no email is sent.

### 10. Status sync both ways (`src/server/shopify/status-sync.ts`)

#### 10.1 Shopify to app

Helpers: `snapshotKind(s)`, `draftOpen(s)` (kind draft and status not
completed), `completedNow(before, after)` = `draftOpen(before) &&
(snapshotKind(after) === "order" || after.status === "completed")`.

`decideShopifyMove`, in order:

1. **Completion.** If `completedNow(before, after)`: the target is the status
   for `shopifyStateOf(after)` when the order is already fulfilled or
   delivered, else the `draft_completed`-linked status. Move if the target
   exists and differs from the current status, from any status (decision
   D6: a completed draft is a fact that supersedes whatever the team had
   while it was a request, and a Rejected or Issue draft must not stay stuck
   because it sorts after Approved). Tag edits in the same change are
   ignored. Reason `"completed"` (or `fulfilled` / `delivered`); text
   `Status set to ${label}: the draft was completed in Shopify as order ${orderName}`.
   Return.
2. **Tag edit** (today's rule) with the added statuses filtered by the
   after snapshot's kind: a draft ignores statuses linked to `fulfilled`,
   `delivered` or `draft_completed` (they describe an impossible state) and
   accepts `draft_rejected` (two-way tags are the platform rule; the
   timeline shows it came from Shopify, without a reason); an order ignores
   `draft_rejected`.
3. **Fulfillment rise** (today's rule; drafts have no fulfillment state).

`mightMove` also returns true for `completedNow`. `initialStatusFor` for a
draft: the one status its tag names if allowed for drafts, else the first
status in sort order with no link, else the first status.

Inherited tags: draft tags become order tags on completion. Because the
transition into the order always has a draft snapshot as `before` (the stored
one, carrying the same tags), an inherited tag is never an "added" tag, and
rule 1 wins in the completion change itself.

#### 10.2 App to Shopify (`pushOrderStatus`)

- Read `shopifyOrderId`, `shopifyDraftId`, `draftDeletedAt`. Target
  `gid://shopify/Order/<id>` when attached, else
  `gid://shopify/DraftOrder/<draftId>`. A deleted draft: stop with no event.
- `fetchStatusTags` (node query) replaces `fetchOrderTags`; "Shopify no
  longer has this order" becomes "... this draft" for drafts.
- Fulfill only for order targets.
- Echo safety is unchanged: the desk's own tag write on a draft comes back as
  `draft_orders/update` naming the current status, which moves nothing.

### 11. Desk UI

#### 11.1 Read model (`src/server/desk/read.ts`, `shapes.ts`)

`OrderSummary` adds:

```ts
kind: "draft" | "order";
draftName: string | null;      // a draft's name, or the draft an order came from
draftStatus: "open" | "invoice_sent" | "completed" | null;
draftDeleted: boolean;
company: string;               // draft snapshot (or draft_snapshot on order cards)
location: string;
requestFor: string;            // "For Employee Name" attribute
branch: string;                // "Ship to Branch" attribute, else location
searchText: string[];          // draftName, company, location, requestFor, branch
```

Request fields read the current snapshot's attributes first, then
`draft_snapshot`. The headline attribute keys live in one module,
`src/lib/request-fields.ts`:

```ts
export const HEADLINE_ATTRIBUTES = [
  { field: "requestFor", match: /^for employee name$/i },
  { field: "branch", match: /^ship to branch$/i },
] as const;
```

`DeskPayload` adds `draftCount` (rows with `shopify_order_id IS NULL`) and
`drafts: { enabled: boolean; missingScopes: string[] }` (from the stored
scopes). `getOrderDetail` already returns the whole row; the drawer type
`DrawerOrder` gains `shopifyOrderId: string | null`, `shopifyDraftId`,
`draftName`, `draftSnapshot`, `draftDeletedAt`.

#### 11.2 List and filters

- Rows and phone cards: a **Draft** chip (neutral tone, text label) beside
  the mono name; a **Deleted in Shopify** chip (warning tone) when
  `draftDeleted`; a muted line `For <requestFor> · <branch>` when present
  (use a middle dot or a comma, not a dash). Order cards from drafts show
  `from draft #D12` under the name.
- Toolbar: a segmented control **All / Drafts / Orders** (`DeskFilter.kind`,
  default `all`), shown when `drafts.enabled` or `draftCount > 0`. It
  composes with the status strip (Drafts plus New is the review queue).
  Label "Drafts (n)" with `draftCount`. Strip counts stay workspace-wide.
- Search matches `searchText` too.
- The live "new order" toast (desk.tsx `announcement`) says
  `New request #D12 from <name>` for draft rows; mixed batches say
  `n new orders and requests`.

#### 11.3 Drawer

Draft card:

- Header: `<span class="sr-only">Draft order </span>#D12` in mono, the Draft
  chip, the Deleted chip if any, "Submitted <date>", and a draft status chip
  ("Open" or "Invoice sent") in place of the financial and fulfillment chips.
- Controls: the status select (options per 11.5), **Open in Shopify** using
  `shopifyAdminDraftUrl` (`https://admin.shopify.com/store/<handle>/draft_orders/<legacyDraftId>`,
  new in `src/lib/format.ts`).
- Review row (managers and platform admins only): **Approve** (primary) and
  **Reject** (secondary, danger text). Staff see "Waiting for a manager to
  approve or reject." Disabled states with their reason: deleted ("Shopify no
  longer has this draft"), no `draft_completed` status ("Set a status to
  follow Draft approved in Settings > Statuses"), drafts not enabled.
- Approve opens an inline confirmation (reuse `ConfirmStep`; move it from
  `settings/kit.tsx` to a shared component): "Approve request #D12? Shopify
  completes the draft at $0.00 and creates the order, the same as Mark as
  paid. Shopify may email its order confirmation to <email>." Buttons
  "Approve and create order" / "Cancel"; busy label "Approving...". Errors
  inline with `role="alert"`. Success toast: "Approved. Order #1234 created
  in Shopify."
- Reject opens an inline form: textarea labelled "Reason (saved as a note on
  this request)", required, counter at 4000; helper "The draft stays in
  Shopify with the tag Ordering Desk: Rejected. Nobody is emailed."; buttons
  "Reject request" / "Cancel"; busy "Rejecting...".
- Sections: **Request** (requester name and email with the copy button,
  company, location, every public cart attribute in Shopify's order, the
  draft note, PO number); **Items** (title, variant, qty, sku, price,
  "Custom item" marker, personalization per 11.4); **Totals** (subtotal,
  discount with its title and codes, total); **Ship to** (address with
  company and phone); **Tags**; timeline; note composer.

Order card from a draft: header shows the order name, `from draft #D12`,
"Requested <row createdAt>. Order placed <order snapshot createdAt>.", the
financial and fulfillment chips, Open in Shopify (order URL). The Request
section stays (attributes from the order, else `draft_snapshot`); items come
from the order snapshot with their props. While `shopify` is still a draft
snapshot right after attach, render it as the draft with the line "Loading
order #1234 from Shopify".

#### 11.4 Personalization display (`src/lib/item-properties.ts`, pure, tested)

`classifyProperty({ key, value })` returns one of:

- `image`: value parses with `new URL()`, protocol `https:`, and the path
  ends in `.png .jpg .jpeg .gif .webp .avif`, or the key matches
  `/preview|image|thumbnail|mockup/i`. Rendered as a thumbnail (max 160 px,
  `loading="lazy"`, `referrerPolicy="no-referrer"`, alt
  "Preview for <item title>") linking to the full image in a new tab.
- `pdf`: https URL whose path ends in `.pdf`, or key matches `/pdf|proof/i`.
  Rendered as a link "Open PDF proof" (new tab, `rel="noopener noreferrer"`).
- `link`: any other https URL, shown as its host.
- `text`: everything else, clipped at 500 characters with "Show more".
  `javascript:`, `data:`, `http:` and unparsable values are always text.
- `hidden`: an underscore key whose value is not an image or PDF URL (for
  example `_pplr` configuration blobs). A "Show all properties" toggle
  reveals them as text.

Labels: public keys as given; underscore keys stripped of leading
underscores, underscores to spaces, upper case when 4 characters or fewer
(`_pdf` reads "PDF"), else sentence case.

#### 11.5 Status options (`src/lib/status-options.ts`, pure, tested)

`statusOptionsFor({ kind, role, currentKey, statuses })`:

- draft: unlinked statuses plus the current one; linked ones are not offered
  (Approve and Reject do that). Current status `draft_rejected` and role
  staff: the select is disabled with the hint "Only a manager can reopen a
  rejected request."
- order: every status except `draft_rejected` (unless it is the current one).

#### 11.6 Timeline

| Event | Type | Text | Icon |
|---|---|---|---|
| Draft submitted | `order_new`, meta.kind draft | New request #D12 from Jane Doe | ClipboardText |
| Approved by X | `status`, meta.action approve | Approved the request. Status set to Approved | CheckCircle |
| Order created | `draft_completed` | Order #1234 created from draft #D12 | CheckCircle |
| Completed in Shopify | `status`, source shopify | Status set to Approved: the draft was completed in Shopify as order #1234 | Storefront |
| Rejected by X | `status`, meta.action reject, plus a `note` with meta.rejectReason | Rejected the request. Status set to Rejected / the reason, labelled "Reason" | XCircle / ChatText |
| Deleted in Shopify | `draft_deleted` | Draft #D12 was deleted in Shopify. This card and its history are kept. | Trash |

Add the two new types to `EVENT_TYPES` in `src/lib/live-events.ts` (the
client drops unknown types), `EVENT_ICONS` in the drawer, and the bell's
`activity-feed.ts` if it has landed (actor label already reads source
shopify as "Shopify"; leave `TOAST_TYPES` as is).

#### 11.7 Realtime

New `LiveEvent` `{ kind: "order.merged"; fromId: string; toId: string }`
(parser plus reducer): drop `fromId` from the list and its count, refetch,
and if the drawer is open on `fromId` switch it (and `?order=`) to `toId`.

#### 11.8 Platform admin banner

When `drafts.enabled` is false and the viewer is a platform admin: a slim
info banner above the strip: "Draft orders are not synced for this store.
Grant read_draft_orders and write_draft_orders to the Shopify app, then use
Refresh connection in Settings." Dismissable per workspace in
`localStorage` (wrapped in try/catch). Managers and staff never see it.

### 12. Notifications (`src/server/notify.ts`, `src/server/email/notifications.ts`)

- New draft rows reach `notifyNewOrders` through `addedOrderIds` (sync) and
  the webhook `added` outcome, and are claimed once by `notified_at` like
  orders. `summaryOf` adds `kind`, `company`, `location`, `requestFor`,
  `branch`, and up to 6 public request attributes (values clipped at 200).
- Push for a draft: title `New request #D12`; body
  `<first name>, <branch>` (else the formatted total); tag `order-<id>`.
- Email for a draft: subject `New Request #D12 from <Name>` (Title Case,
  `sanitizeSubject`), heading "New request #D12", the request attributes and
  items, every value through `escapeHtml`, no customer email or address,
  CTA as for orders.
- Digest: `n new requests`, `n new orders`, or `n new orders and requests`.
- Rows inserted with `silent` (first draft sync, history import) have
  `notified_at` set already and are never announced.
- The order made from a draft is never announced: attach and merge are
  updates of the draft row, never `added`.
- Activity push: `ACTIVITY_PUSH_TYPES` becomes `status`, `note`,
  `draft_deleted`. Approve and Reject are `status` events, so members who
  opted into all activity get them (never about their own action).
  `activityNotice` titles draft cards `Request #D12`.
- Settings copy in "Your notifications": "New orders and requests".

### 13. Interplay with the build in progress

- **Phase 6 (committed) and the bell (uncommitted):** this work edits
  `notify.ts`, `email/notifications.ts`, `webhooks.ts`, `cron.ts`,
  `fanout.ts` and the sync route after them. Start once the bell is
  committed; then add the new event types to the bell as in 11.6.
- **Phase 7 (purchase orders):** POs only for order cards. The PO create
  route refuses a draft row with 409 "Approve the request first. A purchase
  order needs the Shopify order." `triggersPo` is returned only for order
  cards (section 8.2), and the approve response carries it so the review
  opens right after approval. `purchase_orders.order_id` is the row id,
  stable through attach and merge (merge re-points POs anyway).
  PO line items prefill from the order snapshot (35 lines; respect
  `itemsTruncated`).
- **Order history import:** imports orders only; never creates draft rows;
  inserts with `silent: true` (`notified_at = now`); runs no parent lookup
  (a completion creates a new order, never a historical one). An imported
  order that is already an attached draft row is found by `claimAndLoad`
  and updated.
- **Migrations:** after whatever `build/m1-core` has at the time (0007
  today).

### 14. Scopes and degradation

- `DRAFT_SCOPES = ["read_draft_orders", "write_draft_orders"]`,
  `missingDraftScopes(granted)` with the existing write-implies-read rule,
  `draftsEnabled(granted) = missingDraftScopes(granted).length === 0`.
  Effectively `write_draft_orders` (it grants read) turns the feature on.
- `REQUIRED_SCOPES` does not change: making draft scopes required would
  refuse stores that do not use drafts and would immediately mark IMPACT's
  stored scopes as missing.
- `read_companies`: Shopify documents Company and CompanyLocation as
  readable with `read_customers` (already required) or `read_companies`.
  Ryan adds `read_companies` in the same app release anyway, so the one
  unverified dependency cannot break the draft query (a field-level access
  error fails the whole page, which the client treats as fatal). The desk
  does not check it.
- `ConnectionSettingsView` adds `draftsEnabled` and `missingDraftScopes`.
  Settings > Store connection shows "Draft orders: synced" or "Draft orders:
  off. The Shopify app needs read_draft_orders and write_draft_orders.", and
  the **Refresh connection** button (platform admins).
- When drafts are off: no draft fetch, no draft topics, no parent lookup,
  no Drafts toggle unless draft cards exist; existing draft cards stay;
  Approve and Reject answer 409; the platform admin banner shows.
- If Shopify answers the draft query with an access error while stored
  scopes say enabled (scope revoked), the drafts phase fails as fatal with
  Shopify's words in `lastError` ("Drafts: ...") and a `sync_error` event
  at most hourly; Refresh connection corrects the stored scopes.

### 15. Error copy

| Where | Condition | Status | Copy |
|---|---|---|---|
| approve/reject | caller is staff | 403 | Only a manager can approve or reject requests. |
| approve | draft deleted in Shopify | 409 | Shopify no longer has this draft. It may have been deleted there, so it cannot be approved. |
| approve | no `draft_completed` status | 409 | No status follows Draft approved. A manager can set one in Settings > Statuses. |
| approve/reject | drafts not enabled | 409 | Draft orders are not enabled for this store's Shopify app. A platform admin can grant read_draft_orders and write_draft_orders, then refresh the connection. |
| approve | total not zero | 409 | This draft totals <money>. Ordering Desk only approves drafts that total $0.00, so no payment is recorded by mistake. Complete it in Shopify instead. |
| approve | not ready | 409 | Shopify is still calculating this draft. Try again in a few seconds. |
| approve | userErrors | 409 | Shopify did not complete the draft: <Shopify's message>. |
| approve | timeout, draft still open | 502 | Shopify did not confirm the approval. Nothing changed. Try again. |
| approve | timeout, re-query failed | 502 | Shopify did not answer. Check the draft in Shopify before trying again. The card updates on the next sync. |
| approve | completed in Shopify already | 200 | This draft was already completed in Shopify as order <name>. The card now follows that order. |
| reject | no `draft_rejected` status | 409 | No status follows Draft rejected. A manager can set one in Settings > Statuses. |
| reject | reason missing or too long | 400 | Give a reason (up to 4000 characters). It is saved as a note. |
| approve/reject | already an order | 200 / 409 | Approve: already approved (200). Reject: This request is already order <name>, so it cannot be rejected. |
| status | see 8.2 | 400/403 | as in 8.2 |
| refresh | no connection | 409 | Connect the store first. |

### 16. Test plan

Repo conventions: vitest, the better-sqlite3 driver behind `Db` with the real
migrations, stubbed `fetch` for Shopify, injectable clocks.

**Migration** (`src/db/schema.test.ts` or a new `migration-drafts.test.ts`):
apply through 0007 with fixture rows (two workspaces, one with 20 statuses,
one with an existing `rejected` key; orders with `notified_at`; events; a
purchase order), then the new migration: every row and column intact;
`shopify_order_id` accepts NULL; the CHECK refuses a row with neither id;
two open drafts coexist; a duplicate draft id per workspace is refused;
Approved linked where allowed; Rejected inserted only where allowed, with
`sort = max + 1`, pink, `draft_rejected`.

**Normalize** (`normalize.test.ts`): a B2B fixture draft (company, location,
the four IMPACT cart attributes, `_pplr`, `Preview image` and `_pdf` props,
discount codes, $0 total with subtotal and discount); status mapping;
completed with order id and name; missing and malformed fields degrade;
hostile text passes untouched; caps; stable key order (stringify twice);
orders gain `kind`, `sourceName`, attributes and props; `countryCodeV2`
with `countryCode` fallback; snapshots without `kind` read as orders.

**Client** (`client.test.ts`, `admin.test.ts`): orders cost pinned at 783,
drafts page at 639, single draft and approve mutation under budget;
`fetchDraftsUpdatedSince` reads `data.draftOrders`, sends
`FIRST_DRAFT_SEARCH` for null and the window search otherwise, resumes from a
cursor, truncates like orders (run the existing truncation table against
both feeds); API version header mismatch logged once; `webhookTopicsFor`;
`replaceWebhookSubscriptions` with a topic list; `fetchDraftLinks` chunks at
100 and maps nulls to `gone`; `completeDraft` sends exactly `{ id }`.

**Sync** (`run.test.ts`, new `drafts.test.ts`):

- first draft sync inserts open drafts silently and sets `draftLastSyncAt`;
  a truncated first sync resumes with the same search
- later windows: new draft is `added` and announced later; changed draft is
  `updated`; unchanged is nothing
- completed draft with a row: attach, completion move, `draft_completed`
  event, no `added` id; completed without a row: skipped; completed whose
  order row exists: draft fields backfilled
- drafts phase transient: orders still sync, draft cursor and anchor
  untouched, `lastError` "Drafts: ..."; drafts auth ends the run like orders
- lease lost during the drafts phase writes nothing
- drafts disabled: no draft request at all
- orders phase parent lookup: unknown order attaches to the draft row, no
  `order_new` event, no `added` id, completion move fires once
- lookup failure: no order writes, orders cursor untouched, draft progress
  kept
- merge: orphan row's events and POs re-pointed, its `order_new` event
  deleted, orphan deleted, D keeps its id and status then moves, `notified_at`
  coalesced, `mergedOrders` reported; a changed orphan rolls the batch back
- hourly check marks deleted drafts and attaches missed completions, and
  does not run twice within the hour
- `ensureOrderSnapshots` fetches at most 20
- claim rule: an older run cannot overwrite a newer draft snapshot; a draft
  snapshot write is refused once attached

**Status sync** (`status-sync.test.ts`): completion from New, from Rejected
and Issue (sorted after Approved), already Approved (no move), completion of
an already fulfilled order goes to Shipped, tag edit ignored in a completion
change, inherited tag on the first order snapshot moves nothing; tag rules by
kind; `initialStatusFor` for drafts; `pushOrderStatus` targets the DraftOrder
gid for drafts and the Order gid after attach, skips deleted drafts, never
fulfills drafts.

**Statuses and mutations** (`statuses.test.ts`, `mutations.test.ts`): new link
values, one per link, error text; defaults; every row of the 8.2 table;
`triggersPo` false for drafts.

**Review service** (`review.test.ts`): every branch of 9.1 and 9.2, including
the variables assertion (`{ id }` only), the zero-total guard never calling
the mutation, idempotent second approve with no duplicate events, the
conflict-then-merge path, reject idempotency, no `sendEmail` call on reject,
tag push target on reject.

**Routes** (`routes.test.ts` patterns): approve and reject: outsider 404,
staff 403, manager 200, platform admin 200; status route 403 path; refresh
route platform-only, saves scopes, forces renewal, registers draft topics only
when granted.

**Webhooks** (`webhooks.test.ts`): draft topics verified and deduplicated;
create gives `added` and one notification; update completed attaches,
fetches the order, no notification; delete marks deleted and ignores attached
rows; re-fetch null marks deleted; order webhook for a draft-born order
attaches via lookup with no notification; lookup failure writes nothing.

**Notifications** (`notify.test.ts`, `email/notifications.test.ts`): draft
wording for push, email and digest (all three digest phrasings); attached and
silent rows never announced; `Request #D12` activity title; `draft_deleted`
pushed to all-activity members; escaping of request attributes.

**Read model and client libs** (`read.test.ts`, lib tests): summaries for
draft rows and converted orders (draft name kept, request fields from the
order then `draft_snapshot`); `draftCount`; `drafts.enabled`;
`classifyProperty` (image by extension and by key, pdf, https only,
`javascript:` and `data:` as text, hidden underscore keys, labels);
`statusOptionsFor`; `selectOrders` with `kind`; live-event parser accepts the
new types and `order.merged`; reducer drops and redirects.

**Manual pass** (light and dark, phone width): a draft card, approve
confirmation, reject form, converted card, deleted chip, banner, settings
links and refresh.

### 17. Task list (one implementer stage, then review)

| Task | Content | Main files |
|---|---|---|
| T0 | Stage 0 checks, read-only, in the Shopify GraphiQL app on the IMPACT store at 2026-10 (or a B2B dev store), results written into the HANDOFF: (a) the draft page query runs and its `extensions.cost.requestedQueryCost` (header `Shopify-GraphQL-Cost-Debug: 1`); (b) `_pplr`, `_pdf` and `Preview image` come back in `DraftOrderLineItem.customAttributes`; (c) `status:open OR status:invoice_sent` returns the admin's open drafts (fallback: no status filter, skip completed in code); (d) `purchasingEntity` reads with the app's scopes; (e) an IMPACT order converted from a draft: its `sourceName`, whether its `customAttributes` match the draft's, and its tags; (f) `nodes(ids:)` cost for 100 drafts. Do not run any mutation on a real request. | none (notes only) |
| T1 | API version 2026-10, `countryCodeV2`, served-version log. | client.ts, normalize.ts |
| T2 | Schema, migration with data steps, defaults, migration test, run.test pin. | schema.ts, drizzle/, workspaces.ts |
| T3 | Normalizers (orders extended, drafts new), `snapshotKind`. | normalize.ts |
| T4 | Fetch generalization, `DRAFT_FIELDS`, order selection change, admin helpers, cost tests. | client.ts, admin.ts |
| T5 | Drafts phase, `writeDraftSnapshot`, attach, parent lookup, merge, deletion, hourly check, `ensureOrderSnapshots`, `upsertFetchedDraft`, `SyncResult` changes, cron and sync route broadcasting merges. | run.ts, sync/drafts.ts, cron.ts, sync route, broadcast.ts |
| T6 | Status links, status-sync rules both ways, `changeOrderStatus` rules and route role. | statuses.ts, status-sync.ts, mutations.ts, status route |
| T7 | Webhook receiver, topic split, `saveConnection` resets, `forceRenew`, refresh service and route. | webhooks.ts, admin.ts, connection.ts, token.ts, new route |
| T8 | Review service, approve and reject routes. | desk/review.ts, two routes |
| T9 | Notifications and email wording, activity types. | notify.ts, email/notifications.ts |
| T10 | Read model, desk list, toolbar toggle, drawer (draft and converted), review UI, personalization, status options, timeline, realtime merge, banner. | read.ts, shapes.ts, desk components, lib modules |
| T11 | Settings: status link options and copy, store connection draft state and Refresh button, notification label. | settings components, connection-view.ts |
| T12 | HANDOFF state update (what shipped, deploy order, Ryan's steps, known limits). | docs/HANDOFF.md |
| Review | Code review (`/code-review` at high), then a security pass on the new routes (role checks, URL rendering, no secret or payload in logs). | |

Order: T0 and T1 first (T1 can ship alone before October 16), then T2 to T9
with tests alongside each, then T10 and T11, then T12 and review.

### 18. Deploy and rollout

1. `npm test` and `npm run build` green.
2. Backup: export D1 and record a time-travel bookmark (as in the
   2026-10-05 state update).
3. `npm run db:migrate:remote`, then `npm run deploy`.
4. Ryan: Dev Dashboard scopes plus webhook API version 2026-10, release,
   approve on the IMPACT store; then Settings > Store connection > Refresh
   connection.
5. Watch `wrangler tail`: served API version, the first draft sync's count,
   no `MAX_COST_EXCEEDED`.
6. First real approval supervised with Ryan on a $0 request: the order
   appears in Shopify, its financial status, whether Shopify emailed the
   buyer, the tag moves to the order, the card converts, no new-order alert.
7. Confirm a draft submitted from the storefront arrives as a card with a
   push and an email within seconds.

#### 18.1 Known limits

- A draft created and completed within a second or two (staff creating and
  immediately marking paid in admin) can race: the order may land before the
  draft row exists, announce once as an order, and the draft announce once as
  a request; the two cards then merge into one. A link from the order's
  notification then opens a card that no longer exists.
- Parent lookup covers the newest 200 open drafts; completing an older one in
  Shopify relies on the draft webhook, the drafts phase or the hourly check,
  with a merge if the order landed first.
- A manager saving the draft in Shopify admin while the desk writes the tag
  may lose the desk's tag (reported to Shopify, unanswered). The desk status
  is unaffected; the next status change writes the tag again.
- Company and location are known only from the draft (the orders query does
  not fetch `purchasingEntity`, which would break the cost budget), so order
  cards that never were drafts do not show them.
- Orders and drafts list their first 35 line items (was 48 for orders).

### 19. Still to verify (Stage 0 or the supervised first approval)

- The served API version today and after the bump (header).
- Real `requestedQueryCost` for the draft page, the order page and the
  `nodes` lookup.
- Underscore line item properties in `customAttributes`; whether cart
  attributes carry over to the order.
- The `status:open OR status:invoice_sent` search.
- `draft_orders/update` firing on completion (the design does not depend on
  it).
- Financial status and Shopify's confirmation email after
  `draftOrderComplete` on a $0 B2B draft, and whether any checkout
  validation function blocks completion.
- Exact userErrors for completing an already completed draft, and whether
  `tagsAdd` works on a completed draft.
- Whether the one-year purge sends `draft_orders/delete` (the hourly check
  covers it either way).
- That IMPACT's connection is live in client-credentials mode (webhooks need
  it); the last HANDOFF state update still lists connecting the store as
  next for Ryan.


---

### 18. Verified store facts and resolved questions (Oct 4, 2026)

Verified read-only against the live IMPACT store (Admin GraphQL through the
Shopify connector) and production D1:

- The connection is live: `impactrentals.myshopify.com` (an alias of the
  canonical `40kra0-b6.myshopify.com`; same shop, same order ids),
  `auth_mode` client_credentials, status ok, syncing every 10 minutes, 9
  orders (#1016 to #1024). Granted scopes already include
  `read_draft_orders`, `write_draft_orders`, `read_companies` and
  `write_companies`. They do NOT include `read_all_orders` or
  `read_payment_terms` (do not query `paymentTerms`: Access denied).
- Open drafts today: #D19 (the owner's own test request),
  #D20 and #D24 (requests by two employees). All OPEN, `ready: true`, total
  0.0, purchasingEntity PurchasingCompany "Impact Rentals" with locations
  "Buford, GA" or "Water Tower HQ", shipping address company "IMPACT
  Rentals, Buford HQ" style. These are inserted silently on first draft
  sync (D12); the first alert is the next new request.
- Prices are 0.0 at the line level (B2B catalog pricing): `discountCodes`
  is empty and `appliedDiscount` is null on every draft seen. Do not build
  the drawer around discount codes; show them only when present.
- Draft-level `customAttributes` (cart attributes) are EMPTY on every
  draft, and `note2` is null. So Ship to Branch, For Employee Name, Reason
  for Request and Internal Notes are not present today. The drawer shows
  whatever cart attributes and note exist, generically, with those four
  keys ordered first when they appear; never an empty placeholder block.
- Line item `customAttributes` DO carry personalization. A business card
  line has: Full Name, Job Title, Mobile Phone, Office Phone, Email, Office
  Address (CRLF line breaks: render as line breaks), `Preview` (a
  cdn.shopify.com PNG URL: show as an image thumbnail that opens full
  size), `_pdf` (a cdn.shopify.com PDF URL: show as "Print PDF" link) and
  `_pplr_preview` = "Preview" (a pointer naming the preview key: hide it).
  Other keys starting with an underscore stay hidden. Only render image and
  link values whose URL is https and on cdn.shopify.com; anything else
  renders as plain text.
- Completed drafts link to their orders: `DraftOrder.order { id name }` is
  set and the order's `sourceName` is `shopify_draft_order`. The order has
  no customAttributes and no note. Orders from personalized drafts carry
  the tag `Product_Personalizer` (added by the personalizer app; leave
  foreign tags alone).
- What Mark as paid produced on #D23: order #1024, `displayFinancialStatus`
  PAID, `displayFulfillmentStatus` UNFULFILLED. Approve (D7) must produce
  the same; the Stage 0 supervised first approval checks it.

Resolved open questions (decided by the lead, within the owner decisions):

1. Every OPEN and INVOICE_SENT draft becomes a card, including drafts staff
   create by hand in Shopify admin.
2. Approve may cause Shopify's own order confirmation email to the
   requester, exactly as Mark as paid does today. That is Shopify's store
   notification setting, not Ordering Desk; note it in the confirmation
   dialog copy only if the research confirms it ("Shopify may email the
   requester their order confirmation, as Mark as paid does.").
3. 35 line items per order and per draft is accepted. When a card has more
   lines than fetched, the drawer says "Showing 35 of N items. Open in
   Shopify for the rest." with the Shopify admin link.
4. Rejected: label "Rejected", color pink, placed last, linked
   `draft_rejected`, added to every workspace that has no status with that
   label already. Approved gets `draft_completed` where the workspace has a
   status labelled Approved and no status already holds that link.
5. Staff may move a draft between unlinked statuses (New, Processing, On
   Hold, Issue), the same as orders. Only managers and platform admins can
   Approve, Reject, or move a card out of Rejected. Moving an ORDER into a
   `draft_rejected` status is refused ("Rejected is for requests that are
   still drafts."). A Rejected tag added in Shopify on a draft moves the
   card to Rejected with a timeline event "Marked rejected in Shopify" and
   no reason.
6. Completion in Shopify moves the card to the `draft_completed` status
   from any status, including Rejected (D6).
7. A deleted or purged draft keeps its card with a "Deleted in Shopify"
   badge and a timeline event. It leaves the default list view (shown under
   an "All" or "Deleted" filter), never silently dropped.
8. Approve for a draft whose total is not exactly 0, or that is not ready,
   is not offered; the drawer says "Complete this draft in Shopify. The
   card follows when you do." with the admin link (the card then links by
   D4).
9. The history import never creates draft rows (D11). The first draft sync
   reads every open draft regardless of age.
10. The API version bump to 2026-10 (D9) is part of this build and must
    reach production before Oct 16, 2026 15:00 UTC, when Shopify's fallback
    for unsupported versions changes. Validate every query and mutation
    document against the 2026-10 schema (Shopify's docs and validator); after
    deploy the lead triggers a manual sync and checks last_error.
11. Known limit, documented in HANDOFF: a tag written by the desk while a
    manager has the same draft open and unsaved in Shopify admin may be
    overwritten by their save. The next desk status change rewrites it.
