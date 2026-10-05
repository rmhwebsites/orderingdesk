# Order Desk - Session Handoff

Last updated: 2026-10-01, written mid-build in case the working session ends.
Read this top to bottom before touching anything. The authoritative specs are
`docs/plans/2026-10-01-order-desk-design.md` (approved design, incl. the Oct 1
email amendment) and `docs/plans/2026-10-01-order-desk-implementation.md`
(phased TDD plan; its "Execution notes" section records hard-won hazards: read it).

## What this is

Multi-workspace Shopify order management platform ("Order Desk") for RMH
Websites. Owner: Ryan (ryan@rmhwebsites.com). First tenant: IMPACT Rentals.
Stack: Next.js 16 on Cloudflare Workers via @opennextjs/cloudflare, D1 +
Drizzle, better-auth magic links, Durable Object realtime (Phase 5), R2,
Cloudflare Email Service (replaced Resend on Oct 1), web push PWA (Phase 6),
PO flow with mandatory human review before send (Phase 7).

Repo: github.com/rmhwebsites/orderflow (PUBLIC - never commit secrets).
Branch: build/m1-core. All work is committed and pushed through 116a744
(plus this handoff commit). The sync repair commits after that (84b3266,
7dade33 and the round 2 repair) are committed locally and not pushed yet.

## Build state (what is DONE and verified)

- Phase 0 scaffold, Phase 1 data layer, Phase 2 auth/workspaces/invites,
  Phase 3 sync engine: implemented, each through a two-gate review
  (spec compliance, then code quality), all requested fixes applied.
- 173 tests green (`npm run test` = drizzle-kit check + vitest), tsc clean.
- Migrations 0000-0003 applied BOTH locally and to remote D1, and they are
  the whole schema: migration 0004 was withdrawn before it was applied
  anywhere (see "Sync review repairs, round 2" below).
- Local end-to-end evidence exists for: magic-link sign-in, workspace create
  with 7 default statuses, invite claim (both paths), revocation, sync engine
  (idempotent, cursor-resumed pagination, fenced lease) via simulator tests.

## Cloud facts (all live on Ryan's "RMH Websites" Cloudflare account)

- wrangler is logged in via OAuth on this machine (`npx wrangler whoami`).
- D1: order_desk, id 2b066c9a-0684-47eb-8672-c638cc6aaa2a (in wrangler.jsonc).
- R2: bucket named `orderflow` (NOT order-desk-pdfs), binding PO_BUCKET.
- Email: Cloudflare Email Service binding `EMAIL` (send_email in
  wrangler.jsonc). Workers Paid is active and impactrentals.store is onboarded
  as a sending domain, so production email should work at first deploy.
  Sender constant: DEFAULT_FROM in src/server/email/send.ts.
  Local dev never sends; it logs `[email-fallback]` lines instead.
- NOT yet deployed. No secrets set yet. VAPID keys not yet generated (Phase 6).

## In-flight at time of writing

An adversarial verification workflow ("verify-sync-fixes-v2", 3 lenses) was
running against commit 116a744. If its results are unknown to you:
- Re-run the equivalent: adversarially review `git diff 1206878 116a744` for
  (a) cursor-resumption correctness, (b) lease fencing/idempotency/dedup,
  (c) the mechanical gate (tests, tsc, migration 0003, hygiene). NOTE: this
  handoff commit sits on top of 116a744, so a mechanical check expecting
  116a744 at HEAD will "fail" that item: expected, not a defect.
- If the lenses found issues, fix via TDD and re-verify before deploying.

## Verification verdict on 116a744 (arrived just before cutoff)

Three-lens adversarial review completed. The core fixes HOLD (cursor chains
keep a stable window and byte-identical search string; fenced writes are
atomic; recovery is lossless; the livelock regression test is honest; fence
values cannot collide; applyPair/changesOf read D1 batch results correctly;
EXISTENCE_CHUNK=50 pinned). Remaining findings, FIX BEFORE DEPLOY:

1. IMPORTANT (src/server/sync/run.ts ~line 338): the lease fence covers only
   store_connections; the orders snapshot UPDATE is unfenced. A zombie run
   that outlives its 120s lease (fetch budget allows ~900s) can land an OLD
   snapshot over a newer run's write, permanently (the advanced window never
   re-covers it), and still reports updated/updatedOrderIds despite
   superseded=true (would drive false Phase 5/6 broadcasts). Fix: make the
   snapshot update conditional (add lte(orders.syncedAt, now) to its where,
   count it only via changesOf like the insert path), and return empty
   added/updated arrays from any run whose terminal write was superseded.
2. MINOR (~line 373): after a completed cursor continuation, anchor lastSyncAt
   at the run's own pre-fetch `now` instead of the chain watermark; keeps a
   >500-order same-moment burst from causing a perpetual 2-tick rescan cycle
   on an idle shop (churn, not loss).
3. MINOR (~line 161): move the post-CAS fresh connection read inside the try
   block so a transient D1 error there cannot leak the lease until expiry.

Write failing tests first (the lenses left repro sketches: a zombie-run test
and the rescan-cycle observation in the existing invariant test), fix, run the
full gate, commit with the usual trailer, push, THEN do the smoke deploy.

## Sync review repairs, round 1 (supersedes parts of the verdict above)

The three findings above were fixed in 84b3266. A second adversarial review of
that commit found two real defects, both repaired test-first:

1. Zombie hole on unchanged rows. The synced_at guard only protected rows a
   newer run had WRITTEN; a row the newer run merely verified as unchanged
   kept its old synced_at and a zombie's stale snapshot could still land.
   Now runSync follows claim-then-read (claimAndLoad in run.ts): each chunk of
   fetched order ids is stamped synced_at = this run's now (forward only)
   BEFORE the stored snapshots are read, so the latest-started run owns every
   row it looked at. An insert that turns out to be a conflict no-op (another
   run stored the order first) now claims, loads and compares that row
   instead of skipping it. orders.synced_at therefore means "start time of
   the latest run that looked at this row", not "last snapshot write".
2. Finding 2 above ("anchor at the run's own now after a continuation") was
   WRONG when Shopify's updated_at search surfaces an order late: the cursor
   never returns to an order that appears behind it, and the finishing tick's
   now put the next window after it, losing the order for good. Rule now:
   lastSyncAt never moves past the moment the window was opened. A completed
   cursor chain anchors at the now of the tick that OPENED the chain. Cost:
   at most one bounded re-scan after a dense burst, then one request per
   tick. Do not "simplify" this back to the finishing tick's now or to the
   chain watermark. (Round 1 stored the chain start in a new column and let
   a truncation without a cursor anchor on a watermark; round 2 below
   replaced both.)

## Sync review repairs, round 2 (supersedes parts of round 1)

A third adversarial review found three issues. All three are repaired
test-first.

1. No anchor is derived from fetched nodes any more. Shopify sorts by a
   lagging search index but hydrates nodes fresh, so an order edited seconds
   ago can still sort at its old position while its node says "updated just
   now". The old rule for a truncation without a cursor (anchor at the newest
   updatedAt gathered) then jumped lastSyncAt to about now and silently
   skipped every older order the run had not reached. Now every truncation
   is resumable: the client (src/server/shopify/client.ts) always returns
   the cursor to resume from. "More pages but no cursor" on the first request
   of a run is a transient error (nothing moves, lastError says so); on a
   later request the run keeps what it read and resumes from the cursor that
   request was sent with. run.ts has two anchors left, both clock values:
   this run's now (plain window) and the chain start (cursor chain).
2. The orders query asked for 50 orders x 50 line items, about 7,953 cost
   points. Shopify refuses any query above 1,000 requested points before
   running it, on every plan, so by the documented rules no order would ever
   have synced. The page is now 5 orders x 50 line items (about 798 points;
   the line item cap is unchanged so no order loses items) and a run reads
   up to 100 pages, which keeps the 500 orders per run ceiling. Because a
   run is now many small requests, a retryable failure part-way (throttle,
   5xx, timeout, garbled body) no longer throws away the pages already
   read: the run ends as a truncation and the next tick resumes from the
   last cursor. A failure on the first request is still reported as before.
   client.test.ts prices the query that is actually sent and fails above
   800 points.
   NOT VERIFIED LIVE: the 798 is computed from Shopify's documented rules
   (object 1, connection 2 + page size x node cost, limit 1,000), not read
   from a shop. On the first real sync, check it: either the sync works, or
   lastError / the sync_error event shows Shopify's "Query cost is N, which
   exceeds the single query max cost limit (1000)", in which case lower
   ORDERS_PER_PAGE in client.ts (and raise MAX_PAGES to match). To read the
   exact number, POST the query with the shop token and look at
   extensions.cost.requestedQueryCost in the response (the request header
   Shopify-GraphQL-Cost-Debug: 1 adds a per-field breakdown).
3. Migration 0004 is gone. The chain start now rides inside sync_cursor as
   "<chain start ms>|<Shopify cursor>" (resumeToken / parseResumeToken in
   run.ts), so the engine needs nothing beyond migration 0003, the round 1
   deploy blocker no longer exists, and cursor and chain start can never be
   written or cleared apart. A bare cursor (no prefix) or a chain start
   later than the run's own clock reads as "start unknown" and degrades to
   one re-scan from the untouched lastSyncAt. run.test.ts pins this with a
   test that runs a whole chain on a database migrated only through 0003:
   if a later phase adds a column to a table the engine reads or writes,
   that test fails until the number is raised, which is the reminder that
   the migration has to be applied before that code is deployed.

