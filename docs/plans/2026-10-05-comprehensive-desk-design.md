# Ordering Desk: Comprehensive Desk, AI Search and MCP (design, Oct 5, 2026)

Status: approved by Ryan in conversation on Oct 5, 2026 (brainstorming
session, every section confirmed). Builds on the platform amendment
(2026-10-02), the draft orders spec (2026-10-04) and what is live at
orderingdesk.com (production 0959a824, migration 0010).

Inputs: a taste v2 audit of the live UI (130 screenshots, desktop and phone,
light and dark), a frontend code audit, a product inventory, a market scan
(order desks, B2B approval apps, company merch platforms, Linear-style
operations tools), and research on Cloudflare Workers AI and remote MCP.

## Goal

**The IMPACT team never needs to open Shopify admin.** Today they still go
there to edit a request before approving it and to look people up (an
employee's history, a branch's orders, cancelling after approval). Ordering
Desk should cover both, feel like a work queue rather than a flat list, find
anything (including by asking a question), and let people work from their
own AI chatbot with guardrails.

## Owner decisions (binding)

| Topic | Decision |
|---|---|
| Main goal | The team never opens Shopify admin. |
| Editing requests | Managers and platform admins edit drafts before approval: quantities, remove lines, switch ship-to between company locations. No adding items, no size swaps, no personalization edits. |
| Locations | IMPACT ships to B2B company locations, not free addresses. Every address shows the **location name**, then the address below it. |
| Lookup | One search box (keyword plus AI search), an employee page and a location page. |
| AI model | A cheap Workers AI model chosen by research: `@cf/zai-org/glm-4.7-flash`. |
| MCP server | Yes. Employees can place requests through their chatbot (still manager-approved); team members manage from their chatbot. |
| AI ordering scope | Employees order only for themselves at their own location. Managers can order for anyone at any location through AI. |
| AI guardrails | Preview then confirm for every change, same role rules as the app, logged "via AI", daily limits per person. |
| Personalized items via AI | Allowed; the card is flagged **Proof needed**. Approval shows a warning but is not blocked. |
| After approval | Managers can cancel from the desk: Shopify cancel with no customer email, no restock, no refund. Orders cancelled in Shopify also move their card to Cancelled. |
| Employees on the web | Nothing new. Employees use Ordering Desk only through AI (status, reasons, ordering). |
| Rejection reasons | Employees can see the reason through AI; the Reject form says so. |
| Chat apps | Officially tested and documented: Claude (web, desktop, mobile) and ChatGPT. |
| Vendor goods ship-to | POs default to the requester's company location; a manager can switch a PO to Buford. |
| Sequencing | Approach A: desk first, then AI. |

## Waves

