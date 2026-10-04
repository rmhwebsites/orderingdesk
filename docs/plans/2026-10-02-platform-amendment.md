# Ordering Desk - Platform Amendment (Oct 2, 2026)

Approved by Ryan in conversation on Oct 2. Supersedes the original design doc
wherever they conflict. Original: `2026-10-01-order-desk-design.md`.

## 1. Name and domains

- Product name: **Ordering Desk** (APP_NAME). Management hub:
  https://orderingdesk.com (Worker `orderingdesk`, custom domain).
- Each client workspace can have its own host, `orders.<client domain>`
  (IMPACT: orders.impactrentals.store). Visiting a client host opens that
  workspace directly, branded with its logo; orderingdesk.com stays the hub
  that lists every workspace a person belongs to.
- Infra: a client domain whose zone is in Ryan's Cloudflare account is
  attached as a Worker custom domain. A client domain elsewhere uses
  Cloudflare for SaaS custom hostnames on the orderingdesk.com zone (the
  client adds one CNAME). Either way the app resolves host -> workspace.
- Auth cookies are per host, so people sign in on the host they use.
  better-auth must accept every allowed host: the APP_URL host plus every
  workspace's verified custom domain (per-request baseURL and trustedOrigins
  derived from the request host, never from a client-supplied value).

## 2. Access model

- **Platform admins**: Ryan (ryan@rmhwebsites.com, bootstrapped through the
  PLATFORM_ADMIN_EMAILS Worker secret) and anyone a platform admin promotes.
  They see and manage every workspace, create workspaces, connect stores,
  manage branding, domains and email senders, set anyone's role, and invite
  or remove other platform admins.
- **Workspace roles**: `manager` and `staff` (replace owner/admin/member).
  - Staff: view orders, change statuses, add notes.
  - Manager: everything Staff can, plus team invites and removals within the
    workspace, statuses, vendors, notification settings, purchase orders.
  - Store connection, branding, custom domain and email sender: platform
    admins only.
- Clients only ever see workspaces they are members of. Workspace creation is
  platform-admin only.