Also new in run.test.ts: the simulators serve the page size the query asks
for, and a seeded fuzz drives the whole engine against a shop whose index
lags (fresh nodes at stale sort positions, cursorless pages, throttles,
5xx, timeouts, rejected cursors) and checks that every order and every
latest snapshot arrives. `SYNC_FUZZ_SEEDS=3000 npx vitest run
src/server/sync/run.test.ts -t "seeded fuzz"` soaks it (about 90 seconds).
The fuzz keeps index lag under the 5 minute overlap on purpose: an order
that takes longer than the overlap to become searchable is outside what
this design promises.

Known limits, not fixed here (decide before relying on them):
- Line items beyond 49 per order are not fetched, but no longer silently:
  the order is marked itemsTruncated (see the line item state update at the
  end of this file).
- On plans with a small rate bucket, Shopify's throttle (not MAX_PAGES) is
  expected to end a backlog run early, by a rough estimate after a hundred
  orders or so; a 60 day first sync of a busy shop then drains over several
  ticks through the cursor chain. That is by design, and untested live. If
  it proves too slow, pace the page loop against
  extensions.cost.throttleStatus instead of raising the page size.
- While a cursor chain is draining, lastSyncAt stays at its old value on
  purpose (0 during a first sync). The Phase 5 connection card should show
  a "catching up" state whenever sync_cursor is set, not a stale "last
  synced" time.
- A slow shop can keep a full 100 request run going past the 120 second
  lease. That is safe (fenced writes, claim-then-read) but wasteful; a wall
  clock budget in the page loop would be a one-line stop now that every
  truncation is resumable.

## Immediate next steps, in order

1. Nothing to migrate: 0000-0003 are applied locally and remotely and
   `npx drizzle-kit generate` reports no schema changes. Re-run npm run
   test + tsc.
2. SMOKE DEPLOY (early, agreed with Ryan) - exact sequence:
   a. `openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET`
      (same for ENCRYPTION_KEY; `openssl rand -hex 16` for CRON_SECRET).
      Wrangler will offer to create the Worker on first secret: accept.
   b. `npm run deploy` (opennextjs-cloudflare build && deploy). Note the
      workers.dev URL it prints.
   c. Set that URL as vars.APP_URL in wrangler.jsonc (replace the
      REPLACE_ME_AFTER_DEPLOY placeholder), commit (pathspec only), redeploy.
   d. LIVE TEST: open the URL, request a magic link to Ryan's email. It must
      arrive from orders@impactrentals.store. Then sign in, create the
      "IMPACT Rentals" workspace. Check `npx wrangler tail` for cron runs
      (every 10 min; they no-op without a store connection).
   e. Once the store connection exists, watch the first real sync for the
      query cost check described under round 2, item 2. The query also
      selects customer fields; if Shopify answers "Access denied for
      customer field", the token needs read_customers next to read_orders
      (not verified live either). Both failures are loud: lastError on the
      connection card and a sync_error event.
3. Phase 4 per the implementation plan (desk read/write APIs), then 5 (UI +
   realtime), 6 (PWA/push/notifications), 7 (PO flow), 8 (polish/docs).
   Ryan must supply a Shopify custom-app Admin API token (read_orders) for
   impactrentals when the store connection is first configured; the connection
   PUT must lowercase/trim the domain (client regex requires *.myshopify.com).

## Process rules that proved load-bearing (follow them)

- Subagent-driven development: dispatch a fresh implementer per phase with the
  FULL task text (they have no conversation context), then two review gates.
  Under ultracode, run reviews as parallel adversarial Workflow lenses; they
  have repeatedly found real criticals that tests missed (watermark livelock,
  D1 100-bound-parameter cap).
- TDD with captured red runs; evidence pasted in reports, not summarized.
- npm/cli#4828: ANY `npm install <pkg>` can silently drop @rolldown/binding-*
  from package-lock.json. After every dependency change:
  `rm -rf node_modules package-lock.json && npm install`, then
  `grep -c '"node_modules/@rolldown/binding-' package-lock.json` must be >= 15
  BEFORE committing.
- Concurrent agents in one tree: commit with explicit pathspecs only
  (`git commit -- <files>`), never `git add -A`.
- A PreToolUse security hook rejects file writes containing certain literal
  substrings: the RegExp exec method spelled with its leading dot, and the raw
  DOM inner-HTML property name (spelled as one word). Use String.match instead
  of RegExp exec, build UI with React JSX only, and spell those tokens
  obliquely in docs (this file does).
- House style: zero em-dashes, zero emoji, commits end with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Email conventions: dynamic values in HTML -> escapeHtml; in subjects ->
  sanitizeSubject (never entity-encode subjects). All sending goes through
  src/server/email/send.ts.
- Guards: every /w/[slug] server component calls requireMemberBySlug (layouts
  are not an auth boundary); API routes use requireMember; 401 signed-out,
  404 for missing-or-underranked (never 403); Shopify tokens encrypted
  AES-GCM v1 with aad = workspaceId; cron code uses getDbFromEnv, never
  getDb, inside scheduled().

## Business decisions already made (do not re-ask)

- Light mode default, dark toggle; per-workspace accent (IMPACT #91d500).
- POs NEVER auto-send: review modal + explicit send button, always.
- Notifications: phone push + branded email for new orders and PO sends;
  in-app for everything else (per-user opt-in to push-all).
- Vendor picked per order from a workspace vendor list.
- All-Cloudflare architecture was researched and chosen over Supabase and
  Firebase for cost ($0-5/mo) at Ryan's explicit direction; email moved from
  Resend to Cloudflare Email Service at his direction.

## STATE UPDATE, 2026-10-01 evening (supersedes anything above that conflicts)

- HEAD is 658c193 plus this handoff commit, all pushed. Commits 84b3266,
  7dade33 and 658c193 are the pre-deploy sync fixes plus two repair rounds.
  Gates at HEAD: 173 tests green, tsc clean, working tree clean.
- The round 2 repair (658c193) has NOT been independently reviewed. The
  verification workflow was stopped on purpose to save usage. Ultracode is OFF
  and Ryan questioned the value of repeated repair loops: from here on do ONE
  review pass per phase, and reserve heavy review for sign-in, store tokens and
  PO sending. Do NOT restart sync hardening loops.
- First thing next session: read `git diff f4ffaf8 HEAD -- src/` once yourself.
  Check two things in particular: (1) the Shopify orders query page sizes. A
  reviewer found orders(first 50) with lineItems(first 50) exceeds Shopify's
  1,000 point single-query cost limit, which would make every real sync fail
  loudly; confirm round 2 shrank the page sizes, and when the real store token
  exists read extensions.cost.requestedQueryCost from one live request.
  (2) the truncation and lastSyncAt anchoring rules still read coherently.
- Migrations: drizzle/ holds 0000-0003 only at HEAD (a 0004 added in round 1
  appears to have been removed again in round 2). drizzle-kit check and the
  drift test are green, and local plus remote D1 are both at 0003. Run
  `npm run db:generate` to confirm it reports no changes before deploying.
- Commit trailer is now: Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
- Next steps are otherwise unchanged: the smoke deploy sequence above, then
  Phase 4 (desk APIs), Phase 5 (screens), 6, 7, 8.
- Ryan is creating a Shopify custom app token (read orders) for the IMPACT
  store. He enters it himself in workspace settings once that screen exists;
  it must never be pasted into chat or committed.

## STATE UPDATE, 2026-10-02 (supersedes conflicting notes above)

- Sync repair round 2 (658c193) was reviewed once by the main session and
  accepted: query priced at 798 of Shopify's 1,000 point cap (pinned by a
  test), truncated runs always resume from Shopify's own cursor, lastSyncAt
  only moves forward. No further sync hardening loops.
- DEPLOYED: https://order-desk.restless-fog-f3c0.workers.dev (cron */10 live).
  Secrets set on the Worker: BETTER_AUTH_SECRET, ENCRYPTION_KEY, CRON_SECRET.
  APP_URL in wrangler.jsonc now points at that URL. Remote D1 at 0003.
  Smoke checks passed: signed-out redirect, sign-in page, session endpoint,
  401 on the API, magic-link validation (no email sent by the agent).
- Build fix: the home page is force-dynamic. Any future page that reads the
  session must be dynamic too, or `next build` prerenders it and fails.
- Pending on Ryan: open the URL, sign in with his email (first real email from
  orders@impactrentals.store), create the IMPACT Rentals workspace.
- Next: Phase 4 (desk APIs). One implementer, one review pass; heavy review
  only for the store-token connection route.
- Commit trailer is now: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Redeploy after code changes: `npm run deploy`. Config-only change:
  `npx opennextjs-cloudflare deploy`. Apply new migrations remotely first:
  `npm run db:migrate:remote`.

## STATE UPDATE, 2026-10-02, line item truncation marker (962766f)

Supersedes the 798 point figure and the old line item limit above.

- The orders query asks for lineItems(first: 49) with pageInfo { hasNextPage }
  and prices at 788 points by the client.test.ts estimator (budget 800). The
  marker costs one object per order; with 50 slots it would price at 803,
  which is why the cap went from 50 to 49. The live cost check under round 2,
  item 2 still applies, with 788 as the expected figure.