| Wave | Contents |
|---|---|
| 0 | Supervised live checks with Ryan (half a day): first real Approve (#D19), push on a phone, a test PO email with PDF, a small history import, Open in Shopify links. |
| 1a | Taste v2 polish and the work queue. |
| 1b | Locations, editing requests, cancel after approval. |
| 1c | Server search, AI search, employee and location pages. |
| 2 | MCP server for team members: read-only tools, then writes. |
| 3 | MCP server for employees, piloted at one location. |
| 4 | Pick lists and packing slips, PO upgrades, attention row, CSV export. |

Each wave is one build (test-first), parallel review lenses (security,
correctness, design, mechanical), one repair round, then backup, migration
and deploy as in previous releases.

## 1. Wave 1a: polish and the work queue

Taste v2 fixes (from the audit, highest value first):

- **Account menu** in the top bar on every host: name, email, role, theme,
  switch workspace, Sign out. There is no sign-out inside a workspace today
  (`src/components/shell/top-bar.tsx`), and the theme toggle uses space on
  every screen. Fix the hub header at phone width (the email wraps one letter
  per line and the admin link overlaps the title, `src/app/page.tsx`).
- **Density:** compact single-line desktop rows (about 44px) and one toolbar
  row, aiming for 15 to 18 orders above the fold (7 today). Phone: one sticky
  bar, compact cards with the age in the header. Render one list per
  breakpoint (both the table and the cards are mounted today, so 1,000 cards
  mean 2,000 hidden status selects).
- **Honest state:** the sync chip turns amber after about 30 minutes and red
  after a few hours, with a tip. Add `error.tsx`, `global-error.tsx` and a
  Settings `loading.tsx` in the workspace look; theme the not-found page on
  client hosts.
- **One component kit:** one Chip in three sizes (two ToneChips and five chip
  heights today), one InlineMessage, shared Section, DetailRow, RadioCard,
  Segmented and Monogram. Busy buttons keep full opacity with aria-busy and a
  spinner. Style aria-invalid fields. A primary hover color derived per theme
  (brightness hover vanishes on dark brands). The active filter bar uses
  primary-strong (lime reads 1.76:1). A secondary danger button. One shared
  event map with meaningful colors for the timeline and the bell (approve
  green, reject and failed writes red, sync errors amber, PO sent blue).
- **$0 noise:** a workspace "Show prices" mode, automatic by default: totals
  and the Paid chip hide when nearly every order is $0. "Highest total" sort
  becomes "Waiting longest".
- Request state copy: the rejected panel quotes reason, who and when; a
  deleted draft is titled "Deleted in Shopify"; PO rows that are not numbered
  say "Not numbered yet".
- Phone ergonomics: a sticky action bar at the bottom of the drawer, the PO
  send confirmation fits the screen with Cancel visible, SKUs never break
  mid-code, 40 to 44px touch targets and chip text of at least 12px.

Work queue:

- **Open by default:** statuses gain a `closed` flag (Delivered, Rejected,
  Cancelled closed by default; editable in Settings > Statuses). The desk
  opens on Open with its count; All and Closed are one click away.
- **Age on every card** from `status_set_at` ("New, 2d"), amber at 2 days and
  red at 4 by default, per-workspace settings; a Waiting longest sort.
- **Needs approval queue** for managers and platform admins: a pinned view
  with a count badge in the top bar and **Approve and next**, which opens the
  next waiting request with the same confirmation step (focus on the
  question, 400 ms arming).
- **Filters in the URL** (view, status, kind, search, sort) so push and email
  links open the exact view.
- **Bulk status change:** row checkboxes and shift-click, one confirmation
  listing every card. Drafts keep their rules (no bulk approve, no drafts into
  fulfilled or delivered statuses); the server re-checks every card.

Deferred from this wave: keyboard shortcuts and Cmd K, saved named views,
assignment.

## 2. Wave 1b: locations, editing requests, cancel

Locations:

- Sync the workspace's Shopify B2B company locations (name, shipping
  address, active) into a `locations` table: on connection save and Refresh
  connection, on the cron (daily is enough), and on company location
  webhooks if the topics are available with the granted scopes
  (`read_companies` is granted). New branches appear on their own.
- Orders and drafts record `location_id` from `purchasingEntity` (B2B) when
  present.
- **Address component** used everywhere an address shows (drawer, list,
  PO ship-to, emails, PO PDF, packing slips later): location name in bold,
  the address lines below. Without a company location, the address alone.
- The desktop list gets a Branch column in place of the total.

Edit a request (drafts only; managers and platform admins; server enforced):

- Allowed: change a line's quantity (at least 1), remove a line (at least one
  line must remain), switch the ship-to among the company's locations
  (managers may pick any company location).
- Implementation: `draftOrderUpdate` with the complete line list (variant,
  quantity, every custom attribute kept exactly, so personalization and proof
  links survive) and the purchasing entity's company location; the shipping
  address follows the location. Validate every document against the pinned
  2026-10 schema.
- Preview, then confirm in the drawer: a before-and-after summary. The save
  is refused when the draft's `updatedAt` changed since the preview (reload
  and review again). If Shopify reports a total above $0 after the edit, the
  card warns that Approve needs $0. Editing closes any open Approve
  confirmation.
- Timeline event `draft_edited` with the actor and a plain summary.

Cancel after approval (orders only; managers and platform admins):

- Reason required, preview, confirm. `orderCancel` with `notifyCustomer:
  false`, `restock: false` and no refund (every IMPACT order is $0; verify
  the 2026-10 arguments). Sent once; on timeout, read the order and never
  resend.
- New default status **Cancelled** (closed, Shopify link `cancelled`) added
  to existing workspaces by migration, like Rejected was.
- Shopify to app: `orders/cancelled` (already registered) and the sync move
  the card to Cancelled from any status, with a timeline entry "Cancelled in
  Shopify". This reverses the earlier "no cancel mirroring" decision, by
  owner choice.
- Shopify refusals (for example an order already fulfilled) give a plain
  message and change nothing.