- **Who can have an account** (sign-up is closed otherwise):
  1. platform admins (bootstrap list or promoted);
  2. anyone with a pending manual invite (managers and platform admins can
     invite);
  3. **tagged Shopify customers, once approved** (revised Oct 4, owner's
     choice "Tag, then approve once"): customers of a workspace's connected
     store carrying the tag `Ordering Desk Manager` or `Ordering Desk Staff`
     REQUEST that role in that workspace, and a manager or platform admin
     of the workspace approves the request once in Settings > Team.
     - Why: a customer tag proves nothing. Any storefront visitor can create
       a customer with tags through the Online Store's own forms (the
       newsletter form posts contact[tags]), so a stranger could tag their
       own email "Ordering Desk Manager" and, before this rule, become a
       manager with no invite.
     - A request that is waiting, or was denied, grants nothing: no sign-in
       email (the usual "check your email" answer), no account, no
       membership.
     - Approval is per (workspace, email, role). Approving works like an
       invite (revised Oct 4, security review): it adds nobody, and the
       person claims the role at their next sign-in or when they open "/",
       whether or not they already have an account. Until then Settings >
       Team lists the request as "Approved, waiting to sign in" (with
       Revoke), the same either way, so approving never shows a manager
       which emails have an account or adds someone who did nothing (a
       manager can put any email on a customer in their own store). Only
       someone already a Shopify-tag member of the workspace sees an
       approval at once (an approved raise takes their role up). A tag
       change that raises access (staff to manager) needs a new approval,
       and the membership stays at the approved role until then; a change
       that lowers it applies at once.
     - Denying revokes any tag-based membership for that email in the
       workspace and closes their open sessions there. A denied request
       stays denied (it does not come back as waiting) until the tag is
       removed and added again. A denied request can still be approved
       later.
     - Removing the tag, deleting the customer or changing its email
       deletes the request and revokes the tag-based membership
       (automatically: customer webhooks plus the periodic sync), so
       tagging again later is a fresh request. So does disconnecting the
       store; after a reconnect the tags come back as new requests.
     - Memberships record their source (`manual` or `shopify`); Shopify
       sync only ever adds or removes `shopify`-sourced memberships, never
       manual ones (it never adds one for an approval either: only the
       person's own sign-in does). A manual membership wins over a tag
       while it exists; removing a manual member also denies an approved
       tag request for their email in that workspace, so the tag cannot
       bring them back (Settings > Team shows such an approval next to the
       manual member). Tag names are per-workspace settings with those
       defaults.
- An email with no route to an account gets the same "check your email"
  response as everyone else (no account enumeration), and no email is sent.

## 3. Shopify connection

- New Shopify custom apps (since Jan 1, 2026) are Dev Dashboard apps with a
  **Client ID and Client secret**, not a long-lived token. Access tokens come
  from the client credentials grant: POST
  https://{shop}/admin/oauth/access_token, form-encoded
  grant_type=client_credentials, client_id, client_secret; tokens expire in
  about 24 hours. The app caches the token encrypted with its expiry and
  renews it shortly before it lapses. The app must be installed on the store.
- Per workspace, stored encrypted with aad = workspaceId: client ID, client
  secret, cached access token. A legacy Admin API token (shpat_) remains a
  supported alternative for stores whose apps predate 2026.
- Credentials are entered only by a platform admin in Settings > Store
  connection. They never appear in chat, logs, responses or the repo.
- Required scopes (Ryan granted broad access): read_orders, write_orders,
  read_customers, read_merchant_managed_fulfillment_orders,
  write_merchant_managed_fulfillment_orders. The connect step verifies them
  and names any that are missing.

## 4. Two-way status sync

- **Shopify -> app, live**: on connect the app registers webhooks
  (orders/create, orders/updated, orders/cancelled, orders/fulfilled,
  orders/partially_fulfilled, fulfillments/create, fulfillments/update,
  customers/create, customers/update, customers/delete) pointing at
  https://orderingdesk.com/api/webhooks/shopify/<workspaceId>. Each delivery
  is verified with HMAC-SHA256 over the raw body using that workspace's client
  secret (constant-time compare), deduplicated by X-Shopify-Webhook-Id, and
  applied idempotently. The 10 minute cron sync stays as the safety net.
- **Status links**: each workspace status may link to a Shopify state:
  `fulfilled` or `delivered` (or nothing). Defaults: Shipped -> fulfilled,
  Delivered -> delivered. No cancel link (Ryan chose not to mirror cancels:
  cancelling in Shopify can refund and email the customer).
  - App -> Shopify: moving an order into a status linked to `fulfilled`
    creates a fulfillment for its open fulfillment orders with
    notifyCustomer: false (Ryan: never email customers from a status change).
  - Shopify -> app: when Shopify reports the order fulfilled or delivered,
    the app moves it to the linked status, but never backward past a later
    status (status sort order defines "later").
- **Status tag**: every app status is written to the Shopify order as one
  tag `Ordering Desk: <Status label>` (replacing any previous Ordering Desk
  tag), so staff see it in Shopify. Editing that tag in Shopify moves the app
  status to the matching label, which is how statuses with no Shopify state
  stay two-way.
- Echo safety: the app's own Shopify writes come back as webhooks; applying
  them must be a no-op when the state already matches. Every change, from
  either side, lands in the order's activity timeline with its source.

## 5. Email (revised Oct 2: client-branded, sent from the client's orders subdomain)

- Default platform sender: `Ordering Desk <orders@orderingdesk.com>`.
- Workspace emails come from **`accounts@orders.<client domain>`** (IMPACT:
  `accounts@orders.impactrentals.store`), derived automatically from the
  workspace's active custom domain, with the workspace name as display name.
  A platform admin may override the address. Cloudflare treats
  `orders.<client domain>` as its own sending domain: it must be onboarded
  under Email Service > Email Sending in Ryan's account (possible only when
  the client's zone is in that account), then verified with a test send from
  Settings. Until then, workspace mail falls back to the platform address
  with the workspace name as display name and the workspace reply-to.
- Every workspace email is **branded to the client**: logo (PNG copy, since
  Gmail and Outlook do not show SVG), primary color for the header rule and
  button (button text picked for contrast), ink and background colors, and
  font stacks with web-safe fallbacks; one shared layout (renderEmail) used
  by sign-in on the client host, invites, sender verification, and later
  notifications and purchase orders. Hub mail keeps the Ordering Desk look.
- Sign-in emails requested on a client host come from and look like that
  workspace; sign-in emails on orderingdesk.com use the platform sender.

## 6. Full per-workspace branding (Ryan, Oct 2)

Goal: a client's workspace should feel like part of their online store.
Platform admins set, per workspace, with a live preview in Settings:

- **Logo** (full horizontal) and **symbol** (square mark), each with an
  optional dark-mode version. Symbol doubles as the browser tab icon.
- **Colors**: primary (buttons, highlights, active filters), ink (headings
  and text), and page background for light mode; dark mode is derived
  automatically from those choices, with optional overrides. Contrast is
  checked live: combinations below WCAG AA for text or controls are shown as
  failing and cannot be saved without picking a passing alternative (the app
  suggests the nearest passing shade). Status colors stay semantic and are
  not overridden by the brand palette.
- **Fonts**: heading font and body font, each picked from a curated list of
  Google Fonts plus a system-font option, loaded at runtime only for that
  workspace. Order numbers and money keep the tabular monospace font so
  columns still line up.
- **Corner radius**: one choice per workspace that drives every surface and
  control together (Sharp, Subtle, Soft, Rounded, Pill), so the radius
  system stays consistent.
- Where it applies: every workspace screen, the sign-in page on the
  workspace's own host, and workspace emails (logo PNG, primary color, the
  chosen fonts with web-safe fallbacks since most mail clients ignore web
  fonts). orderingdesk.com itself keeps the Ordering Desk look.
- Stored in the workspaces.branding JSON alongside the logo assets; every
  value is validated server side (hex colors only, font from the allowlist,
  radius from the enum) because these values reach CSS.

## 7. Carried over from the original Phase 5 part B

- Settings screens for every section above, branding uploads (symbol and full
  logo, each with an optional dark version; SVG sanitized, PNG copies stored
  for email), statuses with the Shopify link field, vendors, notification
  settings, team management with roles, and disconnect-as-disable so the
  one-store-per-workspace rule survives a disconnect.