- Every stored orders.shopify snapshot carries itemsTruncated. It is false
  only when Shopify said the order has no line items beyond `items`; a
  missing or malformed answer counts as truncated. Consumers must read it as
  `snapshot.itemsTruncated !== false`, so a snapshot stored before this
  change (no key) also counts as unconfirmed. No migration: the column is
  untyped JSON.
- The sync does not fetch the remaining line items. A follow-up request in
  the page loop would need its own throttle handling: on a small rate bucket
  a page of large orders can throttle the follow-up on every tick, and ending
  the run there would pin the cursor chain to that page.
- Phase 5 (desk): when the flag is set, say the order has more line items in
  Shopify than shown.
- Phase 7 (PO modal), required: when the flag is set, fetch that one order's
  full line item list on demand before prefilling (order(id:) with
  lineItems(first: 250, after:) paged, about 754 points per request by the
  same estimator), and if that fetch fails, block "Send to vendor" with a
  visible warning. Never prefill a PO from a list whose flag is set.
- Not deployed yet: the live Worker still runs the old query until the next
  `npm run deploy`. No store is connected, so nothing has synced with it.

## STATE UPDATE, 2026-10-02 later (supersedes the deploy notes above)

- The app now runs on Ryan's Worker `orderflow` (repo-linked Workers Builds
  project): https://orderflow.restless-fog-f3c0.workers.dev, deployed from
  6b55356 via a clean worktree. Secrets set on orderflow. wrangler.jsonc name
  is orderflow. A stray Worker `order-desk` (first smoke deploy) still exists
  and shares the D1 database; delete it once Ryan confirms.
- Sign-in email fails in production with "email sending not authorized for
  subdomain 'impactrentals.store'": no domain is onboarded under Compute >
  Email Service > Email Sending (no cf-bounce DNS records exist).
  impactrentals.store DNS is on Cloudflare; inbound mail is Namecheap Private
  Email (privateemail MX), so onboard Email SENDING only, never Email Routing.
  Sender is configurable via the EMAIL_FROM var in wrangler.jsonc.
- Fixed: better-auth rate limits keyed on cf-connecting-ip (were one global
  bucket per path).
- NEVER add a "build" field to wrangler.jsonc: `wrangler types` (the prebuild
  step) runs it, which runs the build again, forever. Happened once on Oct 2.
- Workers Builds settings Ryan must set (dashboard, orderflow > Settings >
  Build): build command `npx opennextjs-cloudflare build`, deploy command
  `npx opennextjs-cloudflare deploy`. Once set and the production branch is
  known, merge build/m1-core into it so pushes auto-deploy. D1 migrations are
  NOT applied by Builds: run `npm run db:migrate:remote` before any deploy
  that adds one (Phase 5 adds a branding column).
- Phase 4 done (9875186: review repairs incl. one-store-per-workspace 409,
  read_orders scope check, superseded-sync no-write). 288 tests.
- Phase 5 running as workflow "phase5-order-screens" (desk, drawer, realtime
  via signed ticket + custom-worker /live route, settings, branding uploads
  with SVG sanitizing + PNG copies for email, disconnect-as-disable).
- A separate user-started session ("Surface orders with more than 50 line
  items") also commits to this branch; check git log before committing.

## STATE UPDATE, 2026-10-02 rename (supersedes conflicting notes above)

- Product name is now **Ordering Desk** (domain orderingdesk.com). GitHub repo
  renamed to rmhwebsites/orderingdesk (origin updated). Cloudflare Worker
  renamed to `orderingdesk` (same Worker as orderflow, secrets carried over).
- LIVE at https://orderingdesk.com (Worker custom domain). Hotfix deployed from
  f6af440 via a temp worktree with UNCOMMITTED config: name orderingdesk,
  APP_URL https://orderingdesk.com, EMAIL_FROM "Ordering Desk
  <orders@orderingdesk.com>", routes [{pattern orderingdesk.com,
  custom_domain true}]. workers.dev is now disabled (routes present).
- PENDING RENAME COMMIT (do right after the Phase 5 workflow finishes, because
  its reviewers check the old names): src/lib/brand.ts APP_NAME "Ordering
  Desk"; send.ts DEFAULT_FROM -> orders@orderingdesk.com (+ send.test.ts);
  wrangler.jsonc as above plus "preview_urls": true so Workers Builds branch
  previews keep working; globals.css comment; theme storage key and live
  ticket purpose strings may move to ordering-desk (internal). R2 bucket
  `orderflow` and D1 `order_desk` keep their names (internal resources).
- Email: production now fails with "could not find domain config of sending
  domain" until Ryan onboards orderingdesk.com under Email Service > Email
  Sending (orderingdesk.com has no MX, so it is clean).
- Workers Builds: commands set by Ryan, repo connected. Production branch
  presumed main (unconfirmed). Merge build/m1-core into main only after: the
  rename commit, `npm run db:migrate:remote` (Phase 5 adds a branding
  column), and a passing build. Builds does not run migrations.
- Next feature after Phase 5: client custom domains (orders.<client domain>).
  Plan: workspaces.customDomain; host -> workspace resolution (client host
  opens that workspace directly, branded); better-auth baseURL and trusted
  origins per allowed host (cookies are per host, sign-in happens on the
  client host); emails link to the workspace host, sent from the platform
  domain with the workspace name. Infra: orders.impactrentals.store can be a
  Worker custom domain (same account); external clients via Cloudflare for
  SaaS custom hostnames on the orderingdesk.com zone (client CNAME).
- Stray Worker `order-desk` still exists (shares D1); awaiting Ryan's OK to
  delete.

## STATE UPDATE, 2026-10-02 Cloudflare rename complete (supersedes above)

- Cloudflare resources are all `orderingdesk`: Worker orderingdesk on
  https://orderingdesk.com (custom domain; workers.dev off, preview URLs on),
  D1 `orderingdesk` (9d9f35cd-32a4-4f5d-971f-7a9e235c719e), R2 `orderingdesk`.
  Old D1 order_desk and R2 orderflow were copied (verified by row counts and an
  identity fingerprint), then DELETED. Final export of the old D1 saved at
  Impact Rentals/backups/order_desk-final-export-2026-10-02.sql.
- D1 import gotcha: `wrangler d1 execute --file` of a `d1 export` fails with
  {"D1_RESET_DO":true} (sqlite_sequence writes, and the bulk import path). What
  worked: `d1 migrations apply` on the new DB, then the data INSERTs (no
  d1_migrations or sqlite_sequence rows, parents before children) via
  `--command`.
- Production deployed from d162bf0 (rename + Phase 5 part A UI). Email works
  for orderingdesk.com (onboarded by Ryan). Ryan signed in (account
  ryan@rmhwebsites.com, workspace "Impact Rentals", role owner). The
  PLATFORM_ADMIN_EMAILS Worker secret holds ryan@rmhwebsites.com.
- Phase 5 part A merged (desk, drawer, realtime, theming foundation); its
  independent review is still owed. Part B was cancelled before it started;
  its scope moved into the platform phase per
  docs/plans/2026-10-02-platform-amendment.md.
- Branch model: develop on build/m1-core; main is the Workers Builds
  production branch (presumed). Promote reviewed work by fast-forwarding main.

## STATE UPDATE, 2026-10-02 platform phase foundation (supersedes above)

- Branch build/m1-core, commits 217212f (schema + access model) and
  5c708a4 (Phase 4 review repairs). Not pushed, not deployed.
- Migration 0004 (drizzle/0004_mute_human_torch.sql) is the one schema
  migration for the whole platform phase: manager / staff roles with
  membership source, platform_admins, platform-admin invites, shopify_roster,
  webhook_deliveries, store connection client-credentials columns,
  statuses.shopify_link, events.source, workspace custom domain, sender,
  roster tags and branding JSON (type in src/lib/branding.ts). It converts
  production rows in place (owner and admin to manager, member to staff,
  shipped and delivered statuses linked, existing events labeled). The end of
  the file is hand-written data conversion, and the pending_invites copy was
  hand-fixed (drizzle-kit selected a column the old table lacks); regenerate
  nothing over it. Applied locally, NOT remotely.
- DEPLOY ORDER: `npm run db:migrate:remote` first, then deploy this code
  right away. Code from before 217212f reads the converted roles as no
  access (everyone gets 404) until the new code is live. run.test.ts pins
  that the sync engine needs migration 0004.
- Access: platform admins (PLATFORM_ADMIN_EMAILS or platform_admins) reach
  every workspace as role "platform"; requirePlatformAdmin guards workspace
  creation, /api/platform/admins and the store connection; workspace name
  and accent color are platform-only. Clients see only their workspaces and
  land straight in a single one (src/server/hub.ts). Sign-up is closed:
  sendMagicLink skips sending when the email has no route to an account
  (same response), and user.create.before refuses the account
  (src/server/access.ts, src/server/auth.ts). Sign-in claims invites and
  materializes the Shopify roster (src/server/invites.ts, roster.ts).
- Local dev: sign-up is closed locally too. Put your address in
  PLATFORM_ADMIN_EMAILS in .dev.vars (see .dev.vars.example).
- (Superseded by the settings stage below: the Settings links are back
  and src/lib/features.ts is gone.)

## Connecting a Shopify store

Written for Ryan. Only a platform admin can do this, and the Client secret
is entered only in Ordering Desk: never paste it into chat, email or a
ticket.