## 3. Wave 1c: finding anything

Server search:

- A denormalized `order_search` row per card, written with every snapshot
  write, edit and status change: lowercased text of order and draft numbers,
  requester name and email, location name, item titles, SKUs, personalization
  values and PO numbers, plus filter columns (kind, status key, closed,
  location id, requester id, created and status-set times).
- Parameterized LIKE queries in D1, scoped by workspace from the session.
  No FTS5: D1 cannot export databases with virtual tables, which would break
  the pre-migration backups.
- Search covers all history, not only the newest 1,000 cards.

AI search (same box):

- Shortcut, no model: order numbers (#1024, #D19), and queries of one or two
  words, run as keyword search.
- Otherwise `@cf/zai-org/glm-4.7-flash` (Workers AI binding `AI`) translates
  the question into a filter: thinking off
  (`chat_template_kwargs.enable_thinking: false`), temperature 0, about 200
  output tokens, a strict `json_schema` built per workspace, `rejectIfBusy`,
  a 2.5 second timeout.
- Filter schema: kind; status keys (enum of the workspace's statuses); state
  (open, closed, any); location names (enum); person (free text, 60
  characters); item (enum of titles or free text, also SKU);
  personalization text; order number; date preset or custom range; older
  than and newer than days (0 to 365); sort; leftover text. Unknown keys are
  rejected; enums are re-checked in code; dates are computed on the server in
  the workspace time zone.
- The model sees only the query (200 characters at most), today's date and
  the workspace vocabulary that staff control (status labels, location
  names, item titles). It never sees notes, personalization, cart attributes
  or requester details.
- The understood filter shows as removable chips. Any failure, timeout or
  invalid output falls back to keyword search. A per-person daily cap on AI
  queries.
- Cost: inside the free 10,000 Neurons a day for IMPACT; about $1 a month at
  20 workspaces. `@cf/ibm-granite/granite-4.0-h-micro` is an A/B candidate
  behind the same constant. No embeddings or AI Gateway in v1.
- Workers AI has no local simulation: local dev calls the real service, so
  tests stub the binding.

Employee and location pages (team members only):

- A `people` table built from requesters (Shopify customer id, name, email,
  company contact id, home location), updated by the sync.
- Employee page: name, email, home location, counts (open, approved,
  rejected, cancelled), items and sizes over the last 12 months, every card.
  Linked from the requester name in the drawer, the list and search results.
- Location page: name and address, open cards, everything shipped there, top
  items, who ordered.
- Top bar navigation: Desk, People, Locations.

## 4. Waves 2 and 3: the MCP server

Architecture:

- Inside the existing `orderingdesk` Worker: explicit routes in
  `custom-worker.ts` after the host gate for `/mcp`,
  `/.well-known/oauth-protected-resource/mcp`,
  `/.well-known/oauth-authorization-server` and `/oauth/*`.
- Streamable HTTP via the Agents SDK stateless `createMcpHandler`; no Durable
  Objects for MCP sessions (the `ROOM` DO still pushes changes to open desks).
- OAuth with `@cloudflare/workers-oauth-provider`: each allowed host is its
  own issuer and resource (for example
  `https://orders.impactrentals.store/mcp`); client ID metadata documents on,
  dynamic client registration limited to allowlisted redirect hosts; a new KV
  binding `OAUTH_KV`. Grants are mirrored in D1 and checked on every call
  (instant revoke; KV propagation can lag), and roles are re-read from D1 on
  every call.
- Sign-in on the authorize page reuses the email sign-in with a 6-digit code
  (links opened from email break in chat apps' in-app browsers).
- Settings shows each person's AI connections with Revoke; platform admins
  can revoke all for a workspace.

Principals:

- Team members connect with their app role (manager, staff, platform admin
  acting as manager on the client host).
- Employees connect as a new **requester** principal, allowed only when their
  email is a contact in the workspace's linked Shopify B2B company (Admin
  GraphQL company contacts, `read_companies` granted); their location comes
  from Shopify; webhooks and the sync revoke them when Shopify removes them.
  Requesters never become workspace members and have no app access.
- Employee access is off per workspace by default; a platform admin turns it
  on, first for one pilot location.

Guardrails (all server-side, independent of the chat client):

- Every write is two steps: `prepare_*` stores a single-use D1 action that
  expires in 10 minutes and returns a plain preview; `confirm_*` must repeat
  readable fields that match it. Auto-allowed tools still cannot skip it.
- Tool annotations: read and prepare tools `readOnlyHint: true`; confirms for
  approve, reject, cancel, edit and status `destructiveHint: true`. Do not
  depend on elicitation (claude.ai does not support it yet).
- Same role rules as the app; requesters only for themselves at their own
  location.
- Daily limits per person (adjustable per workspace): requester 5 requests
  and 200 reads; staff 50 changes; manager 100 changes; 1,000 reads.
- Every action records source "via AI" on the timeline and an audit row
  (who, tool, target, outcome).
- Prompt injection: order text returned to the chatbot is labelled data,
  with links and images stripped and no markdown passed through.

Tools:

- Team: search (same AI search), get order, employee and location lookups;
  prepare and confirm for status change, note, approve (warns on Proof
  needed), reject, cancel, edit request; managers also place a request for
  anyone at any location.
- Employees: browse the catalog with their contextual $0 prices and sizes
  (`read_products` is granted); their past orders; place a request; check the
  status of their own requests including the rejection reason.
- Placing a request is a Shopify `draftOrderCreate` for the B2B company
  contact at the location (purchasing entity company, contact and location),
  shipping to the location's address, personalization in line item custom
  attributes with the personalizer's keys, a "Proof needed" tag and chip when
  a personalized item has no proof, the $0 total checked first with
  `draftOrderCalculate`, sent once with a marker tag so a timeout never
  creates a duplicate.
- Stage 0 before Wave 3: confirm an API-created B2B draft behaves like a
  checkout-to-draft one (price list at $0 at every location, visible to the
  employee, Shopify emails, a contact without a role at the location
  refused).

Before Wave 3 goes live: Ryan confirms with IMPACT that employees may use
their personal Claude or ChatGPT accounts with company order data, and picks
the pilot location.

## 5. Wave 4: fulfillment, POs, visibility

- **Pick list** from a bulk selection: items grouped by SKU and size.
- **Packing slips**, one per order: location name and address, "Distribute
  to: <employee>", items, personalization with the business card proof
  image; everything in one print job.
- **POs:** personalization prefilled on each line (details and proof links)
  in the modal, confirmation, vendor email and PDF; a PDF preview before
  sending; PDF cleanups (larger PO number, no duplicate subtotal); delete an
  abandoned PO draft.
- **PO ship-to default:** the requester's company location (owner choice);
  a manager can switch a single PO to Buford (the workspace receiving
  location). The choice repeats on the send confirmation.
- **Attention row** at the top of the desk: requests waiting with the oldest
  age, orders stuck past their target, POs to send or failed, sync health;
  each tile applies its filter.
- **CSV export** of the current view (orders, lines, personalization,
  location, status, dates) and a PO register.

Deferred: PO stages after Sent and a vendor portal, weekly batch POs, backup
approver and escalation, Insights page, Monday digest, requester history
warnings in the review panel, mentions, attachments, assignment, offline
queueing, the platform health board and setup checklist.

## 6. Data, failure handling, testing, rollout

Data (all additive; backup and time-travel bookmark before every
migration):

- `statuses.closed`; default Cancelled status; `workspace_settings` age
  thresholds and price display mode.
- `locations`; `orders.location_id`.
- `order_search`; `people`.
- MCP: `ai_grants`, `ai_actions` (prepared, single-use, expiring),
  `ai_usage` (daily counters), `audit_log`, `requester_identities`;
  `OAUTH_KV` KV binding; `AI` Workers AI binding. Never add a `build` field to
  wrangler.jsonc.

Failure handling:

- AI search always falls back to keyword search.
- Shopify writes (edit, cancel, approve, place request) are sent once; on a
  timeout the app reads Shopify and never resends; plain-language errors; no
  half-done state.
- MCP tools return structured errors; prepared actions expire.

Testing:

- Test-first with Shopify, Workers AI and the OAuth provider stubbed.
- Migrations proven on a local copy of production-shaped data.
- A short supervised live check at the end of each wave. Read-only MCP tools
  are exercised from Claude Code as a client; Ryan tests Claude and ChatGPT.

Rollout:

- Wave 0 first (supervised live checks).
- Per-workspace switches for AI search and employee MCP access.
- Public repo rule: no client employee names, emails or phone numbers in
  docs, tests or commits.