1. Open the Shopify Dev Dashboard (dev.shopify.com) under the organization
   that owns the store, and create an app for Ordering Desk (or open the one
   you already made). The store has to belong to that same organization:
   Shopify only hands out these tokens for stores in your own organization.
2. In the app's configuration, give it these Admin API access scopes, then
   release the version:
   - read_orders and write_orders (read and tag orders)
   - read_customers (customers tagged "Ordering Desk Manager" or "Ordering
     Desk Staff" can request access, which a manager approves once)
   - read_merchant_managed_fulfillment_orders and
     write_merchant_managed_fulfillment_orders (moving an order to Shipped
     marks it fulfilled in Shopify, without emailing the customer)
   - optional: read_all_orders, only to import orders older than 60 days
     (Order history, below). Shopify may ask you to request this scope for
     the app first; that was not checked live.
3. Install the app on the store and approve those permissions there.
4. In the Dev Dashboard, open the app's settings and copy its Client ID and
   Client secret.
5. In Ordering Desk, open the workspace's Settings, Store connection, and
   enter the store's .myshopify.com address, the Client ID and the Client
   secret (the same three fields also go to PUT /api/workspaces/<workspace
   id>/connection as JSON from a signed-in platform admin session). Ordering
   Desk checks them with Shopify right
   away: if a permission is missing it says which one, and nothing is
   saved. When they are accepted it also switches on live updates
   (webhooks); if Shopify refuses those, the store still connects and syncs
   every 10 minutes, and connecting again retries them.
6. If you change the scopes later, release a new app version, approve it on
   the store, and connect again.

Once connected:
- Tag a Shopify customer "Ordering Desk Manager" or "Ordering Desk Staff"
  to REQUEST that role in the workspace, then approve the request once in
  the workspace's Settings, Team, "Waiting for approval" (any manager of
  the workspace or a platform admin can). Until it is approved the tag
  gives nothing: no sign-in email, no account, no access. Once approved,
  the person joins at their next sign-in (until then the request is listed
  as "Approved, waiting to sign in", with Revoke). The approval
  step exists because a tag proves nothing: anyone can create a customer
  with tags from the storefront itself (the newsletter form sends
  contact[tags]), so without it a stranger could tag their own email
  "Ordering Desk Manager" and become a manager.
  - Changing the tag from Staff to Manager needs a new approval (they stay
    staff until then); Manager to Staff applies at once.
  - Deny takes away their tag-based access in the workspace and closes
    their open tabs; the request stays denied until the tag is removed and
    added again. Denied requests are listed (collapsed) with Approve.
  - Removing the tag, deleting the customer or changing its email removes
    the access; tagging again later is a new request to approve.
  People invited by hand inside Ordering Desk keep the role set by hand,
  whatever their tag says. Removing one also denies an approved tag
  request for them in that workspace, so the tag does not bring them back.
  Disconnecting the store removes every tag-based access in the workspace,
  approvals included; after it is connected again the tagged people show
  up as new requests at the first roster sync.
- Every status change in Ordering Desk shows on the Shopify order as one
  tag, "Ordering Desk: <status>". Editing that tag in Shopify changes the
  status in Ordering Desk. Fulfilling or delivering in Shopify moves the
  order forward to Shipped or Delivered (never backward). Shopify allows
  40 characters per order tag, so status names are capped at 25.
- An older store app with an Admin API token (shpat_...) can still be
  connected with the token instead of a Client ID and secret. It needs the
  same permissions, gets no live updates (its webhooks could not be
  verified), and syncs every 10 minutes.
- Importing older orders: the sync only brings in the last 60 days. In
  the workspace's Settings, Store connection, Order history (hub only,
  platform admins), choose "All orders" or "Orders since a date" and press
  Start import. It runs in the background, about 100 orders every 10
  minutes, newest first, after the regular sync has caught up; the page
  shows the count and can stop it (what was imported stays). Imported
  orders start at the status their Shopify state or status tag implies,
  nobody is notified, they stay out of the bell, and nothing is written to
  Shopify. Anything older than 60 days needs read_all_orders: add it to
  the app, approve the new version on the store, connect again, then
  start the import (without it Ordering Desk refuses to start, because
  Shopify would silently return only the last 60 days).

## STATE UPDATE, 2026-10-02 platform phase Shopify stage (supersedes above)

- Branch build/m1-core on top of 1e2f091: 45ba9ae (client credentials
  token), 83ef8be (connection + webhook registration), 08bdf5a (two-way
  status), 041418f (webhooks + roster), plus this docs commit. Not pushed,
  not deployed. No new migration: 0004 is still the one to apply remotely
  first (the new events.type value shopify_write is a TypeScript enum only;
  the column has no CHECK).
- Connection (src/server/desk/connection.ts): {shopDomain, clientId,
  clientSecret} or {shopDomain, token}. Both modes must carry
  REQUIRED_SCOPES (a write scope implies its read scope); a 422 names each
  missing one. Client credentials: token minted at connect, cached
  encrypted with its expiry, renewed within 10 minutes of expiry by
  src/server/shopify/token.ts (compare-and-set cache write; concurrent
  renewals both get a valid token). runSync and every Shopify call get
  their token there.
- Webhooks: registered on a client-credentials connect for 10 topics at
  APP_URL/api/webhooks/shopify/<workspaceId> (webhookSubscriptionCreate
  with uri and format JSON; this workspace's old subscriptions for that
  exact address are deleted first). Receiver: src/server/shopify/webhooks.ts.
  Local dev cannot receive them (Shopify needs a public https address).
- Two-way status (src/server/shopify/status-sync.ts, whose header documents
  the rules and the Shopify state mapping): only CHANGES between the stored
  and the fresh snapshot move a status, never an old state; tag edits win
  over fulfillment moves; echo window 10 minutes. App changes push the tag
  (and fulfill for a status linked to fulfilled) after the response; the
  outcome is a shopify_write event in the timeline.
- The order query now asks for fulfillments(first: 3) { displayStatus } and
  lineItems(first: 48) (was 49): 798 points by the client.test.ts
  estimator, which prices the fulfillment list like a connection. The live
  cost check above still applies, with 798 as the expected figure (or
  lower: Shopify may price the list below the estimate).
- NOT VERIFIED LIVE (validated only against Shopify's current published
  schema, and by stubbed tests): the client credentials grant and its error
  shapes, webhookSubscriptionCreate's uri field and fulfillmentCreate on
  API 2025-07, the customers tag search, and Customer.email (deprecated in
  newer versions in favor of defaultEmailAddress). First live connect: watch
  the connect response (warning field) and the first webhook deliveries.
- Known limits: an order with 3 or more fulfillments never moves to
  Delivered automatically (the list may continue past 3); a Shopify tag
  naming a status the order held in the last 10 minutes is read as the
  app's own late write; a delivery that Shopify records only on the
  fulfillment (shipment status) may not change the order's updated_at, so
  the cron may never re-read that order and only the fulfillments/update
  webhook carries it (Shopify retries a failed delivery for 48 hours; not
  verified live).

## Attaching a client host

Written for Ryan. A client host is the address a client's team uses,
orders.<client domain> (IMPACT: orders.impactrentals.store). It opens that
workspace directly, with its logo on the sign-in page, and people sign in
there separately from orderingdesk.com (each address keeps its own sign-in).
Until a platform admin checks it in Ordering Desk, the address shows only a
plain "Not found" page.

On the Cloudflare side, one of these two:

A. The client's domain is in your Cloudflare account (impactrentals.store
   is): attach the host to the orderingdesk Worker as a custom domain.
   - Preferred: add `{ "pattern": "orders.impactrentals.store",
     "custom_domain": true }` to the routes list in wrangler.jsonc, commit,
     and deploy (Workers Builds on main, or `npm run deploy`). Deploys apply
     the routes in wrangler.jsonc, so a domain listed there survives them.
   - Or in the dashboard: Workers & Pages > orderingdesk > Settings >
     Domains & Routes > Add > Custom domain. A domain added only there may
     be dropped by a later deploy, so add it to wrangler.jsonc as well.
   Either way Cloudflare creates the DNS record and the certificate. The
   name must not already have a DNS record (delete an old one first).

B. The client's domain is somewhere else: Cloudflare for SaaS on the
   orderingdesk.com zone.
   1. orderingdesk.com > SSL/TLS > Custom Hostnames: enable it (once).
   2. Add a proxied DNS record on orderingdesk.com to serve as the fallback
      origin, for example customers.orderingdesk.com (AAAA 100::, proxied),
      and set it as the fallback origin (once).
   3. Send custom hostnames to the Worker: a Worker route `*/*` on the
      orderingdesk.com zone for the orderingdesk Worker (in wrangler.jsonc:
      `{ "pattern": "*/*", "zone_name": "orderingdesk.com" }`), once.
   4. Custom Hostnames > Add custom hostname: orders.<client domain>.
   5. The client adds, at their DNS host, a CNAME from orders.<client
      domain> to customers.orderingdesk.com, plus the validation TXT record
      Cloudflare shows. Wait until the hostname shows Active.

Then in Ordering Desk (platform admins only), open the workspace's Settings,
Custom domain: save the host and press Check. The same from a signed-in
orderingdesk.com tab (browser console; the workspace id comes from GET
/api/workspaces):

    await fetch("/api/workspaces/<workspace id>/domain", { method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "orders.impactrentals.store" }) }).then((r) => r.json())
    await fetch("/api/workspaces/<workspace id>/domain/check", { method: "POST" }).then((r) => r.json())

The check loads https://<host>/api/health and needs that page to report the
same host. "active" means the host now opens the workspace; "error" comes
with a reason saying what to fix (attach it, wait for DNS, remove a
redirect), then check again. DELETE on the same address removes the host.

## Sending email for a client

Written for Ryan. The client's email (sign-in on their host, team invites,
and later order notifications and purchase orders) carries their logo and
colors, and comes from accounts@orders.<client domain> (IMPACT:
accounts@orders.impactrentals.store) once that address is verified. Until
then it comes from orders@orderingdesk.com with the client's name as the
sender name and their reply-to address.

1. Attach the client host first and check it (above): the address is
   derived from the active host.
2. In Cloudflare: Compute > Email Service > Email Sending, onboard
   orders.<client domain>. Cloudflare treats it as its own sending domain.
   Choose Email Sending only, never Email Routing (the client's own inbox
   is untouched; IMPACT's mail stays on Namecheap Private Email). This is
   possible only when the client's zone is in your Cloudflare account,
   because Cloudflare adds the sending records there.
3. Press Verify in the workspace's Settings, Workspace email (or
   POST /api/workspaces/<workspace id>/sender/verify from a signed-in
   orderingdesk.com tab). A test email arrives at your address from
   accounts@orders.<client domain>; from then on the client's email comes
   from it. If Verify answers "Onboard <domain> under Compute > Email
   Service > Email Sending ...", step 2 is not finished yet: finish it,
   wait a few minutes, and press Verify again.

Changing the client host or the sending address undoes the verification:
press Verify again afterwards. To send from another address than
accounts@..., set it first (PUT /api/workspaces/<workspace id>/sender with
{"address": "hello@client.example"}, or null to go back) and onboard its
domain. A client whose domain is not in your account (Cloudflare for SaaS)
keeps sending from orders@orderingdesk.com with their name, unless you set
an address on a domain you have onboarded.

## STATE UPDATE, 2026-10-02 platform phase domains stage (supersedes above)

- Branch build/m1-core: 7b53019 (client hosts, per-host sign-in), 4f879e9
  (custom domain management), 9b27755 (branded email and per-workspace
  sender), plus this docs commit. Not pushed, not deployed. No new
  migration: every column used comes from 0004, which is still the one to
  apply remotely before deploying (`npm run db:migrate:remote`).
- Hosts (src/server/host.ts): resolveHost answers hub (APP_URL host),
  workspace (custom_domain equal to the host, status active) or unknown.
  custom-worker.ts gates every request with it before OpenNext: unknown
  hosts get a plain 404 except /api/health. It also pins x-forwarded-host to
  the routed host, because OpenNext copies that header over Host (a client
  could otherwise choose the host the app believes it is on). Next code
  reads the host through requestHost() (src/server/request-host.ts).
- Auth per host (src/server/auth.ts): getAuth() builds better-auth with
  baseURL and the only trusted origin set to the hub origin or the client
  origin (stored domain with the APP_URL scheme and port), or returns null
  for a refused host (the auth route and the guards answer 404). The guards
  scope a client host to its own workspace for everyone (assertHostAllows).
- Client host pages: "/" is the workspace desk in WorkspaceShell
  (src/components/shell/workspace-shell.tsx); /w/<own slug> redirects to
  "/" there and other slugs are not found; the sign-in page is branded
  (src/server/client-host.ts). WorkspaceIdentity.basePath is "" on a client
  host and /w/<slug> on the hub: build workspace links with it.
- Email: senderFor (src/server/email/send.ts) decides every sender;
  renderEmail (src/server/email/layout.ts) is the one layout;
  loadMailWorkspace (src/server/email/workspace.ts) reads what both need.
- For the settings stage:
  - Build GET /api/branding/<workspaceId>/<file> (public, no session: mail
    clients load logos from it). <file> is the last segment of the asset's
    R2 key (brandAssetPath in src/lib/branding.ts), so keep those segments
    unique within a workspace. The client host sign-in page and the emails
    already reference it.
  - Validate branding.fonts against BRAND_FONTS (src/lib/brand-fonts.ts);
    extend that list rather than keeping a second one.
  - On a client host the workspace lives at "/": a settings page there
    needs a root-level route (for example /settings) using the same guards,
    and links must use basePath. Today /w/<own slug>/anything on a client
    host redirects to "/".
  - Screens for the domain (PUT, check, DELETE) and sender (PUT, verify)
    routes. The check's reason is returned, not stored (no column), so show
    it from the response.
- Not verified live: Cloudflare for SaaS routing to the Worker, the health
  check fetching the Worker's own custom domain (global_fetch_strictly_public
  is on), the Email binding's text field and its encoding of a non-ASCII
  display name, and the exact wording of Cloudflare's sending refusals (the
  two phrases matched come from earlier production errors).
- Known limits:
  - Workers Builds preview URLs are unknown hosts now: every path except
    /api/health answers 404 there. Allow-list a preview host pattern in
    resolveHost if previews are wanted (they share the production D1).
  - `next dev` does not run custom-worker.ts, so an unknown host gets the
    app's not-found page there instead of the plain 404. To try a client
    host locally, set a workspace's custom_domain to something like
    impact.localhost with status active in the local D1 and open
    http://impact.localhost:3000.
  - Local dev logs email instead of sending, so Verify there records a
    verification without a real send.
  - A verified sender that Cloudflare later refuses (domain offboarded)
    makes those sends fail; there is no automatic fallback. Verify again or
    clear the override.
  - The sender name is the workspace name; workspace_settings.from_name is
    not used for it.
  - The hub still sends a single-workspace client to /w/<slug> on
    orderingdesk.com, not to their client host.
  - Shopify webhooks stay on APP_URL (the hub).

## STATE UPDATE, 2026-10-04 platform phase settings stage (supersedes above)

- Branch build/m1-core: 7c23afb (branding uploads, theme rules, public
  brand files), then the theme refactor, the settings services, realtime
  hardening, the Settings page, the platform admin screen and a fix, plus
  this docs commit. Not pushed, not deployed. No new migration: 0004 is
  still the one to apply remotely first (`npm run db:migrate:remote`).
- Theme (src/lib/brand-theme.ts, src/components/shell/brand-scope.tsx,
  globals.css): every workspace screen, the client host sign-in page and
  the Settings preview render a brand scope whose inline variables carry
  the primary color per theme, an optional palette (light from the
  brand's ink and background, dark derived or overridden), the heading and
  body fonts (font-display and font-sans read --font-heading and
  --font-body; Sora and Red Hat Display by default) and the radius scale
  (rounded-control and rounded-panel; no component hard-codes a pill or
  panel radius any more). A chosen Google Font loads with one stylesheet
  link for that workspace. The tab icon is the symbol (dark version by
  prefers-color-scheme). The hub sets none of it.
- Settings: /w/<slug>/settings on the hub, /settings on an active client
  host (src/app/settings/page.tsx). src/lib/settings-access.ts decides the
  sections per role and src/server/settings-page.ts reads only those.
  Every section talks to the existing routes; new ones: PATCH
  .../members (change a manual member's role), PUT .../roster-tags
  (platform admins), and statuses now carry shopifyLink (at most one
  status per Shopify state; an entry without it keeps its stored link).
- Branding in Settings: SVG and WebP uploads get their PNG copy rendered
  by the browser (src/components/settings/png-copy.ts) and posted to
  .../png. Colors are checked live with the same checkBrandColors the
  server runs; a failing palette cannot be saved and each issue offers
  the nearest passing shade. Saving refreshes the page so the shell
  picks up the theme at once.
- /admin (hub, platform admins): workspaces, platform admins, users.
- Realtime: live tickets carry a nonce; the room admits each nonce once
  (stored until the ticket expires, an alarm forgets expired ones) and
  tags sockets with the user id. Removing a member, revoking a Shopify
  tag (webhook or cron roster sync) or revoking a platform admin sends a
  kick; the room closes that user's sockets with code 4003 and the client
  reloads instead of reconnecting. The room now uses Durable Object
  storage (the class is already SQLite-backed, migration tag v1), so no
  wrangler change was needed.
- Known limits:
  - The From name setting is stored and shown, but nothing uses it yet
    (it is meant for purchase order email; other mail uses the workspace
    name).
  - The Store connection card shows granted scopes only for connections
    saved since the scope check was added; older rows show none missing.
  - On a client host, /w/<own slug>/settings may land on "/" (the slug
    layout's redirect) rather than /settings. Links there use basePath,
    so nothing in the app leads to it.
  - `next dev` does not run custom-worker.ts, so live sockets, the nonce
    and kicks are covered by tests only until a preview or production
    deploy. The email preview iframe also shows no logo locally: its CSP
    allows https images only and local dev serves http.


## STATE UPDATE, 2026-10-04 review repairs (supersedes above)

- Branch build/m1-core, on top of 149f311: eight repair commits for the
  settings stage review (security, correctness, design, and the Phase 5
  part A items), plus this docs commit. Not pushed, not deployed.
- NEW MIGRATION 0005 (drizzle/0005_invite_sends.sql): one additive table,
  invite_sends, for the team invite limit. It touches no existing row.
  DEPLOY ORDER: `npm run db:migrate:remote` (applies 0004 and 0005), then
  deploy this code right away.
- Sessions and sign-in links are bound to their host (src/server/auth.ts).
  The hub signs session cookies with BETTER_AUTH_SECRET as before, so
  existing hub sessions stay valid; each client host signs with its own
  key derived from it (hostSecret), so a cookie captured on a client host
  is no session anywhere else. Sign-in tokens are stored as a hash of the
  origin and the token (linkTokenHash), so a link issued on one host finds
  nothing on another; any link requested before the deploy stops working
  (they expire in 5 minutes anyway).
- Platform powers answer on the hub only (src/server/guard.ts, Viewer): on
  a client host a platform admin works as a manager of that workspace, and
  /admin, workspace creation, platform admins and the platform-only
  settings (store connection, branding, custom domain, email sender, roster
  tags, workspace name and accent) answer 404 there. The client host
  Settings page tells a platform admin so and links to the hub's Settings.
  Ryan: use orderingdesk.com for those.
- Sign-in link delivery runs after the response (ctx.waitUntil) and a
  failed send is logged without the address, so an allowed and a refused
  email look the same, in content and in time. A broken workspace sender
  therefore no longer shows an error on the sign-in form: watch the
  Worker logs for "[auth]" lines.
- Team invites are always pending invites, whether or not the email has an
  account somewhere (no direct add, same answer either way). A signed-in
  person claims theirs at their next sign-in or when they open "/" on the
  hub or the workspace's client host (the invite email's button). Each
  workspace may send 30 invite emails per hour (429 after that); withdrawn
  invites still count.
- Store disconnect clears the workspace's shopify_roster rows and source
  shopify memberships and closes those people's sockets; a roster write
  that finds the store disconnected after writing takes itself back.
- Realtime: /live checks the ticket's user against D1 (member or platform
  admin) when the ticket is used; the room records each kick until every
  ticket issued before it has expired, attaches {userId, connectedAt} to
  each socket and closes sockets older than 30 minutes with code 4001, on
  which the client reconnects with a fresh ticket. A ticket route answer
  of 401 or 404 makes the client reload instead of retrying.
- Status labels are capped at 25 characters (src/lib/status-label.ts:
  Shopify's 40 character tag limit minus "Ordering Desk: "; the 40 is from
  Shopify's Order docs, not checked live). A refused tag write no longer
  stops the fulfillment of a status linked to fulfilled.
- The desk's status control saves only an explicit choice: a keyboard
  change is staged until Enter or leaving the control (Escape drops it); a
  mouse or touch pick saves at once (src/lib/status-commit.ts).
- Branding: the contrast summary is built from contrastReport, the same
  checks that block saving. "Use the Ordering Desk colors" asks first and
  puts the accent back to the Ordering Desk primary. Without a palette,
  button text falls back to black or white when the Ordering Desk ink and
  paper both miss AA on the accent.
- Settings keep keyboard focus through inline confirms, row removals and
  vendor edits (focusSoon and ConfirmStep's returnFocus in
  src/components/settings/kit.tsx). Component tests render with
  react-dom/server (no DOM library), so focus moves are checked in the
  browser, not in vitest.
- Known limits: the 30 minute socket refresh refetches the desk once per
  socket per half hour; on a client host a platform admin has manager
  access only (by design, see above); the Shopify tag limit and the
  waitUntil delivery are not verified live.

## STATE UPDATE, 2026-10-04 security review repairs (supersedes above)

- Branch build/m1-core, on top of 59fe68c: a9cd10c (roster approval,
  server), 4a45c43 (Team UI for it), 8d2472f (docs), 61634c7 (unused
  better-auth endpoints off), 337c281 (server-chosen account name),
  25e16be (atomic invite limit), 4572fb7 (top bar), 27329f2 (settings
  polish), plus this docs commit. Not pushed, not deployed.
- NEW MIGRATION 0006 (drizzle/0006_roster_approval.sql): four nullable
  columns on shopify_roster (approved_role, approved_at, approved_by,
  denied_at). Additive; existing rows read as waiting for approval
  (production has no roster rows yet: its D1 is still at 0003). Applied
  locally. DEPLOY ORDER: `npm run db:migrate:remote` (applies 0004, 0005
  and 0006), then deploy this code right away.
- Shopify tags request access, a manager approves once (HIGH finding: any
  storefront visitor can create a customer with tags through the newsletter
  form's contact[tags]). Rules in the header of src/server/roster.ts, user
  guide under "Connecting a Shopify store" above, plan in the platform
  amendment section 2.
  - Only rows with approved_role set and denied_at null grant anything:
    canCreateAccount and hasAccountRoute (src/server/access.ts),
    materializeRoster, and the roster sync's membership for existing users
    (grant in src/server/shopify/roster-sync.ts, which brings the
    membership in line with the row in the same batch).
  - approved_role is the role approved and the role granted; it never
    exceeds role. A raised tag keeps it (membership stays at the old role,
    the request waits); a lowered tag lowers it at once. The same email on
    another customer id starts the row over (a missed customers/delete).
    Tag removal, customer deletion, an email change and a store disconnect
    delete rows as before, approvals with them.
  - Routes: POST /api/workspaces/[id]/roster/[rosterId]/approve (optional
    body {role}: 409 when the tag now asks for another role) and .../deny,
    requireMember(id, "manager"), scoped by workspace id (another
    workspace's roster id is 404). GET .../members adds {requests:
    {waiting, denied}} for managers and platform admins.
  - Settings > Team: "Waiting for approval" panel (Approve, Deny behind
    ConfirmStep), denied requests in a collapsed list with Approve.
- better-auth: createAuth sets disabledPaths (DISABLED_AUTH_PATHS in
  src/server/auth.ts) for every 1.7.7 endpoint except /sign-in/magic-link,
  /magic-link/verify, /get-session, /sign-out and /error; /callback/:id
  and /reset-password/:token are refused by route in a before hook. Check
  the list again on any better-auth upgrade (getEndpoints in
  node_modules/better-auth/dist/api/index.mjs).
- New accounts are named by the server: the email's local part
  (accountName), whatever name the magic-link request carried.
- Team invites: the hourly send is reserved by one INSERT ... SELECT ...
  WHERE (SELECT count(*) ...) < 30 (src/server/members.ts).
- Top bar: from lg a long workspace name truncates (brand link
  lg:flex-initial, chip row lg:shrink-0); checked at 1024px with an 80
  character name in local dev.
- Settings: section scroll margin 8rem below lg (the header is 109px
  there), 6rem from lg; focus after removing a member goes to the nearest
  row with a control (nearestRowOrder in kit.tsx) or the Team heading, and
  back to Remove on failure; ConfirmStep's confirm button is described by
  its question; "Use the Ordering Desk colors" keeps unsaved font and
  corner edits (draftAfterColorsReset).
- Known limits:
  - Approving a request for someone who already has a manual membership
    changes nothing (a manual membership always wins), so the Team list
    keeps their manual role.
  - After a store disconnect and reconnect, every tagged person is a new
    request again (approvals are deleted with the roster rows).
  - The deny route accepts any roster entry of the workspace, approved ones
    included (it then revokes their tag-based access); the UI offers Deny
    on waiting requests only.
  - New accounts show their email's local part as their name (Team and
    admin lists show it above the email). Existing accounts keep theirs,
    and nobody can change a name now (/update-user is off).

## STATE UPDATE, 2026-10-04 tag approval repairs (supersedes above)

- Branch build/m1-core, on top of 2ae38a8: 1d2b3c0 (an approved tag
  request adds nobody until the person signs in), fc3d9e4 (removing a
  member denies their approved tag request), plus this docs commit. Not
  pushed, not deployed. No new migration: 0006 is still the newest, and
  the deploy order above stands (`npm run db:migrate:remote` applies 0004,
  0005 and 0006, then deploy).
- Approving works like an invite (security finding: approving inserted a
  membership at once for an email that had an account, so Settings > Team
  showed that person and their name right away, while an email with no
  account just left the list; a manager can tag any email in their own
  store).
  - approveRosterEntry and the roster sync's grant never add a membership.
    They only bring an EXISTING shopify membership in line with the row
    (alignMembershipWithRoster in src/server/roster.ts: a lowered tag
    lowers it, an approved raise takes it up). materializeRoster, run by
    claimAccessOnSignIn at every sign-in and "/" load, is the only place a
    roster row becomes a membership.
  - listRosterRequests answers {waiting, denied, approved}; approved =
    approved for the role the tag asks for and nobody with the email is a
    member of the workspace yet, the same whether or not an account exists.
    Settings > Team shows them as "Approved, waiting to sign in" with
    Revoke (the deny route, behind ConfirmStep).
  - Nothing is emailed on approval (nothing was before either): the
    person signs in on the client host or the hub to join.
- Removing a manual member (removeMember, src/server/members.ts) denies a
  granting roster row (approved, or a raise waiting with an earlier
  approval) for their email in that workspace, in the same batch. Before,
  the approval stayed hidden behind the manual membership and the next "/"
  load re-granted it as a shopify membership, possibly as manager, which
  Remove refuses. A request nobody approved is left as it is. The manager
  view of GET .../members carries tagRole on such a manual member, shown in
  Settings > Team next to them and in the Remove confirmation.
- Known limits:
  - A member whose access comes from an approved tag still cannot be
    removed in Ordering Desk (Remove refuses, the Team list says to change
    the tag in Shopify); the deny route would do it, but the UI offers
    Deny on waiting requests and Revoke on unclaimed approvals only.
  - An approved person who is already signed in joins when they next open
    "/" or sign in, not on other pages.

## STATE UPDATE, 2026-10-05 PLATFORM PHASE LIVE (supersedes earlier deploy notes)

- Live at https://orderingdesk.com from build/m1-core 9fb6a64 (version
  97f0f417), main fast-forwarded to match. Remote D1 at migration 0006.
- Before the migration: export at
  Impact Rentals/backups/orderingdesk-before-0004-0006-2026-10-04.sql and
  D1 time-travel bookmark
  00000193-00000000-000050fb-a916d1f6ed00e301b9c852c040f3d720 (restore with
  `npx wrangler d1 time-travel restore orderingdesk --bookmark=<that>`;
  history is kept 30 days).
- Verified on production after deploy: ryan's membership converted owner ->
  manager (source manual; he is platform admin via PLATFORM_ADMIN_EMAILS);
  shipped -> fulfilled and delivered -> delivered links; signed-out redirects
  for /, /w/<slug>/settings and /admin; /api/health; unsigned webhook 401;
  better-auth account endpoints 404; unknown Host refused; a stranger's
  magic-link request gets {status:true} and no email.
- Security review (/security-review, Oct 4) found one HIGH: storefront
  newsletter forms can set customer tags, so tags alone granted access. Fixed
  with the approval step Ryan chose ("Tag, then approve once"), migration 0006.
- Next for Ryan: connect the IMPACT store in Settings (Client ID and secret),
  approve tagged staff in Settings > Team, attach orders.impactrentals.store
  (see "Attaching a client host"), onboard it for Email Sending, Verify the
  sender. Then Phase 6 (push and notification emails) and Phase 7 (POs).

## STATE UPDATE, 2026-10-04 Phase 6 notifications (supersedes above)

- Branch build/m1-core, on top of 765ef29: 9a045c6 (push sender,
  subscription routes, migration 0007), c5972fb (installable app),
  1184599 (new order and activity notifications, branded email), fe3be05
  (Your notifications in Settings), 8ec345f (activity bell), plus a
  sign-out change and this docs commit. Not pushed, not deployed.
- NEW MIGRATION 0007 (drizzle/0007_notifications.sql): orders.notified_at
  and push_subscriptions.host, both nullable, additive. Applied locally.
  DEPLOY ORDER: `npm run db:migrate:remote` FIRST, then deploy the code.
  Every order insert now names notified_at, so code deployed before the
  migration fails every sync (the sync test pinning the minimum schema is
  raised to 0007).
- NEW SECRETS (operator): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
  VAPID_SUBJECT (mailto: an address that reads mail). Generate the pair
  once with `node scripts/generate-vapid.mjs` and set each with
  `npx wrangler secret put`. Changing the pair later strands every browser
  subscription. Without them push is off (GET /api/push/key answers 503,
  Settings says push is not set up) and email still works. A local pair is
  in .dev.vars (gitignored).
- New dependency: @block65/webcrypto-web-push 2.0.0 (WebCrypto, runs on
  Workers). The lockfile regeneration also took patch updates of
  @opennextjs/cloudflare 1.20.8, @opennextjs/aws 4.1.7 and wrangler
  4.147.0.
- Installable app (src/server/pwa/): GET /site.webmanifest and
  GET /app-icon/<192.png|512.png|maskable-512.png|apple-180.png> answer
  for the routed host. The hub is Ordering Desk with an OD monogram (lime
  on ink); an active client host is its workspace: its symbol PNG when the
  PNG copy (or a PNG upload) is square and at least 144px, else the first
  letter of its name drawn in the workspace primary color. Icons are drawn
  on the server (a small stroke font, PNG via CompressionStream), no
  library. public/sw.js shows push notifications and focuses or opens
  their link; it caches nothing and has no fetch handler. The workspace
  shell registers it and re-sends this browser's subscription on each
  load (a shared device then belongs to whoever is signed in); iPhone and
  iPad users in Safari see a dismissible "Install on your phone" hint.
  Signing out (hub sign-out button) forgets this browser's subscription.
- Push (src/server/push.ts): subscriptions per person per browser, with
  the host they were made on; only the browsers' own push services are
  accepted as endpoints (FCM, Mozilla, Apple, WNS); 404 or 410 from a push
  service deletes the subscription; at most 10 per person. Routes:
  GET /api/push/key, POST and DELETE /api/push/subscribe (signed in).
- Fan-out (src/server/notify.ts), all after the change commits, never
  throwing, logging counts only:
  - notifyNewOrders from the cron sync, the Sync button and webhooks. Each
    order is claimed once (UPDATE orders SET notified_at WHERE it is
    null), so a cron run and a webhook that race announce it once.
    Orders created more than 24 hours ago are claimed silently (a first
    sync backfills 60 days); more than 5 at once become one summary push
    and one summary email.
  - Push to members whose new-order push is on (default on), linking to
    the order on the host the device subscribed on (the client host for a
    device that subscribed there, else the hub). Payload: order number,
    customer first name, total, link; on the hub the workspace name too.
  - Email to the workspace notification list plus members whose email is
    on (default on), deduplicated by address, ONE MESSAGE PER ADDRESS
    (nobody sees the other recipients), workspace sender via senderFor,
    branded via renderEmail, subject "New order #1001 from <customer>".
    The summary carries the customer name, items and total, never the
    customer's email or address.
  - notifyActivity: status changes (from the app or from Shopify) and
    notes, pushed to members who opted into all activity, never about
    their own change; a note's text is never in the push.
  - notifyPoSent(db, env, workspaceId, {poId, poNumber, orderId,
    orderName, vendorName, actorId}) is ready for Phase 7: the same
    audience; the sender's own devices get no push.
- Settings: "Your notifications" first for everyone (this device's push
  with Enable push on this device / Turn off on this device, the iPhone
  steps where needed, and three switches per workspace: push for new
  orders and purchase orders, email for the same, push for all other
  activity). GET/PUT /api/workspaces/[id]/notification-prefs. The
  manager section formerly "Notifications and email" is now "Workspace
  email" (same id, #notifications).
- Bell (top bar, last control): unread = events newer than
  workspace_members.last_seen_at not made by the viewer (99+ cap),
  dropdown of the 30 newest with order links, Mark all read
  (POST /api/workspaces/[id]/seen). Successful Shopify status writes stay
  out of the bell; failed ones show. It reloads on every live event and
  resync, and toasts status changes and notes by others. Platform admins
  who are not members see the feed with no count (no per-user record was
  added).
- Known limits and things not verified live:
  - No real push was sent: the VAPID secrets are not set and local dev
    has no push service. Verify on a phone after the secrets are set
    (Android Chrome, and an iPhone with the app added to the home screen).
  - A workspace symbol with transparent corners shows black corners on
    the iPhone home screen (iOS fills transparency).
  - A browser whose push service is not FCM, Mozilla, Apple or WNS is
    refused (400) when it subscribes.
  - Live sockets do not run under `next dev`, so there the bell refreshes
    only when opened; in production it follows the room's events.
  - An order_new event is stamped with its sync run's start, so an order
    landing during a long run just after Mark all read can count as read.
  - Client hosts still have no sign-out button (only the hub has one), so
    signing out there cannot forget the device yet.

## STATE UPDATE, 2026-10-04 order history import (supersedes above)

- Branch build/m1-core, on top of fb95252: 22b967e (import engine, cron
  tick, routes, migration 0008), f162bc0 (Settings panel), plus this docs
  commit. Not pushed, not deployed.
- NEW MIGRATION 0008 (drizzle/0008_order_history_import.sql): seven
  columns on store_connections (backfill_status, backfill_since,
  backfill_cursor, backfill_imported NOT NULL DEFAULT 0,
  backfill_started_at, backfill_finished_at, backfill_error), additive,
  existing rows read as "never imported". Applied locally. DEPLOY ORDER:
  `npm run db:migrate:remote` FIRST (applies 0007 and 0008), then deploy.
  runSync selects the whole store_connections row and drizzle names every
  column in an insert, so code deployed before 0008 fails every sync and
  every connection save (the sync test pinning the minimum schema is
  raised to 0008).
- Engine (src/server/sync/backfill.ts, header documents the rules):
  - startBackfill / cancelBackfill / getBackfillView; routes GET, POST
    ({range: "all"} or {range: "since", since: ms}) and DELETE
    /api/workspaces/[id]/backfill, requireMember(id, "platform"), so 404
    for everyone else and for a platform admin on a client host. 400 bad
    input or a start date less than a day ago, 409 no connected store, a
    connection in error or an import already running, 422 missing
    read_all_orders.
  - The cron (runAllSyncs) calls runBackfillTick after each workspace's
    sync and roster sync: at most BACKFILL_PAGES_PER_TICK = 20 pages of 5
    orders, about 20 Shopify requests and under 200 D1 statements. Query:
    the sync's ORDER_FIELDS (same cost, 798), sortKey CREATED_AT, reverse
    (newest first), search created_at >= since and < (start minus 24
    hours). Its own cursor in backfill_cursor; sync_cursor,
    sync_cursor_since, last_sync_at, last_error and status are never
    written by it.
  - Lease: a tick takes running_until like runSync (so it never overlaps a
    sync of the same workspace; a Sync button press during a tick answers
    "already running"), waits while sync_cursor is set (regular sync
    catching up), pauses while the store is disconnected, and fences every
    progress write on its lease and on the import's started_at, so a stop,
    a new import, a connection save or a disconnect wins. A shop change in
    saveConnection clears the import; new credentials for the same shop
    keep it.
  - Writes only orders not stored yet, through insertNewOrder (extracted
    from writeOrderSnapshot in run.ts): conflict no-op inserts,
    initialStatusFor (status tag, else linked Shopify state, else first
    status), orders.notified_at set at insert (so notifyNewOrders never
    claims them) and an order_new event "Order #N imported from the
    store's order history" with meta.imported = true. Stored orders are
    not claimed or rewritten (the regular sync owns them). Orders Shopify
    returns outside the range are skipped.
  - CHOICE on order_new: the events are created (the drawer timeline shows
    the import) and marked; the bell (src/server/activity.ts bellWorthy)
    leaves meta.imported events out of the feed and the unread count.
  - Failures: a blip (throttle, 5xx, timeout) keeps it running with
    backfill_error shown and the cursor kept; rejected credentials, a 401
    or a GraphQL error Shopify will repeat (a stale cursor) fail it; a
    reconnect without read_all_orders fails it at the next tick without
    asking Shopify.
  - Open desks refresh through a new live event, orders.imported {count}:
    a refetch with nothing announced or flashed (older clients ignore the
    unknown kind).
- Settings > Store connection > Order history (platform admins, hub):
  src/components/settings/order-history.tsx, helpers in
  src/lib/order-history.ts. Polls GET every 30 seconds while running and
  visible.
- Known limits and things not verified live:
  - No live import has run: the created_at search with an exact
    timestamp, sortKey CREATED_AT with reverse, and Shopify's behavior
    without read_all_orders (assumed: silently only the last 60 days) are
    from Shopify's published docs and stubbed tests only. First live run:
    start "Orders since" a recent date inside 60 days and watch the
    "[backfill]" log lines and the count.
  - Whether read_all_orders needs a request in the Dev Dashboard before an
    app can be granted it was not checked.
  - Historical orders that Shopify never fulfilled (cancelled, refunded,
    picked up without a fulfillment) start in the first status (New), so a
    big import can swell that count. Moving them is a manual job for now.
  - Speed: about 600 orders an hour (100 per 10 minute tick), and nothing
    while the regular sync is catching up. A cancel during a tick's write
    loop lets that loop finish (at most 100 inserts) before it stops.
  - After an import, later Shopify changes to an imported order follow the
    normal rules (the regular sync refreshes it, and a status move from
    Shopify writes the status tag back like any order).
  - `npx tsc --noEmit` with the checked-in incremental setting reported no
    errors while `npx tsc --noEmit --incremental false` found one during
    this stage (a stale tsconfig.tsbuildinfo); run the second form before
    committing.


## STATE UPDATE, 2026-10-05 Phase 7 purchase orders (supersedes above)

- Branch build/m1-core, on top of 5a2e1cf: dca47a8 (numbering, migration
  0009), 955698a (PDF renderer, pdf-lib), 2ea6297 (drafts, confirmed send,
  PDF route), 964e13a (dates in the sender's time zone), 592ba00 (review
  modal and drawer history), 0fd198c (full item list prefill, From name),
  plus this docs commit. Not pushed, not deployed.
- NEW MIGRATION 0009 (drizzle/0009_purchase_order_sends.sql), additive:
  purchase_orders gains currency (NOT NULL DEFAULT 'USD'), last_error,
  send_started_at, send_attempt, sent_to, sent_by, send_count (NOT NULL
  DEFAULT 0) and updated_at. Applied locally. DEPLOY ORDER:
  `npm run db:migrate:remote` FIRST (applies 0007, 0008 and 0009), then
  deploy. The PO routes name every column, so code deployed before 0009
  fails every PO request (the drawer's Purchase orders section says it did
  not load); nothing else reads the table.
- New dependency: pdf-lib 1.17.1 (pure JS). Lockfile regenerated from
  scratch (15 rolldown bindings kept). No new secrets, bindings or wrangler
  changes: PDFs go to the existing PO_BUCKET (R2 bucket orderingdesk) and
  mail through the existing EMAIL binding.
- Numbering (src/server/po/number.ts): <prefix>-<YYYY>-<NNNN> per
  workspace, prefix and UTC year, minted at a PO's FIRST SEND ATTEMPT (so
  abandoned drafts leave no gaps; a failed send keeps its number for the
  retry). A draft's po_number holds the placeholder "draft:<id>" (the
  column is NOT NULL and unique; prefixes are uppercase letters and digits,
  so it can never look minted). Race safety: read highest + 1, write only
  while the placeholder is there, the (workspace_id, po_number) unique
  index refuses a lost race, retry up to 5 times. A prefix change starts
  that prefix at 0001.
- PDF (src/server/po/pdf.ts): US Letter, primary color band and rules,
  logo from the light logo's PNG copy (or a PNG/JPEG upload; never SVG;
  the workspace name without one), workspace name and reply-to, PO number,
  date, order, vendor, ship-to, a line table that never splits a row and
  repeats its header on continued pages, subtotal, total, notes (line
  breaks kept), footer with page count. Helvetica: text is reduced to
  Windows-1252, so no input can make it throw. Headings use the primary
  pulled toward ink until 4.5:1 on white.
- Send (src/server/po/send.ts, POST /api/pos/[poId]/send): NOTHING is sent
  unless the body has confirm: true and recipients equal to who it would
  go to now (vendor email; copies to the vendor's cc and the workspace
  notification list, deduped); otherwise 400 or 409 with the current
  recipients. A send claims the PO (send_started_at, 2 minute lease), mints
  the number, renders the PDF, stores it at
  pos/<workspaceId>/<poId>-<32 hex>.pdf, emails the vendor (from senderFor,
  display name = the From name setting when set, else the workspace name;
  reply-to the workspace reply-to; branded body via renderEmail; PDF
  attached, capped at 5 MB), marks it sent with a po_sent event, then the
  route broadcasts and calls notifyPoSent (push and email to the
  new-order audience, skipping addresses already on the vendor email;
  the sender gets no push). Every request carries a requestId: repeating
  it answers what that attempt did ("replayed"); a sent PO answers
  "already-sent" unless resend: true (same PDF, first-send date kept, no
  team notification). A failure marks the PO failed with last_error and
  a po_failed event (new TypeScript-only event type; a failed resend stays
  sent) and answers 502; Retry goes through the same confirmation. An
  attempt that never finished (Worker stopped) frees the PO after the
  lease and the PO reads as "interrupted" with a warning to check with the
  vendor.
- Other routes: GET/POST /api/orders/[orderId]/pos (list for staff and up;
  create draft for managers and platform admins), PATCH /api/pos/[poId]
  (save a draft or failed PO), GET /api/pos/[poId]/pdf (members of the
  workspace, staff included; streams only the PO's own pos/ key, private,
  no-store), GET /api/orders/[orderId]/po-lines (managers: the prefill).
  All 404 for outsiders and for another workspace on a client host;
  manager routes 404 for staff. The public branding route only ever reads
  branding/<id>/<pattern name>; a test pins that it cannot reach pos/.
- Prefill (src/server/po/order-lines.ts): the earlier rule "never prefill a
  PO from a list whose itemsTruncated is set" is implemented: a partial
  snapshot is replaced by every line item read from Shopify on demand
  (fetchAllLineItems in src/server/shopify/admin.ts, 100 a page, about 304
  points, at most 10 pages). If that cannot be read (no store, Shopify
  down, over 200 lines), the modal starts with one empty line, says why,
  offers Load the full list again, and keeps Send to vendor blocked; a
  draft can still be saved. The unit cost is always the reviewer's (the
  order price is what the customer paid). Sending needs a cost on every
  line; drafts do not.
- UI: the drawer's Purchase orders section (src/components/desk/
  po-history.tsx) and the review modal (po-modal.tsx; confirmation step
  and send flow in po-send-confirm.tsx). Managers and platform admins see
  Create purchase order, Review and send, Edit, Retry and Send again;
  staff see the list and Open PDF only. A status change that answers
  triggersPo opens the modal for managers; staff get a toast that a
  manager creates the PO. The PDF and email date use the sender's browser
  time zone (UTC without one). Checked in local dev at desktop and phone
  width, light and dark, including a full send (email logged by the dev
  fallback, PDF read back from local R2).
- Known limits and things not verified live:
  - No real vendor email has gone out: Email Service with an attachment is
    covered by the stubbed binding only. First live test: send a PO to an
    address you read, from a workspace with and without a verified sender.
  - The PDF renders under Node (tests, next dev) and the Worker bundle
    builds with OpenNext; it was not exercised under workerd (`npm run
    preview`) or in production.
  - Drafts cannot be deleted yet (they stay in the history as Draft).
  - Numbers use the UTC year while the printed date uses the sender's time
    zone, so a PO sent late on Dec 31 in the Americas can carry next
    year's number.
  - notifyPoSent runs on the first successful send only, not on a resend.
  - A send whose lease expired while it was still running (over 2
    minutes) can overlap a retry; the event log keeps both sends.
