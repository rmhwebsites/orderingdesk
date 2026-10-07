# Locations, Request Editing and Order Cancel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship Wave 1b of the comprehensive desk design (section 2): Shopify B2B company locations synced and shown everywhere an address appears, managers editing a request before approval, and managers cancelling an approved order, so the IMPACT team never opens Shopify admin for these jobs.

**Architecture:** A new `locations` table (migration 0012) is filled from Shopify's `companyLocations` on connection save, Refresh connection, a daily cron pass and `company_locations/*` webhooks; every snapshot writer records the card's company location in `orders.location_id`, and one pure formatter (`src/lib/address.ts`) plus one component (`src/components/address-block.tsx`) render every address. Editing (`draftOrderUpdate`) and cancelling (`orderCancel`) are new server services behind manager-only routes, each sent to Shopify once with a fresh read before and a read (never a resend) after a timeout; a new closed Cancelled status and a Shopify-to-app rule move cards cancelled anywhere.

**Tech Stack:** Next.js 16 on Cloudflare Workers via OpenNext, D1 through drizzle-orm 0.45 and drizzle-kit, Shopify Admin GraphQL 2026-10, React 19 with Tailwind v4 tokens and Phosphor icons, vitest 5 with in-memory SQLite built from the real migrations.

---

## Ground rules (read before Task 1, follow on every task)

- Repo: `/Users/ryboss/Documents/RMH LLC/Clients/Impact Rentals/order-desk`, branch `build/m1-core` with Wave 1a merged. The design doc `docs/plans/2026-10-05-comprehensive-desk-design.md` section 2 is binding; this plan implements it.
- Test first. Every task: write the failing test, run it and see the FAIL, write the minimal code, see the PASS, then the gates, then commit. Use @superpowers:test-driven-development. UI tasks also use @design-taste-frontend.
- Gates before EVERY commit: `npm run test` (it runs `drizzle-kit check` first) and `npx tsc --noEmit --incremental false`. Run `npm run build` before the last commit of the wave (Task 26).
- Commit with explicit pathspecs only: `git add <each file>` then `git commit -m "<message>" -- <same files>`. Never `git add -A`. Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push (main auto-deploys). Never add a `build` field to `wrangler.jsonc`.
- No dependency changes are planned. If one ever becomes necessary: `rm -rf node_modules package-lock.json && npm install`, then `grep -c '"node_modules/@rolldown/binding-' package-lock.json` must print 15 or more before committing.
- Migrations are additive only, generated with `npm run db:generate -- --name <name>`, plus reviewed hand-written data steps appended below a `--> statement-breakpoint`. Update the drift test in `src/db/schema.test.ts` and the minimum-migration pin in `src/server/sync/run.test.ts`. Prove the migration on production-shaped data (Task 26).
- Access: 401 signed out; 404 for non-members and for anyone the guard ranks too low. The existing desk rule for manager-only request actions (Approve and Reject answer 403 with a plain sentence to staff members, see `src/app/api/orders/[orderId]/approve/route.ts`) is followed by Edit and Cancel: staff members get 403 with a plain sentence, outsiders 404.
- Every `/w/[slug]` and client-host page calls `requireMemberBySlug` and is dynamic. This wave adds no page, only routes and components inside the existing desk.
- Shopify writes are sent ONCE. A timeout or transport failure is followed by a read, never a resend. Every runtime value travels in GraphQL variables, never spliced into a document.
- UI: tokens only (no hard-coded colors), Phosphor icons, light default plus dark, phone width works (375 px), AA contrast, 40 to 44 px touch targets, chip text at least 12 px. Reuse Wave 1a's kit, which is merged before this wave starts: `Chip` (sizes `sm`, `md`, `lg`), `InlineMessage`, `Section` and `Spinner` from `@/components/kit`, `ui.buttonDangerSecondary` for a button that opens a destructive step, and the busy pattern (`aria-busy={busy || undefined}`, `<Spinner />` in place of the leading icon, a label with no ellipsis such as "Saving"). `ToneChip` no longer exists: Wave 1a's guard test (`src/components/kit-adoption.test.ts`) fails on the word anywhere under `src/components` or `src/app`, and its busy-button guard (`src/components/ui.test.ts`) fails on a label ending in `...`. Wave 1a replaced several files this plan touches (`order-list.tsx`, the review panel, the event icons); where a step below names Wave 1a's version, find the place by the quoted code.
- Copy: zero em-dashes, zero en-dashes, zero emoji, in code, tests, docs and commits.
- A PreToolUse hook rejects any file write containing the RegExp exec method written with its leading dot, or the DOM inner-HTML property written as one word. Use `String.match` and JSX only.
- The repo is public: no client employee names, emails or phone numbers anywhere. Use `@example.com` addresses, `+1555555xxxx` phones and invented names (the tests here use Jordan Vale, Casey Lin, Riley Oakes, as the repo already does).
- Line numbers in **Files** blocks are from the repo as it is today (production plus the design doc). Wave 1a moves some of them; find the place by the quoted code instead.

## Decisions this plan makes (within the design; do not re-open them while building)

1. **Location ids.** `locations.shopify_location_id` and `orders.location_id` both hold the Shopify company location's legacy id, the numeric tail of `gid://shopify/CompanyLocation/<id>`, read straight from the purchasing entity (no lookup, works before the location is synced). Join on `(workspace_id, shopify_location_id)`. `locations.id` is an internal random UUID used only as the primary key. Wave 1c's `order_search.location_id` and `people.location_id` carry the same Shopify legacy id.
2. **Location freshness.** `locations.updated_at` is when the desk last confirmed the row against Shopify. A complete sync touches every row it saw and marks rows it did not see `active = 0` (kept, never deleted: cards still name them). The cron runs the sync when the workspace has no rows or its newest `updated_at` is 24 hours old. Location sync needs `read_companies` or `write_companies` and never runs without it.
3. **Webhooks.** `COMPANY_LOCATIONS_CREATE`, `_UPDATE` and `_DELETE` are registered only with a companies scope, after the base topics and before the draft topics (draft topics stay last, as `replaceWebhookSubscriptions` stops at the first refusal; Shopify accepts the location topics with `read_customers`, which every connection has).
4. **Orders query.** The order selection gains `cancelledAt` always, and `purchasingEntity { __typename ... on PurchasingCompany { location { id } } }` only when the stored grant holds a companies scope (`companiesEnabled`): that fragment needs `read_companies`, which is not a required scope, and any GraphQL error fails a whole sync. With it the page estimate goes from 783 to 798 of the 800 budget in `client.test.ts`; any later field must give points back. A store without a companies scope keeps syncing, and its cards get no `location_id` from orders (drafts already need `read_companies`).
5. **Address rule.** With a company location: the location name is the heading (bold), then the order's own street lines (no recipient or company line), falling back to the location's synced address; phone last. Without a location: today's lines (recipient, company, street, locality, country). Stored purchase order ship-to lines read their first line as the heading (the PDF already bolds it).
6. **Edit scope.** Managers and platform admins, drafts only. Needs `write_draft_orders` and `read_products` (variant ids). Refused for custom lines, lines with their own discount or price override, bundles, more than 50 lines, and lines whose variant is gone. The update sends `lineItems` (uuid, variantId, new quantity, every custom attribute exactly as just read from Shopify, never from the capped snapshot), `purchasingEntity` (always, for a B2B draft) and `shippingAddress` only when the location changes (the location's synced address with the current recipient's first and last name). Nothing else, so tags, note, cart attributes and the order discount are untouched.
7. **Edit concurrency.** The editor's GET reads the draft fresh and returns Shopify's `updatedAt`. The save reads again and refuses when it moved, returning the fresh editor. After a save, Shopify's total is read (waiting for `ready`); above $0 the drawer warns that Approve needs $0.
8. **Cancel scope.** Managers and platform admins, orders only, $0 orders only (Ordering Desk never refunds). `orderCancel(orderId, reason: OTHER, restock: false, notifyCustomer: false, staffNote: "Ordering Desk: <reason>" cut to 255)`, `refundMethod` left out (2026-10: no refund when omitted). Shopify cancels in a background job: an accepted cancel is read back up to 3 times; the card moves either way, and the drawer says "not confirmed yet" until the snapshot carries `cancelledAt`.
9. **Cancelled status rules.** The status control never moves a card into the status linked to `cancelled` (orders: "Use Cancel order..."; requests: "A request is rejected, not cancelled..."). Only a manager moves a card out of it, and only to a status with no Shopify link.
10. **Shopify to app.** An order snapshot that newly carries `cancelledAt` moves the card to the cancelled status from any status ("Cancelled in Shopify. Status set to Cancelled"); it wins over a tag, a fulfillment or a draft completion in the same change. A status tag never moves a card into Cancelled. An order first seen already cancelled starts in Cancelled.
11. **Backfill.** Cards stored before 0012 get `location_id` after each location sync when their stored location name matches exactly one location of the workspace. New snapshots carry the id and need no backfill. The backfill is one UPDATE over every card of the workspace still without a location (no newest-N window, which plain orders that never name a location would fill and stall), so it stays cheap enough to run after each location webhook too.

## Shopify documents (validated against the Admin schema with the Shopify dev validator; `orderCancel` arguments checked on shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCancel)

| Document | Where | Estimated cost |
|---|---|---|
| `query CompanyLocations` (50 a page) | `src/server/shopify/locations.ts` | 153 |
| `query CompanyLocationById` | same | 3 |
| `ORDER_FIELDS` with `cancelledAt` and the purchasing entity location (the location only with a companies scope) | `src/server/shopify/client.ts` | 798 a page of 5 (783 without) |
| `query DraftForEdit` (50 lines) | `src/server/shopify/admin.ts` | 310 |
| `mutation EditDraft` (`draftOrderUpdate`, returns `DRAFT_FIELDS`) | same | 161 |
| `query OrderCancelState` | same | 3 |
| `mutation CancelOrder` (`orderCancel`) | same | 3 |

Re-run the validator in your own session if the Shopify dev MCP is available (`validate_graphql_codeblocks`, api `admin`), and keep the Stage 0 live checks in Task 25.

## Notes for Wave 1c (search and people)

- Join cards to their location on `(orders.workspace_id, orders.location_id) = (locations.workspace_id, locations.shopify_location_id)`; `order_search.location_id` and `people.location_id` carry the same Shopify legacy id.
- Write the search row in the two new write paths too: the edit writes the draft through `upsertFetchedDraft` (index there), and the exported `cancelOrder(db, ctx, body, deps)` in `src/server/desk/cancel-order.ts` changes the status (wrap it and index the card when the result is `kind: "cancelled"`; its after-response `followCancellation` writes the order through `upsertFetchedOrder`). Shopify's own cancellations already flow through `applyShopifyMove` inside the sync writers. Wave 1c's plan does exactly this (its Tasks 5 and 6).
- The location name for the haystack is `locations.name` through that join, else the draft snapshot's `location`.

## Task overview

| # | Task |
|---|---|
| 1 | Address formatter |
| 2 | Migration 0012: schema, generated SQL, drift test |
| 3 | Migration 0012: Cancelled status data step and defaults |
| 4 | Normalizer: location id and cancelledAt |
| 5 | Snapshot writers record orders.location_id |
| 6 | Shopify company location documents |
| 7 | Location sync service |
| 8 | Run the location sync: cron, save, Refresh connection |
| 9 | Company location webhooks |
| 10 | Read model: location, branch and cancelled on cards |
| 11 | AddressBlock component and the drawer's ship-to |
| 12 | Branch column in the desktop list |
| 13 | Purchase order surfaces use the formatter |
| 14 | Status rules for the cancelled status |
| 15 | Shopify to app: cancellations move cards |
| 16 | Shopify cancel documents |
| 17 | Cancel service |
| 18 | Cancel route |
| 19 | Cancel in the drawer |
| 20 | Edit helpers (pure) |
| 21 | Shopify edit documents |
| 22 | Edit service |
| 23 | Edit routes |
| 24 | Edit in the drawer |
| 25 | HANDOFF state update |
| 26 | Final verification |

---

### Task 1: Address formatter

**Files:**
- Create: `src/lib/address.ts`
- Create: `src/lib/address.test.ts`
- Modify: `src/lib/order-snapshot.ts:149-156` (`shippingLines` delegates to the formatter)
- Test: `src/lib/address.test.ts`, existing `src/lib/order-snapshot.test.ts`

**Step 1: Write the failing test** (`src/lib/address.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  addressBlock,
  addressBlockFromLines,
  addressBlockLines,
  locationAddressLines,
  oneLineAddress,
  placeLabel,
  readLocationAddress,
  shippingAddressLines,
  type LocationAddress,
} from "./address";

// One formatter for every address the desk shows (comprehensive design
// section 2): a company location reads as its name, then the address; with
// no location, the address alone.

const BUFORD: LocationAddress = {
  address1: "100 Example Way",
  address2: "Suite 4",
  city: "Buford",
  province: "Georgia",
  provinceCode: "GA",
  zip: "30518",
  country: "United States",
  countryCode: "US",
  phone: "+15555550100",
  company: "Example Rentals",
};

const SHIPPING = {
  name: "Casey Lin",
  company: "Example Rentals, Buford HQ",
  phone: "+15555550111",
  a1: "100 Example Way",
  a2: "",
  city: "Buford",
  prov: "GA",
  zip: "30518",
  country: "US",
};

describe("readLocationAddress", () => {
  it("reads a stored address defensively, and nothing without any address line", () => {
    expect(readLocationAddress(BUFORD)).toEqual(BUFORD);
    expect(readLocationAddress({ address1: " 1 Main St ", countryCode: "US", phone: 7 })).toEqual({
      address1: "1 Main St",
      address2: "",
      city: "",
      province: "",
      provinceCode: "",
      zip: "",
      country: "",
      countryCode: "US",
      phone: "",
      company: "",
    });
    expect(readLocationAddress({ countryCode: "US" })).toBeNull();
    expect(readLocationAddress(null)).toBeNull();
    expect(readLocationAddress("junk")).toBeNull();
  });
});

describe("address lines", () => {
  it("writes a location's street, locality and country, skipping empty parts", () => {
    expect(locationAddressLines(BUFORD)).toEqual(["100 Example Way", "Suite 4", "Buford GA 30518", "US"]);
  });

  it("writes a shipping address with or without its recipient lines", () => {
    expect(shippingAddressLines(SHIPPING, { withRecipient: true })).toEqual([
      "Casey Lin",
      "Example Rentals, Buford HQ",
      "100 Example Way",
      "Buford GA 30518",
      "US",
    ]);
    expect(shippingAddressLines(SHIPPING, { withRecipient: false })).toEqual(["100 Example Way", "Buford GA 30518", "US"]);
  });
});

describe("addressBlock", () => {
  it("puts the location name first, then the order's own street lines and phone", () => {
    expect(addressBlock({ locationName: "Buford HQ", locationAddress: BUFORD, shipping: SHIPPING })).toEqual({
      heading: "Buford HQ",
      lines: ["100 Example Way", "Buford GA 30518", "US"],
      phone: "+15555550111",
    });
  });

  it("falls back to the location's synced address when the order has none", () => {
    expect(addressBlock({ locationName: "Buford HQ", locationAddress: BUFORD, shipping: null })).toEqual({
      heading: "Buford HQ",
      lines: ["100 Example Way", "Suite 4", "Buford GA 30518", "US"],
      phone: "+15555550100",
    });
    expect(addressBlock({ locationName: "Buford HQ" })).toEqual({ heading: "Buford HQ", lines: [], phone: null });
  });

  it("shows the address alone, recipient first, without a location", () => {
    expect(addressBlock({ locationName: "  ", shipping: SHIPPING })).toEqual({
      heading: null,
      lines: ["Casey Lin", "Example Rentals, Buford HQ", "100 Example Way", "Buford GA 30518", "US"],
      phone: "+15555550111",
    });
    expect(addressBlock({})).toBeNull();
  });
});

describe("stored ship-to lines (purchase orders)", () => {
  it("reads the first line as the heading", () => {
    expect(addressBlockFromLines(["Buford HQ", " 100 Example Way ", "", "Buford GA 30518"])).toEqual({
      heading: "Buford HQ",
      lines: ["100 Example Way", "Buford GA 30518"],
      phone: null,
    });
    expect(addressBlockFromLines(["", "  "])).toBeNull();
  });

  it("writes a block back as lines, heading first, for the ship-to field", () => {
    expect(addressBlockLines(addressBlock({ locationName: "Buford HQ", shipping: SHIPPING }))).toEqual([
      "Buford HQ",
      "100 Example Way",
      "Buford GA 30518",
      "US",
    ]);
    expect(addressBlockLines(null)).toEqual([]);
  });

  it("joins the address lines on one line for compact lists", () => {
    expect(oneLineAddress(addressBlock({ locationName: "Buford HQ", locationAddress: BUFORD }))).toBe(
      "100 Example Way, Suite 4, Buford GA 30518, US",
    );
    expect(oneLineAddress(null)).toBe("");
  });
});

describe("placeLabel", () => {
  it("names the place by the synced location, else the request's own branch field", () => {
    expect(placeLabel("Mableton", "Buford HQ")).toBe("Mableton");
    expect(placeLabel("", " Buford HQ ")).toBe("Buford HQ");
    expect(placeLabel(null, "")).toBe("");
  });
});
```

**Step 2: Run it**

Run: `npx vitest run src/lib/address.test.ts`
Expected: FAIL, `Failed to resolve import "./address"`.

**Step 3: Minimal implementation**

Create `src/lib/address.ts`:

```ts
// One address formatter for every place the desk shows an address
// (comprehensive design section 2): the drawer's ship-to, the list's
// Branch column, the purchase order modal and its send step, the vendor
// email and the PO PDF. A Shopify B2B company location reads as its name
// (bold where the surface can show weight), then the address lines; with
// no location, the address alone, recipient first, exactly as before.
// Pure and import-free: the cron bundle, the PDF renderer, emails and
// client components all use it.

export type LocationAddress = {
  address1: string;
  address2: string;
  city: string;
  province: string;
  provinceCode: string;
  zip: string;
  country: string;
  countryCode: string;
  phone: string;
  company: string;
};

// A snapshot's shipping address (src/lib/order-snapshot.ts and the
// normalizer's Shipping), with a draft's company and phone when present.
export type ShippingLike = {
  name?: string;
  company?: string;
  phone?: string;
  a1: string;
  a2: string;
  city: string;
  prov: string;
  zip: string;
  country: string;
};

// heading: the location name, or null without a location.
export type AddressBlockModel = { heading: string | null; lines: string[]; phone: string | null };

const FIELDS = [
  "address1",
  "address2",
  "city",
  "province",
  "provinceCode",
  "zip",
  "country",
  "countryCode",
  "phone",
  "company",
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmpty(lines: string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function locality(city: string, region: string, zip: string): string {
  return [city.trim(), region.trim(), zip.trim()].filter((part) => part.length > 0).join(" ");
}

// The JSON stored in locations.address, read defensively; null when it is
// not an object or has no address line at all.
export function readLocationAddress(raw: unknown): LocationAddress | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const address = Object.fromEntries(FIELDS.map((field) => [field, text(record[field])])) as LocationAddress;
  return address.address1 || address.address2 || address.city || address.zip ? address : null;
}

export function locationAddressLines(address: LocationAddress): string[] {
  return nonEmpty([
    address.address1,
    address.address2,
    locality(address.city, address.provinceCode || address.province, address.zip),
    address.countryCode || address.country,
  ]);
}

// withRecipient: the name and company lines first (an address shown on its
// own); without, the street lines only (under a location heading).
export function shippingAddressLines(shipping: ShippingLike, opts: { withRecipient: boolean }): string[] {
  const recipient = opts.withRecipient ? [shipping.name ?? "", shipping.company ?? ""] : [];
  return nonEmpty([...recipient, shipping.a1, shipping.a2, locality(shipping.city, shipping.prov, shipping.zip), shipping.country]);
}

export function addressBlock(input: {
  locationName?: string | null;
  locationAddress?: LocationAddress | null;
  shipping?: ShippingLike | null;
}): AddressBlockModel | null {
  const heading = text(input.locationName);
  const shipping = input.shipping ?? null;
  if (heading.length > 0) {
    const own = shipping ? shippingAddressLines(shipping, { withRecipient: false }) : [];
    const lines = own.length > 0 ? own : input.locationAddress ? locationAddressLines(input.locationAddress) : [];
    const phone = (own.length > 0 ? text(shipping?.phone) : text(input.locationAddress?.phone)) || null;
    return { heading, lines, phone };
  }
  if (!shipping) {
    return null;
  }
  return { heading: null, lines: shippingAddressLines(shipping, { withRecipient: true }), phone: text(shipping.phone) || null };
}

// A purchase order's stored ship-to (one line per row): the first line is
// who or where it goes to, the rest the address.
export function addressBlockFromLines(lines: readonly string[]): AddressBlockModel | null {
  const kept = nonEmpty([...lines]);
  if (kept.length === 0) {
    return null;
  }
  return { heading: kept[0], lines: kept.slice(1), phone: null };
}

// The block as plain lines, heading first (the PO ship-to field, plain text).
export function addressBlockLines(block: AddressBlockModel | null): string[] {
  if (!block) {
    return [];
  }
  return block.heading ? [block.heading, ...block.lines] : [...block.lines];
}

// The address lines on one line ("100 Example Way, Buford GA 30518, US").
export function oneLineAddress(block: AddressBlockModel | null): string {
  return block ? block.lines.join(", ") : "";
}

// What a card calls its place: the synced location name, else the
// request's own branch field (a cart attribute or the draft's location).
export function placeLabel(locationName: string | null | undefined, fallback: string): string {
  return text(locationName) || text(fallback);
}
```

In `src/lib/order-snapshot.ts`, add `import { shippingAddressLines } from "./address";` at the top (after the header comment) and replace the body of `shippingLines` (lines 149-156) with:

```ts
// The address as lines: name, company (a draft's), street, locality,
// country. The phone is not an address line. One implementation with the
// address formatter (src/lib/address.ts).
export function shippingLines(shipping: Pick<SnapshotShipping, "name" | "a1" | "a2" | "city" | "prov" | "zip" | "country"> & { company?: string }): string[] {
  return shippingAddressLines(shipping, { withRecipient: true });
}
```

**Step 4: Run it**

Run: `npx vitest run src/lib/address.test.ts src/lib/order-snapshot.test.ts`
Expected: PASS (both files; `order-snapshot.test.ts` proves the old lines are unchanged).

**Step 5: Commit**

Run the gates (`npm run test`, `npx tsc --noEmit --incremental false`), then:

```bash
git add src/lib/address.ts src/lib/address.test.ts src/lib/order-snapshot.ts
git commit -m "feat: one address formatter for locations and ship-to

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/address.ts src/lib/address.test.ts src/lib/order-snapshot.ts
```

---

### Task 2: Migration 0012: schema, generated SQL, drift test

**Files:**
- Modify: `src/db/schema.ts:1-6` (type import), `:129` (`SHOPIFY_LINK_VALUES`), `:155-200` (`orders`: add `locationId` last, after `draftDeletedAt` at line 187), `:202-225` (`events.type`), new `locations` table after `orders`
- Create (generated): `drizzle/0012_locations_edit_cancel.sql`, `drizzle/meta/0012_snapshot.json`; Modify (generated): `drizzle/meta/_journal.json`
- Modify: `src/server/desk/statuses.ts:39-44` (`LINK_NAMES`), `:101` (error copy)
- Modify: `src/lib/event-look.ts` and `src/components/event-icon.tsx` (Wave 1a's one event map for the timeline and the bell: looks and glyphs for the two new event types and for a status move that cancelled an order)
- Modify: `src/lib/live-events.ts:46-57` (`EVENT_TYPES`)
- Modify: `src/server/desk/test-helpers.ts` (append `seedLocation`)
- Test: `src/db/schema.test.ts`, `src/server/sync/run.test.ts:2012-2025`, `src/server/desk/statuses.test.ts:320-367`, `src/lib/live-events.test.ts:55-66`, `src/lib/event-look.test.ts` (Wave 1a's file)

**Step 1: Write the failing tests**

In `src/db/schema.test.ts`:

1. Add `"locations",` to `APP_TABLES` (keep it sorted) and rename the test `"creates all 15 app tables"` to `"creates every app table"`.
2. In the drift test, change `expect(tables.length).toBe(21);` and its comment to:

```ts
    // 17 app tables (invite_sends since 0005, locations since 0012) +
    // user/session/account/verification + rate_limit.
    expect(tables.length).toBe(22);
```

3. Add this test inside `describe("schema migrations", ...)`, after the 0010 test:

```ts
  // Migration 0012 (locations, editing requests, cancel): one row per
  // Shopify company location and workspace, active unless Shopify dropped
  // it, and cards that do not know their location yet.
  it("stores company locations once per workspace and starts cards without a location", () => {
    const insert = db.prepare(
      "INSERT INTO locations (id, workspace_id, shopify_location_id, company_id, name, address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("loc1", "ws1", "101", "7", "Buford HQ", JSON.stringify({ address1: "100 Example Way" }), 1);
    insert.run("loc2", "ws1", "102", "7", "Mableton", null, 1);
    expect(() => insert.run("loc3", "ws1", "101", "7", "Buford again", null, 2)).toThrow(/UNIQUE/);
    expect(() => insert.run("loc4", "ws_missing", "103", null, "Nowhere", null, 2)).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT active, company_id FROM locations WHERE id = ?").get("loc1")).toEqual({ active: 1, company_id: "7" });
    db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("o_loc", "ws1", "7101", "#7101", "{}", "new", 1, 1);
    expect(db.prepare("SELECT location_id FROM orders WHERE id = ?").get("o_loc")).toEqual({ location_id: null });
  });
```

In `src/server/sync/run.test.ts` (line 2012), rename the test from Wave 1a's `"runs a whole cursor chain on the schema as of migration 0011"` to `"runs a whole cursor chain on the schema as of migration 0012"`, change Wave 1a's `openDb({ through: "0011" })` to `openDb({ through: "0012" })`, and append to its comment:

```ts
    // Raised to 0012 by Wave 1b: every order insert names orders.location_id.
    // DEPLOY NOTE, run `npm run db:migrate:remote` (applies 0012) BEFORE the
    // code that needs it reaches production.
```

In `src/server/desk/statuses.test.ts`, the two tests that use `shopifyLink: "cancelled"` as an unknown link (lines 338-342 and 349) must now use another unknown value: replace each `{ shopifyLink: "cancelled" }` there with `{ shopifyLink: "refunded" }`, and change the expected error to:

```ts
      error: "Status 1: the Shopify link must be fulfilled, delivered, draft completed, draft rejected, cancelled or none",
```

Then add:

```ts
  // Comprehensive design section 2: Cancel order and Shopify's own
  // cancellations put an order in the status that follows Shopify's
  // cancelled state. One status per link, like the others.
  it("lets one status follow Shopify's cancelled state", async () => {
    const { db } = await setup();
    const result = await replaceStatuses(db, WS, [
      entry("New", { key: "new", color: "lime" }),
      entry("Cancelled", { color: "slate", shopifyLink: "cancelled" }),
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.statuses.map((s) => [s.key, s.shopifyLink])).toEqual([
      ["new", null],
      ["cancelled", "cancelled"],
    ]);
    const twice = await replaceStatuses(db, WS, [
      entry("Cancelled", { key: "cancelled", color: "slate", shopifyLink: "cancelled" }),
      entry("Void", { shopifyLink: "cancelled" }),
    ]);
    expect(twice).toEqual({
      kind: "invalid",
      error: "Only one status can follow Shopify's cancelled state; Cancelled and Void both do",
    });
  });
```

In `src/lib/live-events.test.ts`, inside `"accepts request entries and a card folded into its request"`, change the loop list to `["draft_completed", "draft_deleted", "draft_edited", "order_cancelled"]`.

Append to `src/lib/event-look.test.ts` (Wave 1a's file), inside `describe("eventLook", ...)`:

```ts
  // Comprehensive design section 2: an edited request is a neutral change;
  // a cancelled order (from the desk or in Shopify) reads red.
  it("gives an edit a neutral look and a cancellation a red one", () => {
    expect(eventLook({ type: "draft_edited", meta: null, source: "app" })).toEqual({ glyph: "edit", tone: "slate" });
    expect(eventLook({ type: "order_cancelled", meta: { confirmed: true }, source: "app" })).toEqual({ glyph: "cancelled", tone: "red" });
    expect(eventLook({ type: "status", meta: { from: "approved", to: "cancelled", action: "cancel" }, source: "app" })).toEqual({
      glyph: "cancelled",
      tone: "red",
    });
    expect(eventLook({ type: "status", meta: { from: "shipped", to: "cancelled", reason: "cancelled" }, source: "shopify" })).toEqual({
      glyph: "cancelled",
      tone: "red",
    });
  });
```

**Step 2: Run them**

Run: `npx vitest run src/db/schema.test.ts src/server/sync/run.test.ts src/server/desk/statuses.test.ts src/lib/live-events.test.ts src/lib/event-look.test.ts`
Expected: FAIL. `no such table: locations` in the new schema test; the pinned run test fails opening `"0012"` with no such migration yet; the cancelled-link test answers `invalid` with the old error copy; the live event test returns `null` for `draft_edited`; the event look test gets the neutral fallback (`{ glyph: "status", tone: "slate" }`) for all four.

**Step 3: Minimal implementation**

`src/db/schema.ts`:

- Below `import type { WorkspaceBranding } from "../lib/branding";` add `import type { LocationAddress } from "../lib/address";`.
- Line 129: `export const SHOPIFY_LINK_VALUES = ["fulfilled", "delivered", "draft_completed", "draft_rejected", "cancelled"] as const;` and extend the `shopifyLink` comment (line 140-145) with: `cancelled: where Cancel order and Shopify's own cancellations put an order (comprehensive design section 2).`
- In `orders`, after `draftDeletedAt: integer("draft_deleted_at"),` add (it must stay the LAST column: the drift test checks the physical order):

```ts
  // The Shopify B2B company location the card ships to (comprehensive
  // design section 2): the legacy id of the purchasing entity's location,
  // the same value as locations.shopify_location_id (join on workspace and
  // that id; no foreign key, the location may not be synced yet). Written
  // by every snapshot writer; null for a card without a company location.
  locationId: text("location_id"),
```

- After the `orders` table add:

```ts
// The workspace's Shopify B2B company locations (comprehensive design
// section 2), synced by src/server/sync/locations.ts. shopify_location_id
// and company_id are Shopify legacy ids. active = false: Shopify no longer
// lists it (kept, so cards still name it). updated_at: when the desk last
// confirmed the row against Shopify (the daily cron pass reads it).
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
```

- In `events.type`, after `"draft_deleted",` add:

```ts
      // A manager edited a request before approval, and an order cancelled
      // from the desk (comprehensive design section 2).
      "draft_edited",
      "order_cancelled",
```

Generate: `npm run db:generate -- --name locations_edit_cancel`. Review `drizzle/0012_locations_edit_cancel.sql`. It must be exactly a `CREATE TABLE \`locations\`` (with `\`active\` integer DEFAULT true NOT NULL`, which SQLite stores as 1, and the foreign key to workspaces), a `CREATE UNIQUE INDEX \`location_shopify_unique\``, and `ALTER TABLE \`orders\` ADD \`location_id\` text;`. If drizzle-kit wrote a `__new_orders` rebuild instead of the ALTER, stop: replace the rebuild with the single ALTER statement and confirm `npx drizzle-kit check` reports no drift. Do not add the data step yet (Task 3).

`src/server/desk/statuses.ts`: add `cancelled: "Shopify's cancelled state",` to `LINK_NAMES`, change line 101 to `return \`${position}: the Shopify link must be fulfilled, delivered, draft completed, draft rejected, cancelled or none\`;`, and add to the comment above `SHOPIFY_LINKS`: `cancelled is where Cancel order and Shopify's own cancellations put an order.`

Event looks (Wave 1a's shared map; the drawer timeline and the bell both read it, so neither file changes):

- `src/lib/event-look.ts`: add `| "edit"` and `| "cancelled"` to `EventGlyph`; in `eventLook` add the cases

```ts
    case "draft_edited":
      return { glyph: "edit", tone: "slate" };
    case "order_cancelled":
      return { glyph: "cancelled", tone: "red" };
```

  and inside `case "status":`, right after the `meta.action === "reject"` check:

```ts
      // Cancel order from the desk, or Shopify's own cancellation
      // (comprehensive design section 2).
      if (meta.action === "cancel" || (event.source === "shopify" && meta.reason === "cancelled")) {
        return { glyph: "cancelled", tone: "red" };
      }
```

- `src/components/event-icon.tsx`: add `import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";` and `import { ProhibitIcon } from "@phosphor-icons/react/Prohibit";`, and `edit: PencilSimpleIcon,` and `cancelled: ProhibitIcon,` to `GLYPHS` (the `Record<EventGlyph, ...>` type makes tsc fail until both are there).

`src/lib/live-events.ts`: add `"draft_edited",` and `"order_cancelled",` to `EVENT_TYPES`.

`src/server/desk/test-helpers.ts` (it already imports `* as schema`), append:

```ts
// A synced company location (src/server/sync/locations.ts), active unless
// told otherwise. Ids are Shopify legacy ids, like the sync writes them.
export async function seedLocation(
  db: Db,
  workspaceId: string,
  opts: {
    shopifyLocationId: string;
    name: string;
    companyId?: string | null;
    address?: import("@/lib/address").LocationAddress | null;
    active?: boolean;
    updatedAt?: number;
  },
) {
  await db.insert(schema.locations).values({
    id: `${workspaceId}_loc_${opts.shopifyLocationId}`,
    workspaceId,
    shopifyLocationId: opts.shopifyLocationId,
    companyId: opts.companyId ?? "7",
    name: opts.name,
    address: opts.address ?? null,
    active: opts.active ?? true,
    updatedAt: opts.updatedAt ?? 1,
  });
}
```

**Step 4: Run them**

Run: `npx vitest run src/db/schema.test.ts src/server/sync/run.test.ts src/server/desk/statuses.test.ts src/lib/live-events.test.ts src/lib/event-look.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/db/schema.ts drizzle/0012_locations_edit_cancel.sql drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json src/server/desk/statuses.ts src/lib/event-look.ts src/lib/event-look.test.ts src/components/event-icon.tsx src/lib/live-events.ts src/server/desk/test-helpers.ts src/db/schema.test.ts src/server/sync/run.test.ts src/server/desk/statuses.test.ts src/lib/live-events.test.ts
git commit -m "feat: migration 0012 locations table, orders.location_id and the cancelled link

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/db/schema.ts drizzle/0012_locations_edit_cancel.sql drizzle/meta/0012_snapshot.json drizzle/meta/_journal.json src/server/desk/statuses.ts src/lib/event-look.ts src/lib/event-look.test.ts src/components/event-icon.tsx src/lib/live-events.ts src/server/desk/test-helpers.ts src/db/schema.test.ts src/server/sync/run.test.ts src/server/desk/statuses.test.ts src/lib/live-events.test.ts
```

---

### Task 3: Migration 0012: Cancelled status data step and defaults

**Files:**
- Modify: `drizzle/0012_locations_edit_cancel.sql` (append the data step)
- Create: `src/db/migration-locations.test.ts`
- Modify: `src/db/schema.test.ts:393-409` (platform migration statuses expectation)
- Modify: `src/server/workspaces.ts:13-28` (`DEFAULT_STATUSES`)
- Modify: `src/server/desk/statuses.ts` (Wave 1a's `CLOSED_LINKS`: a new status linked to cancelled starts closed)
- Modify: `src/components/settings/statuses.tsx:16-22` (export the link options, add Cancelled)
- Modify: `src/server/desk/test-helpers.ts` (append `seedCancelledStatus`)
- Test: `src/db/migration-locations.test.ts`, `src/db/schema.test.ts` (the platform migration test and Wave 1a's "closes the delivered and rejected statuses"), `src/server/workspaces.test.ts:100-114`, `src/server/desk/statuses.test.ts`, `src/components/settings/statuses.test.ts` (Wave 1a created it; append)

**Step 1: Write the failing tests**

Create `src/db/migration-locations.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Migration 0012 (comprehensive design section 2) on rows in the 0011
// shape: a closed Cancelled status linked to Shopify's cancelled state at
// the end of every workspace that has room and none yet; orders keep every
// column and start without a location; the locations table starts empty.
// Production applies it with `npm run db:migrate:remote` before the code
// that reads orders.location_id is deployed.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations(db: Database, include: (file: string) => boolean) {
  for (const file of migrationFiles().filter(include)) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        db.prepare(trimmed).run();
      }
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("migration 0012 on rows in the 0011 shape", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    expect(migrationFiles().some((file) => file.startsWith("0012_"))).toBe(true);
    applyMigrations(db, (file) => file.slice(0, 4) <= "0011");

    const workspace = db.prepare("INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const id of ["ws_a", "ws_full", "ws_named", "ws_linked", "ws_empty"]) {
      workspace.run(id, id, id, "u_owner", 1);
    }
    const status = db.prepare(
      "INSERT INTO statuses (id, workspace_id, key, label, color, sort, triggers_po, shopify_link, closed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // ws_a: the production list after 0011 (Delivered and Rejected closed).
    const list: Array<[string, string, string, string | null, number]> = [
      ["new", "New", "lime", null, 0],
      ["processing", "Processing", "blue", null, 0],
      ["on_hold", "On Hold", "amber", null, 0],
      ["approved", "Approved", "green", "draft_completed", 0],
      ["shipped", "Shipped", "violet", "fulfilled", 0],
      ["delivered", "Delivered", "slate", "delivered", 1],
      ["issue", "Issue", "red", null, 0],
      ["rejected", "Rejected", "pink", "draft_rejected", 1],
    ];
    list.forEach(([key, label, color, link, closed], sort) =>
      status.run(`ws_a_${key}`, "ws_a", key, label, color, sort, key === "approved" ? 1 : 0, link, closed),
    );
    for (let sort = 0; sort < 20; sort++) {
      status.run(`ws_full_${sort}`, "ws_full", `s${sort}`, `S${sort}`, "slate", sort, 0, null, 0);
    }
    status.run("ws_named_c", "ws_named", "cancelled", "Called off", "red", 0, 0, null, 0);
    status.run("ws_linked_v", "ws_linked", "void", "Void", "slate", 3, 0, "cancelled", 1);

    db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, name, shopify, status_key, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("o1", "ws_a", "1001", "#1001", '{"kind":"order"}', "new", 1, 2);
    db.prepare(
      "INSERT INTO orders (id, workspace_id, shopify_order_id, shopify_draft_id, name, shopify, status_key, created_at, synced_at, draft_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("d1", "ws_a", null, "12", "#D12", '{"kind":"draft","location":"Buford, GA"}', "new", 3, 4, "#D12");

    applyMigrations(db, (file) => file.slice(0, 4) === "0012");
  });

  afterAll(() => {
    db.close();
  });

  it("adds a closed Cancelled status last to every workspace with room and none yet", () => {
    expect(
      db
        .prepare(
          "SELECT workspace_id, key, label, color, sort, triggers_po, shopify_link, closed FROM statuses WHERE key = 'cancelled' OR shopify_link = 'cancelled' ORDER BY workspace_id",
        )
        .all(),
    ).toEqual([
      { workspace_id: "ws_a", key: "cancelled", label: "Cancelled", color: "slate", sort: 8, triggers_po: 0, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_empty", key: "cancelled", label: "Cancelled", color: "slate", sort: 0, triggers_po: 0, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_linked", key: "void", label: "Void", color: "slate", sort: 3, triggers_po: 0, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_named", key: "cancelled", label: "Called off", color: "red", sort: 0, triggers_po: 0, shopify_link: null, closed: 0 },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM statuses WHERE workspace_id = 'ws_full'").get()).toEqual({ n: 20 });
    const added = db
      .prepare("SELECT id FROM statuses WHERE key = 'cancelled' AND workspace_id IN ('ws_a', 'ws_empty')")
      .all() as { id: string }[];
    expect(added).toHaveLength(2);
    for (const { id } of added) {
      expect(id).toMatch(UUID);
    }
  });

  it("keeps every order and its columns, with no location yet, and starts with no locations", () => {
    expect(
      db.prepare("SELECT id, name, status_key, created_at, synced_at, draft_name, location_id FROM orders ORDER BY id").all(),
    ).toEqual([
      { id: "d1", name: "#D12", status_key: "new", created_at: 3, synced_at: 4, draft_name: "#D12", location_id: null },
      { id: "o1", name: "#1001", status_key: "new", created_at: 1, synced_at: 2, draft_name: null, location_id: null },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM locations").get()).toEqual({ n: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
```

In `src/db/schema.test.ts`, the platform migration test `"links the shipped and delivered status keys..."` (line 393): select `closed` too (Wave 1a left this test as it was and added its own 0011 case) and expect a Cancelled row last in each workspace:

```ts
  // 0004 links the shipped and delivered keys; 0010 (draft orders) links
  // the approved key to draft_completed and adds a Rejected status last;
  // 0011 closes Delivered and Rejected; 0012 adds a closed Cancelled last.
  it("links the shipped and delivered status keys to their Shopify states, and the draft outcomes", () => {
    expect(
      db
        .prepare("SELECT workspace_id, key, label, sort, shopify_link, closed FROM statuses ORDER BY workspace_id, sort")
        .all(),
    ).toEqual([
      { workspace_id: "ws_custom", key: "sent", label: "Shipped", sort: 0, shopify_link: null, closed: 0 },
      { workspace_id: "ws_custom", key: "rejected", label: "Rejected", sort: 1, shopify_link: "draft_rejected", closed: 1 },
      { workspace_id: "ws_custom", key: "cancelled", label: "Cancelled", sort: 2, shopify_link: "cancelled", closed: 1 },
      { workspace_id: "ws_impact", key: "new", label: "New", sort: 0, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "processing", label: "Processing", sort: 1, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "on_hold", label: "On Hold", sort: 2, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "approved", label: "Approved", sort: 3, shopify_link: "draft_completed", closed: 0 },
      { workspace_id: "ws_impact", key: "shipped", label: "Shipped", sort: 4, shopify_link: "fulfilled", closed: 0 },
      { workspace_id: "ws_impact", key: "delivered", label: "Delivered", sort: 5, shopify_link: "delivered", closed: 1 },
      { workspace_id: "ws_impact", key: "issue", label: "Issue", sort: 6, shopify_link: null, closed: 0 },
      { workspace_id: "ws_impact", key: "rejected", label: "Rejected", sort: 7, shopify_link: "draft_rejected", closed: 1 },
      { workspace_id: "ws_impact", key: "cancelled", label: "Cancelled", sort: 8, shopify_link: "cancelled", closed: 1 },
    ]);
  });
```

In `src/server/workspaces.test.ts` (lines 104-112), the last default is now Cancelled and five statuses carry a link:

```ts
    // Draft orders (spec section 2.3): Approve uses Approved, Reject uses a
    // pink Rejected status; Cancel order uses a closed Cancelled status at
    // the end (comprehensive design section 2).
    expect(statuses.find((s) => s.key === "approved")?.shopifyLink).toBe("draft_completed");
    expect(statuses[statuses.length - 2]).toMatchObject({ key: "rejected", label: "Rejected", shopifyLink: "draft_rejected" });
    expect(statuses[statuses.length - 1]).toEqual({
      key: "cancelled",
      label: "Cancelled",
      sort: statuses.length - 1,
      triggersPo: false,
      shopifyLink: "cancelled",
    });
    expect(statuses.filter((s) => s.shopifyLink !== null)).toHaveLength(5);
```

Wave 1a's 0011 case in `src/db/schema.test.ts` (`"closes the delivered and rejected statuses"`) lists every closed status after all migrations; 0012's closed Cancelled rows now belong in it:

```ts
  // 0011 (work queue) closes Delivered and Rejected; 0012 adds a closed
  // Cancelled.
  it("closes the delivered and rejected statuses", () => {
    expect(db.prepare("SELECT workspace_id, key FROM statuses WHERE closed = 1 ORDER BY workspace_id, key").all()).toEqual([
      { workspace_id: "ws_custom", key: "cancelled" },
      { workspace_id: "ws_custom", key: "rejected" },
      { workspace_id: "ws_impact", key: "cancelled" },
      { workspace_id: "ws_impact", key: "delivered" },
      { workspace_id: "ws_impact", key: "rejected" },
    ]);
  });
```

Append inside `describe("replaceStatuses", ...)` in `src/server/desk/statuses.test.ts` (next to Wave 1a's closed-flag case; `entry` is the file's helper):

```ts
  // A new status that follows Shopify's cancelled state starts closed, like
  // Delivered and Rejected (comprehensive design section 2).
  it("closes a new status linked to cancelled by default", async () => {
    const { db } = await setup();
    const result = await replaceStatuses(db, WS, [
      { key: "new", label: "New", color: "lime", triggersPo: false },
      entry("Cancelled", { shopifyLink: "cancelled" }),
    ]);
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.statuses.map((s) => [s.key, s.closed])).toEqual([
      ["new", false],
      ["cancelled", true],
    ]);
  });
```

Append to `src/components/settings/statuses.test.ts` (Wave 1a's file; add `STATUS_LINK_OPTIONS` to its `import { StatusesSection } from "./statuses";` line, keep everything already there):

```ts
// The statuses editor offers every Shopify link the server accepts
// (SHOPIFY_LINK_VALUES), Cancelled included (comprehensive design section 2).
describe("STATUS_LINK_OPTIONS", () => {
  it("offers no link, the Shopify states and the request outcomes", () => {
    expect(STATUS_LINK_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ["", "No Shopify link"],
      ["fulfilled", "Fulfilled in Shopify"],
      ["delivered", "Delivered in Shopify"],
      ["draft_completed", "Draft approved (order created)"],
      ["draft_rejected", "Draft rejected"],
      ["cancelled", "Cancelled in Shopify"],
    ]);
  });
});
```

**Step 2: Run them**

Run: `npx vitest run src/db/migration-locations.test.ts src/db/schema.test.ts src/server/workspaces.test.ts src/server/desk/statuses.test.ts src/components/settings/statuses.test.ts`
Expected: FAIL. No Cancelled rows after 0012; the platform test and the closed-status test lack the two Cancelled rows; the workspace's last default is still Rejected; a new Cancelled status starts open (`["cancelled", false]`); `STATUS_LINK_OPTIONS` is not exported.

**Step 3: Minimal implementation**

Append to `drizzle/0012_locations_edit_cancel.sql` (the generated part ends with the ALTER; add the breakpoint first):

```sql
--> statement-breakpoint
-- Data step (hand-written, not generated by drizzle-kit; comprehensive
-- design section 2). A Cancelled status at the end of every workspace that
-- has room (fewer than STATUS_LIST_MAX, 20) and no status with the key
-- cancelled or the cancelled link yet, like 0010 added Rejected. Closed
-- (0011), so the Open view leaves cancelled cards out. The id is
-- UUID-shaped like the app's own ids.
INSERT INTO `statuses` (`id`, `workspace_id`, `key`, `label`, `color`, `sort`, `triggers_po`, `shopify_link`, `closed`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-'
             || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       w.`id`, 'cancelled', 'Cancelled', 'slate',
       COALESCE((SELECT max(s.`sort`) FROM `statuses` s WHERE s.`workspace_id` = w.`id`), -1) + 1,
       0, 'cancelled', 1
FROM `workspaces` w
WHERE NOT EXISTS (SELECT 1 FROM `statuses` s WHERE s.`workspace_id` = w.`id`
                  AND (s.`key` = 'cancelled' OR s.`shopify_link` = 'cancelled'))
  AND (SELECT count(*) FROM `statuses` s WHERE s.`workspace_id` = w.`id`) < 20;
```

`src/server/workspaces.ts`: append to `DEFAULT_STATUSES`, after Rejected (keep the `closed` field Wave 1a gave the other entries), and extend the comment above with `Cancelled is where Cancel order and Shopify's own cancellations put an order (comprehensive design section 2; migration 0012 did the same for existing workspaces). Nine rows of nine columns bind 81 parameters, under D1's 100 per statement.`:

```ts
  { key: "cancelled", label: "Cancelled", color: "slate", triggersPo: false, shopifyLink: "cancelled", closed: true },
```

`src/server/desk/statuses.ts`: Wave 1a's `CLOSED_LINKS` becomes

```ts
// Statuses whose cards are finished when they are new: a delivered order,
// a rejected request and a cancelled order (Wave 1b).
const CLOSED_LINKS: readonly string[] = ["delivered", "draft_rejected", "cancelled"];
```

`src/components/settings/statuses.tsx` lines 16-22: rename `LINKS` to an exported `STATUS_LINK_OPTIONS`, add the Cancelled option last, and update every use of `LINKS` in the file:

```ts
// Every Shopify link the server accepts (SHOPIFY_LINK_VALUES), with "none".
export const STATUS_LINK_OPTIONS = [
  { value: "", label: "No Shopify link" },
  { value: "fulfilled", label: "Fulfilled in Shopify" },
  { value: "delivered", label: "Delivered in Shopify" },
  { value: "draft_completed", label: "Draft approved (order created)" },
  { value: "draft_rejected", label: "Draft rejected" },
  { value: "cancelled", label: "Cancelled in Shopify" },
] as const;
```

`src/server/desk/test-helpers.ts`, append:

```ts
// The Cancelled status migration 0012 adds to an existing workspace: closed,
// linked to Shopify's cancelled state, after the statuses already there.
// (closed as Wave 1a declared it: true in boolean mode, 1 in number mode.)
export async function seedCancelledStatus(db: Db, workspaceId: string, sort = 9) {
  await db.insert(schema.statuses).values({
    id: `${workspaceId}_st_cancelled`,
    workspaceId,
    key: "cancelled",
    label: "Cancelled",
    color: "slate",
    sort,
    shopifyLink: "cancelled",
    closed: true,
  });
}
```

**Step 4: Run them**

Run: `npx vitest run src/db/migration-locations.test.ts src/db/schema.test.ts src/server/workspaces.test.ts src/server/desk/statuses.test.ts src/components/settings/statuses.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add drizzle/0012_locations_edit_cancel.sql src/db/migration-locations.test.ts src/db/schema.test.ts src/server/workspaces.ts src/server/workspaces.test.ts src/server/desk/statuses.ts src/server/desk/statuses.test.ts src/components/settings/statuses.tsx src/components/settings/statuses.test.ts src/server/desk/test-helpers.ts
git commit -m "feat: a closed Cancelled status for new and existing workspaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- drizzle/0012_locations_edit_cancel.sql src/db/migration-locations.test.ts src/db/schema.test.ts src/server/workspaces.ts src/server/workspaces.test.ts src/server/desk/statuses.ts src/server/desk/statuses.test.ts src/components/settings/statuses.tsx src/components/settings/statuses.test.ts src/server/desk/test-helpers.ts
```

---

### Task 4: Normalizer: location id and cancelledAt

Why the order selection depends on the grant: the `... on PurchasingCompany { location { id } }` fragment needs `read_companies` (the Shopify validator lists it for that selection; `__typename` alone needs only `read_orders`). `read_companies` is not in `REQUIRED_SCOPES` (`src/server/desk/connection.ts:118-124`), and `shopifyGraphql` treats any GraphQL error as a failure, so a workspace whose app lacks it would fail every orders sync if the fragment were always sent. The orders documents therefore carry the fragment only when the stored grant holds a companies scope; IMPACT has `read_companies`.

**Files:**
- Modify: `src/server/shopify/normalize.ts:37-63` (`NormalizedOrder`), `:67-101` (`NormalizedDraft`), `:285-319` (`normalizeOne`), `:353-410` (`normalizeDraftOne`); add `companyLocationIdOf`
- Modify: `src/server/shopify/client.ts:62-70` (`FetchOrdersOptions`), `:83-99` (cost comment), `:116-137` (`ORDER_FIELDS` split in two), `:194-224` (the orders and history documents), `:244-321` (`fetchOrdersUpdatedSince`, `fetchOrderHistory`, the feeds)
- Modify: `src/server/shopify/admin.ts:52-72` (add `COMPANY_SCOPES` and `companiesEnabled` after `draftsEnabled`), `:194-215` (`ORDER_QUERY` and `fetchOrderNode` take `companies`)
- Modify (callers pass the grant): `src/server/sync/run.ts:674-680`, `src/server/sync/backfill.ts:393-399`, `src/server/shopify/webhooks.ts:279-287` (`draftState`) and `:422`, `src/server/sync/drafts.ts:880-885` (`ensureOrderSnapshots`)
- Test: `src/server/shopify/normalize.test.ts:338-357,400-462`, `src/server/shopify/client.test.ts:198-213,466-481`, `src/server/shopify/admin-drafts.test.ts` (`companiesEnabled`), `src/server/sync/run.test.ts` (new case)

**Step 1: Write the failing tests**

`src/server/shopify/normalize.test.ts`:

1. Import `companyLocationIdOf` from `./normalize`.
2. In `"adds the kind, the source, cart attributes and line item properties"`, append `"cancelledAt"` and `"locationId"` (in that order) to the end of the `Object.keys(order)` list.
3. In `"normalizes a B2B request with its company..."`, add `locationId: "2",` after `poNumber: "PO-77",` (the fixture's location is `gid://shopify/CompanyLocation/2`).
4. Add inside `describe("normalizeOrders", ...)`:

```ts
  // Comprehensive design section 2: an order Shopify cancelled, and the B2B
  // company location the order ships to (the purchasing entity).
  it("reads the cancellation time and the purchasing entity's company location", () => {
    const [order] = normalizeOrders([
      {
        id: "gid://shopify/Order/7901",
        legacyResourceId: "7901",
        name: "#1041",
        cancelledAt: "2026-10-05T16:00:00Z",
        purchasingEntity: { __typename: "PurchasingCompany", location: { id: "gid://shopify/CompanyLocation/101" } },
      },
    ]);
    expect(order.cancelledAt).toBe(Date.parse("2026-10-05T16:00:00Z"));
    expect(order.locationId).toBe("101");
    const [plain] = normalizeOrders([
      { id: "gid://shopify/Order/7902", purchasingEntity: { __typename: "Customer" }, cancelledAt: null },
    ]);
    expect(plain.cancelledAt).toBeNull();
    expect(plain.locationId).toBeNull();
    const [odd] = normalizeOrders([
      { id: "gid://shopify/Order/7903", purchasingEntity: { location: { id: "gid://shopify/Location/5" } }, cancelledAt: "soon" },
    ]);
    expect(odd.locationId).toBeNull();
    expect(odd.cancelledAt).toBeNull();
  });
```

5. Add inside `describe("normalizeDrafts", ...)`:

```ts
  it("reads no location for a customer's own draft", () => {
    const [draft] = normalizeDrafts([{ id: "gid://shopify/DraftOrder/9", purchasingEntity: { __typename: "Customer" } }]);
    expect(draft.locationId).toBeNull();
  });
```

6. Add at the end of the file:

```ts
describe("companyLocationIdOf", () => {
  it("reads the legacy id of a company location gid and nothing else", () => {
    expect(companyLocationIdOf("gid://shopify/CompanyLocation/101")).toBe("101");
    expect(companyLocationIdOf("gid://shopify/Location/101")).toBeNull();
    expect(companyLocationIdOf("gid://shopify/CompanyLocation/0")).toBeNull();
    expect(companyLocationIdOf("gid://shopify/CompanyLocation/1x")).toBeNull();
    expect(companyLocationIdOf(101)).toBeNull();
  });
});
```

`src/server/shopify/client.test.ts`:

1. In the first orders query test (after `expect(query).toContain("countryCodeV2");`, line 210) add:

```ts
    // Comprehensive design section 2: cancellations always; the company
    // location only when the caller says the grant holds a companies scope.
    expect(query).toContain("cancelledAt");
    expect(query).not.toContain("purchasingEntity");
```

  and add a case after it:

```ts
  it("asks for the purchasing entity's company location only with a companies scope", async () => {
    const { impl, calls } = stubFetch([ordersPage([], { hasNextPage: false, endCursor: null })]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl, { companies: true });
    expect(String(calls[0].body.query)).toContain("... on PurchasingCompany { location { id } }");
    expect(orderFieldsFor(false)).not.toContain("purchasingEntity");
    expect(orderFieldsFor(true)).toBe(ORDER_FIELDS);
  });
```

  (import `ORDER_FIELDS` and `orderFieldsFor` from `./client`).

2. Replace the body of `"keeps the orders query inside Shopify's single query cost limit"` with the B2B page (the costlier one) and the plain page:

```ts
    const { impl, calls } = stubFetch([
      ordersPage([], { hasNextPage: false, endCursor: null }),
      ordersPage([], { hasNextPage: false, endCursor: null }),
    ]);
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl, { companies: true });
    await fetchOrdersUpdatedSince(DOMAIN, TOKEN, SINCE, impl);
    const cost = requestedQueryCost(String(calls[0].body.query));
    // Per order: the order itself, its cart attribute list, two price sets
    // of two objects each, the customer, the shipping address, the line item
    // connection and its pageInfo make 11 points, the purchasing entity and
    // its company location (3, the company fragment priced as an object by
    // this estimator) and the fulfillment list (3 slots, priced like a
    // connection, 5) make 19, plus 4 per line item slot (the item, its
    // property list and its price set). On top come 2 for the orders
    // connection and 1 for pageInfo. 798 of the 800 budget: a new field must
    // give points back. Without a companies scope the page is 783.
    expect(cost).toBe(3 + 5 * (19 + 4 * 35));
    expect(cost).toBe(798);
    expect(cost).toBeLessThanOrEqual(QUERY_COST_BUDGET);
    expect(requestedQueryCost(String(calls[1].body.query))).toBe(783);
```

`src/server/shopify/admin-drafts.test.ts`: import `companiesEnabled` from `./admin` and add at the end:

```ts
// Company locations and the purchasing entity's location (comprehensive
// design section 2) need a companies scope, like the drafts need theirs.
describe("companiesEnabled", () => {
  it("needs read_companies or write_companies", () => {
    expect(companiesEnabled(["read_orders", "read_companies"])).toBe(true);
    expect(companiesEnabled(["write_companies"])).toBe(true);
    expect(companiesEnabled(["read_orders", "read_customers"])).toBe(false);
    expect(companiesEnabled(null)).toBe(false);
  });
});
```

`src/server/sync/run.test.ts`, a new case at the end of the file (it uses the file's own `openDb`, `seedWorkspace`, `shopifySim`, `simRequest` and `WS`):

```ts
// Comprehensive design section 2: the orders page names the purchasing
// entity's company location only when the stored grant holds a companies
// scope, so a store without read_companies keeps syncing.
describe("runSync and the companies scope", () => {
  it("asks for the company location only with read_companies or write_companies", async () => {
    const { db, env } = openDb();
    await seedWorkspace(db, WS);
    const sim = shopifySim([]);
    const queries: string[] = [];
    const spy = (async (url: RequestInfo | URL, init?: RequestInit) => {
      queries.push(simRequest(init).query);
      return sim.impl(url, init);
    }) as typeof fetch;
    const T = Date.parse("2026-10-06T12:00:00.000Z");
    expect((await runSync(db, env, WS, { fetchImpl: spy, now: () => T })).error).toBeUndefined();
    expect(queries.at(-1)).not.toContain("PurchasingCompany");
    await db
      .update(schema.storeConnections)
      .set({ scopes: ["read_orders", "write_orders", "read_customers", "read_companies"] })
      .where(eq(schema.storeConnections.workspaceId, WS));
    expect((await runSync(db, env, WS, { fetchImpl: spy, now: () => T + 600000 })).error).toBeUndefined();
    expect(queries.at(-1)).toContain("... on PurchasingCompany { location { id } }");
  });
});
```

**Step 2: Run them**

Run: `npx vitest run src/server/shopify/normalize.test.ts src/server/shopify/client.test.ts src/server/shopify/admin-drafts.test.ts src/server/sync/run.test.ts`
Expected: FAIL. `companyLocationIdOf`, `companiesEnabled` and `orderFieldsFor` are not exported; the key list lacks the two new keys; the cost is 783 and the query has no `cancelledAt`; the run test's second query has no `PurchasingCompany`.

**Step 3: Minimal implementation**

`src/server/shopify/normalize.ts`:

- Add to `NormalizedOrder`, after `attributes: Attribute[];`:

```ts
  // When Shopify cancelled the order (ms), or null (comprehensive design
  // section 2: the Shopify to app rule in status-sync.ts moves the card).
  cancelledAt: number | null;
  // The B2B purchasing entity's company location, as a legacy id (the
  // value of orders.location_id and locations.shopify_location_id), or null.
  locationId: string | null;
```

- Add to `NormalizedDraft`, after `poNumber: string;`:

```ts
  // The purchasing entity's company location, as a legacy id, or null.
  locationId: string | null;
```

- After `snapshotKind`, add:

```ts
const COMPANY_LOCATION_GID = /^gid:\/\/shopify\/CompanyLocation\/([1-9]\d{0,19})$/;

// The legacy id of a company location gid ("gid://shopify/CompanyLocation/
// 101" -> "101"), or null for anything else. Shared with
// src/server/shopify/locations.ts and the edit service.
export function companyLocationIdOf(gid: unknown): string | null {
  return typeof gid === "string" ? (gid.match(COMPANY_LOCATION_GID)?.[1] ?? null) : null;
}
```

- After `shippingOf`, add:

```ts
// The purchasing entity's company location as a legacy id; null for a
// customer's own (D2C) order or draft, or a shape this code does not know.
function purchasingLocationIdOf(raw: Dict): string | null {
  const entity = isDict(raw.purchasingEntity) ? raw.purchasingEntity : undefined;
  const location = entity && isDict(entity.location) ? entity.location : undefined;
  return companyLocationIdOf(location?.id);
}
```

- In `normalizeOne`, after `attributes: attributesOf(raw.customAttributes, ATTRIBUTES_MAX),` add `cancelledAt: timeOf(raw.cancelledAt),` and `locationId: purchasingLocationIdOf(raw),`.
- In `normalizeDraftOne`, after `poNumber: str(raw.poNumber),` add `locationId: purchasingLocationIdOf(raw),`.

`src/server/shopify/client.ts`:

- `FetchOrdersOptions` gains:

```ts
  // The stored grant holds a companies scope (companiesEnabled in
  // src/server/shopify/admin.ts): the page then names the purchasing
  // entity's company location, which needs read_companies. Default false.
  companies?: boolean;
```

- Rename `ORDER_FIELDS` to `ORDER_BASE_FIELDS` (not exported), add `cancelledAt` after `updatedAt` in it, and after it add:

```ts
// The purchasing entity's company location (comprehensive design section
// 2). Needs read_companies, so it is sent only when the stored grant holds
// a companies scope (read_companies is not one of REQUIRED_SCOPES).
const ORDER_COMPANY_FIELDS = `
      purchasingEntity {
        __typename
        ... on PurchasingCompany { location { id } }
      }`;

// The full selection (the costlier one, priced in client.test.ts), and the
// one a store without a companies scope gets. normalizeOrders reads both.
export const ORDER_FIELDS = ORDER_BASE_FIELDS + ORDER_COMPANY_FIELDS;

export function orderFieldsFor(companies: boolean): string {
  return companies ? ORDER_FIELDS : ORDER_BASE_FIELDS;
}
```

- Replace `ORDERS_QUERY` and `ORDER_HISTORY_QUERY` with builders, and the two order feeds with lookups (`DRAFTS_FEED` stays a constant):

```ts
function ordersQuery(companies: boolean): string {
  return `
query OrdersUpdatedSince($cursor: String, $search: String) {
  orders(first: ${ORDERS_PER_PAGE}, after: $cursor, sortKey: UPDATED_AT, query: $search) {
    nodes {${orderFieldsFor(companies)}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

function orderHistoryQuery(companies: boolean): string {
  return `
query OrderHistory($cursor: String, $search: String) {
  orders(first: ${ORDERS_PER_PAGE}, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $search) {
    nodes {${orderFieldsFor(companies)}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

const ordersFeed = (companies: boolean): Feed => ({ query: ordersQuery(companies), rootField: "orders" });
const orderHistoryFeed = (companies: boolean): Feed => ({ query: orderHistoryQuery(companies), rootField: "orders" });
```

  Keep each document's comment above its builder. In `fetchOrdersUpdatedSince` pass `ordersFeed(opts?.companies === true)` in place of `ORDERS_FEED`, and in `fetchOrderHistory` pass `orderHistoryFeed(opts.companies === true)` in place of `ORDER_HISTORY_FEED`.

- Replace the cost comment above `ORDERS_PER_PAGE` (lines 83-99) so its numbers read: "One order therefore costs 14 points (the order, its cart attribute list, two price sets of two objects each, customer, shipping address, the purchasing entity and its company location (3 as client.test.ts prices the fragment, sent only with a companies scope), the line item connection and its pageInfo), 5 for its fulfillment list ..., plus 4 per line item slot ... Five orders of up to 35 line items request 3 + 5 x (19 + 4 x 35) = 798 (783 without the company location)." Keep the rest of the comment as it is.

`src/server/shopify/admin.ts`:

- After `draftsEnabled` (line 72):

```ts
// Company locations (comprehensive design section 2): the location sync,
// the location webhooks and the purchasing entity's location on orders
// need a companies scope (the B2B company fields need it). Optional, like
// drafts.
export const COMPANY_SCOPES = ["read_companies", "write_companies"] as const;

export function companiesEnabled(granted: readonly string[] | null | undefined): boolean {
  return Array.isArray(granted) && COMPANY_SCOPES.some((scope) => granted.includes(scope));
}
```

- Replace `ORDER_QUERY` and the head of `fetchOrderNode` (lines 194-215), and import `orderFieldsFor` from `./client` in place of `ORDER_FIELDS`:

```ts
// The same selection as the sync's page query, so the node normalizes to
// exactly the snapshot shape the sync stores. One order costs about 160
// points by the client.test.ts estimator (157 without the company
// location). companies: the stored grant holds a companies scope.
function orderQuery(companies: boolean): string {
  return `query OrderById($id: ID!) {
  order(id: $id) {${orderFieldsFor(companies)}
  }
}`;
}

// The raw order node, or null when Shopify has no such order.
export async function fetchOrderNode(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
  opts?: { companies?: boolean },
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, orderQuery(opts?.companies === true), { id: orderGid }, fetchImpl);
```

  (the rest of the function is unchanged).

The four callers pass the grant:

- `src/server/sync/run.ts` (import `companiesEnabled` from `../shopify/admin`), the `fetchOrdersUpdatedSince` call in `runSync`:

```ts
    const fetched = await fetchOrdersUpdatedSince(connection.shopDomain, token, sinceIso, fetchImpl, {
      ...(resuming ? { startCursor: resume.cursor } : {}),
      companies: companiesEnabled(connection.scopes),
    });
```

- `src/server/sync/backfill.ts` (import `companiesEnabled` from `../shopify/admin`; `readConnection` returns the whole row), the `fetchOrderHistory` call's options become `{ startCursor: connection.backfillCursor ?? undefined, maxPages: BACKFILL_PAGES_PER_TICK, companies: companiesEnabled(connection.scopes) }`.
- `src/server/shopify/webhooks.ts`: `draftState` also returns `companies: companiesEnabled(rows[0]?.scopes)` (its return type gains `companies: boolean`; import `companiesEnabled` from `./admin`), and the order job's call becomes `fetchOrderNode(token.shopDomain, token.token, job.orderGid, fetchImpl, { companies: drafts.companies })`.
- `src/server/sync/drafts.ts`, `ensureOrderSnapshots`: pass `{ companies: true }` as the fifth argument of its `fetchOrderNode` call, with the comment `// Only reached after a draft read, and every draft read names the B2B company (DRAFT_FIELDS), which already needs read_companies.`

`grep -n "ORDERS_FEED\|ORDER_HISTORY_FEED\|ORDER_QUERY\b" src/server/shopify` must print nothing afterwards; any test that imported `ORDER_FIELDS` keeps working (it is the full selection).

**Step 4: Run them**

Run: `npx vitest run src/server/shopify/normalize.test.ts src/server/shopify/client.test.ts src/server/shopify/admin-drafts.test.ts src/server/sync/run.test.ts src/server/sync/backfill.test.ts src/server/shopify/webhooks.test.ts src/server/sync/drafts.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates (the whole suite must stay green: snapshots gained two keys, which existing tests read by name), then:

```bash
git add src/server/shopify/normalize.ts src/server/shopify/normalize.test.ts src/server/shopify/client.ts src/server/shopify/client.test.ts src/server/shopify/admin.ts src/server/shopify/admin-drafts.test.ts src/server/sync/run.ts src/server/sync/run.test.ts src/server/sync/backfill.ts src/server/shopify/webhooks.ts src/server/sync/drafts.ts
git commit -m "feat: snapshots carry the company location id and the cancellation time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/shopify/normalize.ts src/server/shopify/normalize.test.ts src/server/shopify/client.ts src/server/shopify/client.test.ts src/server/shopify/admin.ts src/server/shopify/admin-drafts.test.ts src/server/sync/run.ts src/server/sync/run.test.ts src/server/sync/backfill.ts src/server/shopify/webhooks.ts src/server/sync/drafts.ts
```

---

### Task 5: Snapshot writers record orders.location_id

**Files:**
- Modify: `src/server/sync/run.ts:272-283` (`insertNewOrder` values), `:363-366` (`writeOrderSnapshot` update)
- Modify: `src/server/sync/drafts.ts:513-527` (`insertDraftCard` values), `:641-647` (`writeDraftSnapshot` open card update)
- Create: `src/server/sync/location-id.test.ts`

**Step 1: Write the failing test** (`src/server/sync/location-id.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { openTestDb, seedWorkspace } from "../desk/test-helpers";
import { normalizeDrafts, normalizeOrders } from "../shopify/normalize";
import { upsertFetchedDraft } from "./drafts";
import { upsertFetchedOrder } from "./run";

// Cards record their Shopify company location (comprehensive design section
// 2) from the B2B purchasing entity, in both snapshot writers. A snapshot
// without one keeps what the card already knew.

const WS = "ws_impact";
const NOW = Date.parse("2026-10-06T12:00:00.000Z");

const company = (locationId: string) => ({
  __typename: "PurchasingCompany",
  company: { id: "gid://shopify/Company/7", name: "Example Rentals" },
  location: { id: `gid://shopify/CompanyLocation/${locationId}`, name: "Buford HQ" },
});

const draftNode = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/DraftOrder/12",
  legacyResourceId: "12",
  name: "#D12",
  status: "OPEN",
  createdAt: "2026-10-05T10:00:00Z",
  purchasingEntity: company("101"),
  lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  ...overrides,
});

const orderNode = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Order/9001",
  legacyResourceId: "9001",
  name: "#1234",
  createdAt: "2026-10-05T11:00:00Z",
  purchasingEntity: { __typename: "PurchasingCompany", location: { id: "gid://shopify/CompanyLocation/102" } },
  lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
  ...overrides,
});

async function locationOf(db: Db, id: string) {
  const rows = await db.select({ locationId: schema.orders.locationId }).from(schema.orders).where(eq(schema.orders.id, id));
  return rows[0]?.locationId;
}

describe("orders.location_id", () => {
  it("is written from a draft's company location on insert and on change, and kept when a snapshot has none", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    const [draft] = normalizeDrafts([draftNode()]);
    const added = await upsertFetchedDraft(db, WS, draft, NOW, { silent: true });
    expect(added.kind).toBe("added");
    if (added.kind !== "added") return;
    expect(await locationOf(db, added.orderId)).toBe("101");

    const [moved] = normalizeDrafts([draftNode({ purchasingEntity: company("102") })]);
    expect((await upsertFetchedDraft(db, WS, moved, NOW + 1000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("102");

    const [plain] = normalizeDrafts([draftNode({ purchasingEntity: { __typename: "Customer" }, note2: "changed" })]);
    expect((await upsertFetchedDraft(db, WS, plain, NOW + 2000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("102");
  });

  it("is written from an order's purchasing entity on insert and update, and kept when the order has none", async () => {
    const { db } = openTestDb();
    await seedWorkspace(db, WS);
    const [order] = normalizeOrders([orderNode()]);
    const added = await upsertFetchedOrder(db, WS, order, NOW);
    expect(added.kind).toBe("added");
    if (added.kind !== "added") return;
    expect(await locationOf(db, added.orderId)).toBe("102");

    const [plain] = normalizeOrders([orderNode({ purchasingEntity: { __typename: "Customer" }, note: "changed" })]);
    expect((await upsertFetchedOrder(db, WS, plain, NOW + 1000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("102");

    const [other] = normalizeOrders([
      orderNode({ purchasingEntity: { __typename: "PurchasingCompany", location: { id: "gid://shopify/CompanyLocation/103" } } }),
    ]);
    expect((await upsertFetchedOrder(db, WS, other, NOW + 2000)).kind).toBe("updated");
    expect(await locationOf(db, added.orderId)).toBe("103");
  });
});
```

**Step 2: Run it**

Run: `npx vitest run src/server/sync/location-id.test.ts`
Expected: FAIL, `expected null to be "101"`.

**Step 3: Minimal implementation**

`src/server/sync/run.ts`, in `insertNewOrder`'s `.values({ ... })`, add after `syncedAt: now,`:

```ts
      locationId: order.locationId,
```

In `writeOrderSnapshot`, replace `.set({ shopify: order, syncedAt: now })` with:

```ts
    // The card's company location follows the snapshot when the snapshot
    // names one; a snapshot without one keeps what the card knew.
    .set({ shopify: order, syncedAt: now, ...(order.locationId !== null ? { locationId: order.locationId } : {}) })
```

`src/server/sync/drafts.ts`, in `insertDraftCard`'s `.values({ ... })`, add after `draftName: draft.name,`:

```ts
      locationId: draft.locationId,
```

In `writeDraftSnapshot`, replace `.set({ shopify: draft, syncedAt: now, ...(revived ? { draftDeletedAt: null } : {}) })` with:

```ts
    .set({
      shopify: draft,
      syncedAt: now,
      ...(revived ? { draftDeletedAt: null } : {}),
      ...(draft.locationId !== null ? { locationId: draft.locationId } : {}),
    })
```

**Step 4: Run it**

Run: `npx vitest run src/server/sync/location-id.test.ts src/server/sync/run.test.ts src/server/sync/drafts.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/sync/run.ts src/server/sync/drafts.ts src/server/sync/location-id.test.ts
git commit -m "feat: snapshot writers record the card's company location

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/sync/run.ts src/server/sync/drafts.ts src/server/sync/location-id.test.ts
```

---

### Task 6: Shopify company location documents

**Files:**
- Create: `src/server/shopify/locations.ts`
- Create: `src/server/shopify/locations.test.ts`
- Test: `src/server/shopify/locations.test.ts`, `src/server/shopify/client.test.ts` (cost of the two documents)

(`companiesEnabled` and `COMPANY_SCOPES` already exist in `src/server/shopify/admin.ts` since Task 4.)

**Step 1: Write the failing tests**

Create `src/server/shopify/locations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  COMPANY_LOCATIONS_QUERY,
  LOCATIONS_PAGE,
  MAX_LOCATION_PAGES,
  companyLocationGid,
  fetchCompanyLocation,
  fetchCompanyLocations,
  normalizeCompanyLocation,
} from "./locations";

// Shopify B2B company locations (comprehensive design section 2), against a
// stubbed fetch.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_locations_token_never_leak";

const node = (id: number, name: string, overrides: Record<string, unknown> = {}) => ({
  id: `gid://shopify/CompanyLocation/${id}`,
  name,
  company: { id: "gid://shopify/Company/7" },
  shippingAddress: {
    address1: "100 Example Way",
    address2: null,
    city: "Buford",
    province: "Georgia",
    zoneCode: "GA",
    zip: "30518",
    country: "United States",
    countryCode: "US",
    phone: null,
    companyName: "Example Rentals",
  },
  ...overrides,
});

type Call = { query: string; variables: Record<string, unknown> };

function stub(answer: (call: Call, index: number) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call, calls.length - 1);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const page = (nodes: unknown[], next: string | null) => ({
  data: { companyLocations: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
});

describe("normalizeCompanyLocation", () => {
  it("keeps the legacy ids, the name and the shipping address", () => {
    expect(normalizeCompanyLocation(node(101, " Buford HQ "))).toEqual({
      shopifyLocationId: "101",
      companyId: "7",
      name: "Buford HQ",
      address: {
        address1: "100 Example Way",
        address2: "",
        city: "Buford",
        province: "Georgia",
        provinceCode: "GA",
        zip: "30518",
        country: "United States",
        countryCode: "US",
        phone: "",
        company: "Example Rentals",
      },
    });
  });

  it("degrades a missing address, company or name, and skips nodes without a location id", () => {
    expect(normalizeCompanyLocation(node(102, "", { shippingAddress: null, company: null }))).toEqual({
      shopifyLocationId: "102",
      companyId: null,
      name: "Location 102",
      address: null,
    });
    expect(normalizeCompanyLocation({ id: "gid://shopify/Location/5", name: "Warehouse" })).toBeNull();
    expect(normalizeCompanyLocation(null)).toBeNull();
  });
});

describe("fetchCompanyLocations", () => {
  it("reads every page with the cursor in a variable", async () => {
    const { impl, calls } = stub((_call, index) =>
      index === 0 ? page([node(101, "Buford HQ"), node(102, "Mableton")], "c1") : page([node(103, "Athens")], null),
    );
    const result = await fetchCompanyLocations(DOMAIN, TOKEN, impl);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.complete).toBe(true);
    expect(result.locations.map((location) => location.shopifyLocationId)).toEqual(["101", "102", "103"]);
    expect(calls.map((call) => call.variables)).toEqual([{ cursor: null }, { cursor: "c1" }]);
    expect(calls[0].query).toBe(COMPANY_LOCATIONS_QUERY);
    expect(COMPANY_LOCATIONS_QUERY).toContain(`companyLocations(first: ${LOCATIONS_PAGE}, after: $cursor, sortKey: ID)`);
    expect(MAX_LOCATION_PAGES).toBe(20);
  });

  it("fails on the first page, and reports a partial list when a later page fails", async () => {
    const first = stub(() => new Response("busy", { status: 503 }));
    expect(await fetchCompanyLocations(DOMAIN, TOKEN, first.impl)).toEqual({
      kind: "transient",
      detail: "Shopify responded with HTTP 503",
    });
    const later = stub((_call, index) => (index === 0 ? page([node(101, "Buford HQ")], "c1") : new Response("busy", { status: 503 })));
    const result = await fetchCompanyLocations(DOMAIN, TOKEN, later.impl);
    expect(result).toMatchObject({ kind: "ok", complete: false });
  });
});

describe("fetchCompanyLocation", () => {
  it("reads one location by gid, or null when Shopify has none", async () => {
    const found = stub(() => ({ data: { companyLocation: node(104, "Greenville") } }));
    const result = await fetchCompanyLocation(DOMAIN, TOKEN, companyLocationGid("104"), found.impl);
    expect(result).toMatchObject({ kind: "ok", location: { shopifyLocationId: "104", name: "Greenville" } });
    expect(found.calls[0].variables).toEqual({ id: "gid://shopify/CompanyLocation/104" });
    const gone = stub(() => ({ data: { companyLocation: null } }));
    expect(await fetchCompanyLocation(DOMAIN, TOKEN, companyLocationGid("105"), gone.impl)).toEqual({ kind: "ok", location: null });
  });
});
```

In `src/server/shopify/client.test.ts`, add `import { COMPANY_LOCATION_QUERY, COMPANY_LOCATIONS_QUERY } from "./locations";` and at the end of the file:

```ts
// Company locations (comprehensive design section 2) under the same
// estimate and budget.
describe("company location documents", () => {
  it("prices a page of 50 locations and a single location", () => {
    // The connection (2) and pageInfo (1), plus per location the node, its
    // company and its shipping address.
    expect(requestedQueryCost(COMPANY_LOCATIONS_QUERY)).toBe(3 + 50 * 3);
    expect(requestedQueryCost(COMPANY_LOCATION_QUERY)).toBe(3);
    expect(requestedQueryCost(COMPANY_LOCATIONS_QUERY)).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });
});
```

**Step 2: Run them**

Run: `npx vitest run src/server/shopify/locations.test.ts src/server/shopify/client.test.ts`
Expected: FAIL, `Failed to resolve import "./locations"`.

**Step 3: Minimal implementation**

Create `src/server/shopify/locations.ts`:

```ts
// Shopify B2B company locations (comprehensive design section 2): the
// branches a request ships to. Read with the store's token through
// shopifyGraphql (allowlisted host, timeout, no token in any detail), every
// runtime value in variables. Needs read_companies or write_companies and
// a store with B2B; callers check companiesEnabled first. Callers always
// get a typed result, never an exception. Relative imports on purpose: the
// cron path bundles this into the custom worker entrypoint.

import type { LocationAddress } from "../../lib/address";
import type { AdminFailure } from "./admin";
import { shopifyGraphql } from "./client";
import { companyLocationIdOf } from "./normalize";

// 50 a page costs 153 points by the client.test.ts estimator; at most 20
// pages (1,000 locations) are read per sync.
export const LOCATIONS_PAGE = 50;
export const MAX_LOCATION_PAGES = 20;
export const LOCATION_NAME_MAX = 200;

const LOCATION_FIELDS = `
      id
      name
      company { id }
      shippingAddress { address1 address2 city province zoneCode zip country countryCode phone companyName }`;

export const COMPANY_LOCATIONS_QUERY = `query CompanyLocations($cursor: String) {
  companyLocations(first: ${LOCATIONS_PAGE}, after: $cursor, sortKey: ID) {
    nodes {${LOCATION_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const COMPANY_LOCATION_QUERY = `query CompanyLocationById($id: ID!) {
  companyLocation(id: $id) {${LOCATION_FIELDS}
  }
}`;

export type CompanyLocationRecord = {
  shopifyLocationId: string;
  companyId: string | null;
  name: string;
  address: LocationAddress | null;
};

const COMPANY_GID = /^gid:\/\/shopify\/Company\/([1-9]\d{0,19})$/;

export function companyLocationGid(id: string): string {
  return `gid://shopify/CompanyLocation/${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeCompanyLocation(node: unknown): CompanyLocationRecord | null {
  if (!isRecord(node)) {
    return null;
  }
  const shopifyLocationId = companyLocationIdOf(node.id);
  if (!shopifyLocationId) {
    return null;
  }
  const company = isRecord(node.company) ? node.company : null;
  const address = isRecord(node.shippingAddress) ? node.shippingAddress : null;
  return {
    shopifyLocationId,
    companyId: typeof company?.id === "string" ? (company.id.match(COMPANY_GID)?.[1] ?? null) : null,
    name: str(node.name).slice(0, LOCATION_NAME_MAX) || `Location ${shopifyLocationId}`,
    address: address
      ? {
          address1: str(address.address1),
          address2: str(address.address2),
          city: str(address.city),
          province: str(address.province),
          provinceCode: str(address.zoneCode),
          zip: str(address.zip),
          country: str(address.country),
          countryCode: str(address.countryCode),
          phone: str(address.phone),
          company: str(address.companyName),
        }
      : null,
  };
}

// Every company location of the store. complete is false when the run
// stopped before the last page (the page cap, a page without a cursor, or a
// failure after the first page): the locations gathered are real, but one
// missing from them may still exist, so nothing is deactivated for it.
export async function fetchCompanyLocations(
  shopDomain: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; locations: CompanyLocationRecord[]; complete: boolean } | AdminFailure> {
  const locations: CompanyLocationRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
    const result = await shopifyGraphql(shopDomain, token, COMPANY_LOCATIONS_QUERY, { cursor }, fetchImpl);
    if (result.kind !== "ok") {
      return page === 0 ? result : { kind: "ok", locations, complete: false };
    }
    const connection = result.data.companyLocations;
    if (!isRecord(connection) || !Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) {
      return page === 0 ? { kind: "transient", detail: "unexpected response shape" } : { kind: "ok", locations, complete: false };
    }
    for (const node of connection.nodes) {
      const location = normalizeCompanyLocation(node);
      if (location) {
        locations.push(location);
      }
    }
    if (connection.pageInfo.hasNextPage !== true) {
      return { kind: "ok", locations, complete: true };
    }
    if (typeof connection.pageInfo.endCursor !== "string" || connection.pageInfo.endCursor.length === 0) {
      return { kind: "ok", locations, complete: false };
    }
    cursor = connection.pageInfo.endCursor;
  }
  return { kind: "ok", locations, complete: false };
}

// One location as Shopify has it now, or null when it no longer exists.
export async function fetchCompanyLocation(
  shopDomain: string,
  token: string,
  locationGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; location: CompanyLocationRecord | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, COMPANY_LOCATION_QUERY, { id: locationGid }, fetchImpl);
  if (result.kind !== "ok") {
    return result;
  }
  return { kind: "ok", location: normalizeCompanyLocation(result.data.companyLocation) };
}
```

**Step 4: Run them**

Run: `npx vitest run src/server/shopify/locations.test.ts src/server/shopify/client.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/shopify/locations.ts src/server/shopify/locations.test.ts src/server/shopify/client.test.ts
git commit -m "feat: read Shopify company locations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/shopify/locations.ts src/server/shopify/locations.test.ts src/server/shopify/client.test.ts
```

---

### Task 7: Location sync service

**Files:**
- Create: `src/server/sync/locations.ts`
- Create: `src/server/sync/locations.test.ts`

**Step 1: Write the failing test** (`src/server/sync/locations.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db";
import * as schema from "../../db/schema";
import { encryptSecret } from "../crypto";
import { draftSnapshotOf, openTestDb, seedDraft, seedLocation, seedOrder, seedWorkspace, snapshotOf } from "../desk/test-helpers";
import {
  LOCATIONS_SYNC_EVERY_MS,
  applyLocationWebhook,
  backfillLocationIds,
  getLocation,
  listLocations,
  syncLocations,
  syncLocationsIfDue,
} from "./locations";

// The locations table (comprehensive design section 2) against the real
// migrations and a stubbed Shopify.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_locations_sync_token";
const NOW = Date.parse("2026-10-06T07:00:00.000Z");
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;

type ShopLocation = { id: number; name: string; companyId?: number };

// A store with company locations, two per page so paging is exercised.
// failPage answers that page with a 503.
function fakeShop(initial: ShopLocation[], opts: { failPage?: number } = {}) {
  const state = { list: [...initial], failPage: opts.failPage };
  const ops: string[] = [];
  const toNode = (location: ShopLocation) => ({
    id: `gid://shopify/CompanyLocation/${location.id}`,
    name: location.name,
    company: { id: `gid://shopify/Company/${location.companyId ?? 7}` },
    shippingAddress: {
      address1: "100 Example Way",
      address2: "",
      city: "Buford",
      province: "Georgia",
      zoneCode: "GA",
      zip: "30518",
      country: "United States",
      countryCode: "US",
      phone: "",
      companyName: "Example Rentals",
    },
  });
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/query (\w+)/)?.[1] ?? "unknown";
    ops.push(op);
    if (op === "CompanyLocations") {
      const index = typeof body.variables.cursor === "string" ? Number(body.variables.cursor) : 0;
      if (state.failPage === index) {
        return new Response("busy", { status: 503 });
      }
      const slice = state.list.slice(index * 2, index * 2 + 2);
      const more = state.list.length > index * 2 + 2;
      return Response.json({
        data: { companyLocations: { nodes: slice.map(toNode), pageInfo: { hasNextPage: more, endCursor: more ? String(index + 1) : null } } },
      });
    }
    if (op === "CompanyLocationById") {
      const found = state.list.find((location) => `gid://shopify/CompanyLocation/${location.id}` === body.variables.id);
      return Response.json({ data: { companyLocation: found ? toNode(found) : null } });
    }
    throw new Error("unexpected Shopify request: " + op);
  }) as typeof fetch;
  return { impl, state, ops };
}

async function setup(scopes: string[] | null = ["read_orders", "write_orders", "read_customers", "read_companies"]) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: "impact-rentals.myshopify.com",
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes,
  });
  return db;
}

function rows(db: Db) {
  return db
    .select()
    .from(schema.locations)
    .where(eq(schema.locations.workspaceId, WS))
    .orderBy(asc(schema.locations.shopifyLocationId));
}

async function locationIdOf(db: Db, orderId: string) {
  const found = await db.select({ locationId: schema.orders.locationId }).from(schema.orders).where(eq(schema.orders.id, orderId));
  return found[0]?.locationId ?? null;
}

const THREE: ShopLocation[] = [
  { id: 101, name: "Buford HQ" },
  { id: 102, name: "Mableton" },
  { id: 103, name: "Athens" },
];

describe("syncLocations", () => {
  it("asks Shopify nothing without a companies scope or a connection", async () => {
    const shop = fakeShop(THREE);
    const db = await setup(["read_orders", "read_customers"]);
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toEqual({
      kind: "skipped",
      reason: "no-companies-scope",
    });
    expect(await syncLocations(db, env, "ws_nobody", { fetchImpl: shop.impl, now: () => NOW })).toEqual({
      kind: "skipped",
      reason: "no-connection",
    });
    expect(shop.ops).toEqual([]);
  });

  it("stores every company location, page by page, with its company and address", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toEqual({
      kind: "ok",
      upserted: 3,
      deactivated: 0,
      backfilled: 0,
      complete: true,
    });
    const stored = await rows(db);
    expect(stored.map((row) => [row.shopifyLocationId, row.name, row.companyId, row.active, row.updatedAt])).toEqual([
      ["101", "Buford HQ", "7", true, NOW],
      ["102", "Mableton", "7", true, NOW],
      ["103", "Athens", "7", true, NOW],
    ]);
    expect(stored[0].address).toMatchObject({ address1: "100 Example Way", provinceCode: "GA", countryCode: "US" });
    expect(shop.ops).toEqual(["CompanyLocations", "CompanyLocations"]);
  });

  it("renames, deactivates what Shopify dropped after a complete run, and never deletes", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    shop.state.list = [{ id: 101, name: "Buford Main" }, { id: 103, name: "Athens" }];
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 1000 })).toMatchObject({
      kind: "ok",
      deactivated: 1,
      complete: true,
    });
    expect((await rows(db)).map((row) => [row.shopifyLocationId, row.name, row.active])).toEqual([
      ["101", "Buford Main", true],
      ["102", "Mableton", false],
      ["103", "Athens", true],
    ]);

    // A run that stops early (page 2 fails) deactivates nothing.
    shop.state.list = [...THREE];
    shop.state.failPage = 1;
    expect(await syncLocations(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 2000 })).toMatchObject({
      kind: "ok",
      upserted: 2,
      deactivated: 0,
      complete: false,
    });
    expect((await rows(db)).map((row) => [row.shopifyLocationId, row.active])).toEqual([
      ["101", true],
      ["102", true],
      ["103", true],
    ]);
  });
});

describe("backfillLocationIds", () => {
  it("names the location of cards stored before 0012 by an exact, unambiguous name", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ" });
    await seedLocation(db, WS, { shopifyLocationId: "102", name: "Mableton" });
    await seedLocation(db, WS, { shopifyLocationId: "103", name: "Mableton" });
    await seedDraft(db, WS, { id: "d1", shopify: draftSnapshotOf({ location: "Buford HQ" }) });
    await seedDraft(db, WS, { id: "d2", shopify: draftSnapshotOf({ location: "Mableton" }) });
    await seedDraft(db, WS, { id: "d3", shopify: draftSnapshotOf({ location: "Elsewhere" }) });
    await seedDraft(db, WS, { id: "d4", shopify: draftSnapshotOf({ location: "Buford HQ" }) });
    await db.update(schema.orders).set({ locationId: "999" }).where(eq(schema.orders.id, "d4"));
    await seedOrder(db, WS, { id: "o1" });
    await db.update(schema.orders).set({ draftSnapshot: draftSnapshotOf({ location: "Buford HQ" }) }).where(eq(schema.orders.id, "o1"));

    expect(await backfillLocationIds(db, WS)).toBe(2);
    expect(await locationIdOf(db, "d1")).toBe("101");
    expect(await locationIdOf(db, "d2")).toBeNull();
    expect(await locationIdOf(db, "d3")).toBeNull();
    expect(await locationIdOf(db, "d4")).toBe("999");
    expect(await locationIdOf(db, "o1")).toBe("101");
  });

  // Plain orders never carry a location name, so their cards stay null for
  // good; they must not hide an older card that names its location.
  it("reaches an older named card behind 500 newer cards that carry no name", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ" });
    await seedDraft(db, WS, { id: "older", createdAt: 1, shopify: draftSnapshotOf({ location: "Buford HQ" }) });
    await db.insert(schema.orders).values(
      Array.from({ length: 500 }, (_, i) => ({
        id: `plain${i}`,
        workspaceId: WS,
        shopifyOrderId: `plain-${i}`,
        name: `#${2000 + i}`,
        shopify: snapshotOf({ shopifyOrderId: `plain-${i}`, name: `#${2000 + i}` }),
        statusKey: "new",
        createdAt: 1000 + i,
        syncedAt: 2000,
      })),
    );

    expect(await backfillLocationIds(db, WS)).toBe(1);
    expect(await locationIdOf(db, "older")).toBe("101");
    expect(await backfillLocationIds(db, WS)).toBe(0);
  });

  it("trims the stored name and stays inside the workspace", async () => {
    const db = await setup();
    await seedWorkspace(db, "ws_other");
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ" });
    await seedLocation(db, "ws_other", { shopifyLocationId: "201", name: "Buford HQ" });
    await seedDraft(db, WS, { id: "padded", shopify: draftSnapshotOf({ location: "  Buford HQ  " }) });
    await seedDraft(db, WS, { id: "blank", shopify: draftSnapshotOf({ location: "   " }) });
    await seedDraft(db, "ws_other", { id: "theirs", shopify: draftSnapshotOf({ location: "Buford HQ" }) });

    expect(await backfillLocationIds(db, WS)).toBe(1);
    expect(await locationIdOf(db, "padded")).toBe("101");
    expect(await locationIdOf(db, "blank")).toBeNull();
    expect(await locationIdOf(db, "theirs")).toBeNull();
  });
});

describe("syncLocationsIfDue", () => {
  it("runs when the workspace has no locations, then once a day", async () => {
    const shop = fakeShop(THREE);
    const db = await setup();
    expect((await syncLocationsIfDue(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).kind).toBe("ok");
    expect(await syncLocationsIfDue(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + 3600000 })).toEqual({
      kind: "skipped",
      reason: "not-due",
    });
    expect((await syncLocationsIfDue(db, env, WS, { fetchImpl: shop.impl, now: () => NOW + LOCATIONS_SYNC_EVERY_MS })).kind).toBe("ok");
    expect(LOCATIONS_SYNC_EVERY_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("listLocations and getLocation", () => {
  it("lists a company's active locations by name and reads one by its Shopify id", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Mableton" });
    await seedLocation(db, WS, { shopifyLocationId: "102", name: "Athens" });
    await seedLocation(db, WS, { shopifyLocationId: "103", name: "Closed Yard", active: false });
    await seedLocation(db, WS, { shopifyLocationId: "104", name: "Other Co", companyId: "8" });
    expect((await listLocations(db, WS, { companyId: "7", activeOnly: true })).map((row) => row.name)).toEqual(["Athens", "Mableton"]);
    expect((await listLocations(db, WS)).map((row) => row.shopifyLocationId)).toEqual(["102", "103", "101", "104"]);
    expect(await getLocation(db, WS, "103")).toMatchObject({ name: "Closed Yard", active: false, address: null });
    expect(await getLocation(db, WS, "999")).toBeNull();
  });
});

describe("applyLocationWebhook", () => {
  it("stores a created or updated location, and keeps a deleted or vanished one inactive", async () => {
    const shop = fakeShop([{ id: 104, name: "Greenville" }]);
    const db = await setup();
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW });
    expect((await rows(db)).map((row) => [row.shopifyLocationId, row.name, row.active])).toEqual([["104", "Greenville", true]]);
    await applyLocationWebhook(db, env, WS, { kind: "location-deleted", locationId: "104" }, { fetchImpl: shop.impl, now: () => NOW + 1 });
    expect((await rows(db))[0]).toMatchObject({ active: false, updatedAt: NOW + 1 });
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW + 2 });
    expect((await rows(db))[0]).toMatchObject({ active: true });
    shop.state.list = [];
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW + 3 });
    expect((await rows(db))[0]).toMatchObject({ active: false });
  });

  it("does nothing for a store without a companies scope", async () => {
    const shop = fakeShop([{ id: 104, name: "Greenville" }]);
    const db = await setup(["read_orders", "read_customers"]);
    await applyLocationWebhook(db, env, WS, { kind: "location", locationGid: "gid://shopify/CompanyLocation/104" }, { fetchImpl: shop.impl, now: () => NOW });
    expect(await rows(db)).toEqual([]);
    expect(shop.ops).toEqual([]);
  });
});
```

**Step 2: Run it**

Run: `npx vitest run src/server/sync/locations.test.ts`
Expected: FAIL, `Failed to resolve import "./locations"`.

**Step 3: Minimal implementation** (`src/server/sync/locations.ts`)

```ts
// Company locations (comprehensive design section 2): every Shopify B2B
// company location of the workspace's store, kept in the locations table so
// cards name their branch and show its address, and the request editor
// lists a company's branches. syncLocations runs when the connection is
// saved or refreshed and from the cron once a day (syncLocationsIfDue); the
// company_locations/* webhooks apply one location at a time. A location
// Shopify stops listing is kept, inactive, so cards still name it; rows are
// never deleted. After each sync, cards stored before 0012 get their
// location by name (backfillLocationIds). Needs a companies scope; never
// throws. Relative imports on purpose: the cron path bundles this.

import { and, asc, eq, isNull, lt, max, sql, type AnyColumn } from "drizzle-orm";
import type { Db } from "../../db";
import { rowsAffected } from "../../db/batch";
import { locations, orders, storeConnections } from "../../db/schema";
import { readLocationAddress, type LocationAddress } from "../../lib/address";
import { companiesEnabled, failureText } from "../shopify/admin";
import { fetchCompanyLocation, fetchCompanyLocations, type CompanyLocationRecord } from "../shopify/locations";
import { companyLocationIdOf } from "../shopify/normalize";
import { safeErrorReason } from "../shopify/status-sync";
import { getAccessToken } from "../shopify/token";

export const LOCATIONS_SYNC_EVERY_MS = 24 * 60 * 60 * 1000;

export type LocationSyncResult =
  | { kind: "skipped"; reason: "no-connection" | "no-companies-scope" | "not-due" }
  | { kind: "ok"; upserted: number; deactivated: number; backfilled: number; complete: boolean }
  | { kind: "failed"; error: string };

export type LocationView = {
  shopifyLocationId: string;
  companyId: string | null;
  name: string;
  address: LocationAddress | null;
  active: boolean;
};

export type LocationJob = { kind: "location"; locationGid: string } | { kind: "location-deleted"; locationId: string };

type Deps = { fetchImpl?: typeof fetch; now?: () => number };

function locationView(row: typeof locations.$inferSelect): LocationView {
  return {
    shopifyLocationId: row.shopifyLocationId,
    companyId: row.companyId,
    name: row.name,
    address: readLocationAddress(row.address),
    active: row.active,
  };
}

// The connection's stored grant, or null without an enabled connection.
async function grantOf(db: Db, workspaceId: string): Promise<{ scopes: string[] | null } | null> {
  const rows = await db
    .select({ status: storeConnections.status, scopes: storeConnections.scopes })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const row = rows[0];
  return row && row.status !== "disabled" ? { scopes: Array.isArray(row.scopes) ? row.scopes : null } : null;
}

export async function upsertLocation(db: Db, workspaceId: string, record: CompanyLocationRecord, now: number): Promise<void> {
  await db
    .insert(locations)
    .values({
      id: crypto.randomUUID(),
      workspaceId,
      shopifyLocationId: record.shopifyLocationId,
      companyId: record.companyId,
      name: record.name,
      address: record.address,
      active: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [locations.workspaceId, locations.shopifyLocationId],
      set: { companyId: record.companyId, name: record.name, address: record.address, active: true, updatedAt: now },
    });
}

export async function deactivateLocation(db: Db, workspaceId: string, shopifyLocationId: string, now: number): Promise<void> {
  await db
    .update(locations)
    .set({ active: false, updatedAt: now })
    .where(and(eq(locations.workspaceId, workspaceId), eq(locations.shopifyLocationId, shopifyLocationId)));
}

// The location name a card stored before 0012 carries: the current
// snapshot's, else the draft snapshot's, trimmed; null when neither has one.
// Only draft snapshots name a location (an order snapshot has no location
// field), so backfillLocationIds first skips cards that never were drafts
// (no draft id, no draft snapshot) without reading any JSON.
const nameIn = (snapshot: AnyColumn) => sql`nullif(trim(json_extract(${snapshot}, '$.location')), '')`;
const cardLocationName = sql`coalesce(${nameIn(orders.shopify)}, ${nameIn(orders.draftSnapshot)})`;

// Cards stored before 0012 name their location only by the draft's
// location name: a name that exactly one location of the workspace has
// gives the card that location. Ambiguous or unknown names stay null. One
// statement over every card of the workspace still without a location, so
// cards that can never match (no name) cannot hide older ones that can.
export async function backfillLocationIds(db: Db, workspaceId: string): Promise<number> {
  const sameName = sql`${locations.workspaceId} = ${workspaceId} and ${locations.name} = ${cardLocationName}`;
  const result = await db
    .update(orders)
    .set({ locationId: sql`(select ${locations.shopifyLocationId} from ${locations} where ${sameName})` })
    .where(
      and(
        eq(orders.workspaceId, workspaceId),
        isNull(orders.locationId),
        sql`(${orders.shopifyDraftId} is not null or ${orders.draftSnapshot} is not null)`,
        sql`${cardLocationName} is not null`,
        sql`(select count(*) from ${locations} where ${sameName}) = 1`,
      ),
    );
  return rowsAffected(result, "locations");
}

export async function syncLocations(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  deps: Deps = {},
): Promise<LocationSyncResult> {
  try {
    const grant = await grantOf(db, workspaceId);
    if (!grant) {
      return { kind: "skipped", reason: "no-connection" };
    }
    if (!companiesEnabled(grant.scopes)) {
      return { kind: "skipped", reason: "no-companies-scope" };
    }
    const clock = deps.now ?? Date.now;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const token = await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
    if (token.kind === "unavailable") {
      return { kind: "skipped", reason: "no-connection" };
    }
    if (token.kind !== "ok") {
      return { kind: "failed", error: token.kind === "unreadable" ? "store credentials unreadable" : token.detail };
    }
    const fetched = await fetchCompanyLocations(token.shopDomain, token.token, fetchImpl);
    if (fetched.kind !== "ok") {
      return { kind: "failed", error: failureText(fetched).slice(0, 200) };
    }
    const now = clock();
    for (const record of fetched.locations) {
      await upsertLocation(db, workspaceId, record, now);
    }
    let deactivated = 0;
    if (fetched.complete) {
      // Every location Shopify listed was just touched with `now`; the rest
      // are gone from Shopify.
      const result = await db
        .update(locations)
        .set({ active: false, updatedAt: now })
        .where(and(eq(locations.workspaceId, workspaceId), eq(locations.active, true), lt(locations.updatedAt, now)));
      deactivated = rowsAffected(result, "locations");
    }
    const backfilled = await backfillLocationIds(db, workspaceId);
    return { kind: "ok", upserted: fetched.locations.length, deactivated, backfilled, complete: fetched.complete };
  } catch (e) {
    return { kind: "failed", error: safeErrorReason(e) };
  }
}

// The cron's pass: when the workspace has no locations yet, or its newest
// confirmation is a day old.
export async function syncLocationsIfDue(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  deps: Deps = {},
): Promise<LocationSyncResult> {
  const clock = deps.now ?? Date.now;
  const newest = await db
    .select({ at: max(locations.updatedAt) })
    .from(locations)
    .where(eq(locations.workspaceId, workspaceId));
  const at = newest[0]?.at ?? null;
  if (at !== null && clock() - at < LOCATIONS_SYNC_EVERY_MS) {
    return { kind: "skipped", reason: "not-due" };
  }
  return syncLocations(db, env, workspaceId, deps);
}

export async function listLocations(
  db: Db,
  workspaceId: string,
  opts: { companyId?: string | null; activeOnly?: boolean } = {},
): Promise<LocationView[]> {
  const conditions = [eq(locations.workspaceId, workspaceId)];
  if (opts.companyId) {
    conditions.push(eq(locations.companyId, opts.companyId));
  }
  if (opts.activeOnly) {
    conditions.push(eq(locations.active, true));
  }
  const rows = await db
    .select()
    .from(locations)
    .where(and(...conditions))
    .orderBy(asc(locations.name), asc(locations.shopifyLocationId));
  return rows.map(locationView);
}

export async function getLocation(db: Db, workspaceId: string, shopifyLocationId: string): Promise<LocationView | null> {
  const rows = await db
    .select()
    .from(locations)
    .where(and(eq(locations.workspaceId, workspaceId), eq(locations.shopifyLocationId, shopifyLocationId)))
    .limit(1);
  return rows[0] ? locationView(rows[0]) : null;
}

// One company_locations/* webhook (src/server/shopify/webhooks.ts): the
// location is read fresh and stored, or kept inactive when deleted or gone.
export async function applyLocationWebhook(
  db: Db,
  env: Pick<CloudflareEnv, "ENCRYPTION_KEY">,
  workspaceId: string,
  job: LocationJob,
  deps: Deps = {},
): Promise<void> {
  const grant = await grantOf(db, workspaceId);
  if (!grant || !companiesEnabled(grant.scopes)) {
    return;
  }
  const clock = deps.now ?? Date.now;
  if (job.kind === "location-deleted") {
    await deactivateLocation(db, workspaceId, job.locationId, clock());
    return;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
  if (token.kind !== "ok") {
    return;
  }
  const fetched = await fetchCompanyLocation(token.shopDomain, token.token, job.locationGid, fetchImpl);
  if (fetched.kind !== "ok") {
    console.warn("[locations] " + JSON.stringify({ workspaceId, webhook: failureText(fetched).slice(0, 200) }));
    return;
  }
  const now = clock();
  if (fetched.location === null) {
    const id = companyLocationIdOf(job.locationGid);
    if (id) {
      await deactivateLocation(db, workspaceId, id, now);
    }
    return;
  }
  await upsertLocation(db, workspaceId, fetched.location, now);
  await backfillLocationIds(db, workspaceId);
}
```

**Step 4: Run it**

Run: `npx vitest run src/server/sync/locations.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/sync/locations.ts src/server/sync/locations.test.ts
git commit -m "feat: sync company locations into the locations table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/sync/locations.ts src/server/sync/locations.test.ts
```

---

### Task 8: Run the location sync: cron, save, Refresh connection

**Files:**
- Modify: `src/server/sync/cron.ts:1-9` (import), `:59-76` (a locations block after the roster block)
- Modify: `src/app/api/workspaces/[id]/connection/route.ts:27-56` (PUT: start the sync after a save)
- Modify: `src/app/api/workspaces/[id]/connection/refresh/route.ts` (start the sync after a refresh)
- Test: `src/server/sync/cron.test.ts`, `src/app/api/workspaces/[id]/connection/refresh/route.test.ts`

**Step 1: Write the failing tests**

`src/server/sync/cron.test.ts`: below the existing `vi.mock` calls add

```ts
vi.mock("./locations", () => ({
  syncLocationsIfDue: vi.fn(async () => ({ kind: "skipped", reason: "no-companies-scope" })),
}));
```

below the other dynamic imports add `const { syncLocationsIfDue } = await import("./locations");`, add `vi.mocked(syncLocationsIfDue).mockClear();` to `beforeEach`, and add:

```ts
// Comprehensive design section 2: company locations once a day per store.
describe("runAllSyncs company locations", () => {
  it("checks every enabled workspace's locations, and one failure does not stop the next", async () => {
    const db = await setup();
    vi.mocked(runSync).mockResolvedValue(result());
    vi.mocked(syncLocationsIfDue).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await runAllSyncs(db, env);
    expect(vi.mocked(syncLocationsIfDue).mock.calls.map((call) => call[2]).sort()).toEqual(["ws_a", "ws_b"]);
  });
});
```

`src/app/api/workspaces/[id]/connection/refresh/route.test.ts`:

- Change `const state` to also hold `after: Promise<unknown>[]` (start it as `[]` and reset it in `beforeEach`).
- Change the mocked context's `ctx: {}` to `ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) }`.
- Add `vi.mock("@/server/sync/locations", () => ({ syncLocations: vi.fn(async () => ({ kind: "skipped", reason: "no-companies-scope" })) }));` and `const { syncLocations } = await import("@/server/sync/locations");`, and `vi.mocked(syncLocations).mockClear();` in `beforeEach`.
- In `"refreshes for a platform admin: new token, saved scopes, draft topics registered"`, after the existing assertions add:

```ts
    await Promise.all(state.after);
    // The store's company locations follow, after the response.
    expect(vi.mocked(syncLocations).mock.lastCall?.[2]).toBe("ws_impact");
```

- In `"answers 409 when no store is connected"`, add `expect(syncLocations).not.toHaveBeenCalled();`.

**Step 2: Run them**

Run: `npx vitest run src/server/sync/cron.test.ts "src/app/api/workspaces/[id]/connection/refresh/route.test.ts"`
Expected: FAIL, `syncLocationsIfDue` and `syncLocations` were never called.

**Step 3: Minimal implementation**

`src/server/sync/cron.ts`: add `import { syncLocationsIfDue } from "./locations";` and after the roster `try { ... } catch { ... }` block:

```ts
    // Company locations (comprehensive design section 2): once a day, or
    // while the workspace has none; skipped without a companies scope.
    // Logged as counts only.
    try {
      const synced = await syncLocationsIfDue(db, env, workspaceId, { fetchImpl: opts?.fetchImpl, now: opts?.now });
      if (synced.kind === "ok" || synced.kind === "failed") {
        console.log("[locations] " + JSON.stringify({ workspaceId, ...synced }));
      }
    } catch (e) {
      console.log("[locations] " + JSON.stringify({ workspaceId, error: e instanceof Error ? e.name : "failed" }));
    }
```

`src/app/api/workspaces/[id]/connection/route.ts` (PUT): add `import { syncLocations } from "@/server/sync/locations";`, take `const { env, ctx } = getCloudflareContext();`, and make the `"saved"` case:

```ts
      case "saved":
        // The store's company locations, after the response (never throws).
        ctx.waitUntil(syncLocations(db, env, id));
        return NextResponse.json({
          connection: result.connection,
          ...(result.warning ? { warning: result.warning } : {}),
        });
```

Extend the route's doc comment: "A save or refresh also starts the company location sync after the response (src/server/sync/locations.ts)."

`src/app/api/workspaces/[id]/connection/refresh/route.ts`: same import, `const { env, ctx } = getCloudflareContext();`, and in the `"refreshed"` case add `ctx.waitUntil(syncLocations(db, env, id));` before the response.

**Step 4: Run them**

Run: `npx vitest run src/server/sync/cron.test.ts "src/app/api/workspaces/[id]/connection/refresh/route.test.ts" "src/app/api/workspaces/[id]/connection/route.test.ts"`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/sync/cron.ts src/server/sync/cron.test.ts "src/app/api/workspaces/[id]/connection/route.ts" "src/app/api/workspaces/[id]/connection/refresh/route.ts" "src/app/api/workspaces/[id]/connection/refresh/route.test.ts"
git commit -m "feat: sync locations daily and after a connection save or refresh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/sync/cron.ts src/server/sync/cron.test.ts "src/app/api/workspaces/[id]/connection/route.ts" "src/app/api/workspaces/[id]/connection/refresh/route.ts" "src/app/api/workspaces/[id]/connection/refresh/route.test.ts"
```

---

### Task 9: Company location webhooks

**Files:**
- Modify: `src/server/shopify/admin.ts:77-102` (topic list and `webhookTopicsFor`)
- Modify: `src/server/shopify/webhooks.ts:1-42` (header), `:58-67` (topic sets), `:73-78` (`Job`), `:140-155` (`gidOf`), `:157-180` (`jobFor`), `:254-257` (accepted topics), `:324-345` (`runJob`)
- Test: `src/server/shopify/admin-drafts.test.ts:257-268`, `src/server/desk/connection-refresh.test.ts:137-138`, `src/server/shopify/webhooks.test.ts`

**Step 1: Write the failing tests**

`src/server/shopify/admin-drafts.test.ts`: import `COMPANY_LOCATION_WEBHOOK_TOPICS` from `./admin` and add inside `describe("webhook topics", ...)`:

```ts
  // Comprehensive design section 2: company locations, only with a companies
  // scope, after the base topics and before the draft topics (which stay last).
  it("adds the company location topics before the draft topics, only with a companies scope", () => {
    expect(COMPANY_LOCATION_WEBHOOK_TOPICS).toEqual(["COMPANY_LOCATIONS_CREATE", "COMPANY_LOCATIONS_UPDATE", "COMPANY_LOCATIONS_DELETE"]);
    expect(webhookTopicsFor(["write_orders", "read_companies"])).toEqual([...BASE_WEBHOOK_TOPICS, ...COMPANY_LOCATION_WEBHOOK_TOPICS]);
    expect(webhookTopicsFor(["write_orders", "write_draft_orders", "write_companies"])).toEqual([
      ...BASE_WEBHOOK_TOPICS,
      ...COMPANY_LOCATION_WEBHOOK_TOPICS,
      ...DRAFT_WEBHOOK_TOPICS,
    ]);
  });
```

`src/server/desk/connection-refresh.test.ts` line 138: the refresh test grants `read_companies`, so:

```ts
    expect(store.created().slice(-3)).toEqual(["DRAFT_ORDERS_CREATE", "DRAFT_ORDERS_UPDATE", "DRAFT_ORDERS_DELETE"]);
    expect(store.created().slice(10, 13)).toEqual(["COMPANY_LOCATIONS_CREATE", "COMPANY_LOCATIONS_UPDATE", "COMPANY_LOCATIONS_DELETE"]);
    expect(store.created()).toHaveLength(16);
```

`src/server/shopify/webhooks.test.ts`, at the end:

```ts
// Comprehensive design section 2: company_locations/* keep the locations
// table current between the daily syncs.
describe("company location webhooks", () => {
  const locationNode = {
    id: "gid://shopify/CompanyLocation/101",
    name: "Buford HQ",
    company: { id: "gid://shopify/Company/7" },
    shippingAddress: {
      address1: "100 Example Way",
      address2: "",
      city: "Buford",
      province: "Georgia",
      zoneCode: "GA",
      zip: "30518",
      country: "United States",
      countryCode: "US",
      phone: "",
      companyName: "Example Rentals",
    },
  };

  function locationStore(node: unknown) {
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Query;
      if (body.query.includes("query CompanyLocationById")) {
        return Response.json({ data: { companyLocation: node } });
      }
      throw new Error("unexpected request: " + body.query);
    }) as typeof fetch;
    return impl;
  }

  it("stores a created or updated location, and keeps a deleted one inactive", async () => {
    const db = await setup({ scopes: ["read_orders", "read_customers", "read_companies"] });
    const { env } = fakeEnv();
    const receipt = await deliver(
      db,
      env,
      { topic: "company_locations/update", payload: { id: 101, admin_graphql_api_id: "gid://shopify/CompanyLocation/101" } },
      locationStore(locationNode),
    );
    expect(receipt.status).toBe(200);
    await receipt.work?.();
    expect(await db.select().from(schema.locations)).toEqual([
      expect.objectContaining({ workspaceId: WS, shopifyLocationId: "101", companyId: "7", name: "Buford HQ", active: true, updatedAt: NOW }),
    ]);
    const gone = await deliver(db, env, {
      topic: "company_locations/delete",
      payload: { id: 101 },
      webhookId: "c0ffee00-0000-4000-8000-000000000001",
    });
    await gone.work?.();
    expect((await db.select().from(schema.locations))[0]).toMatchObject({ active: false });
  });

  it("ignores location webhooks for a store without a companies scope", async () => {
    const db = await setup({ scopes: ["read_orders", "read_customers"] });
    const { env } = fakeEnv();
    const receipt = await deliver(db, env, { topic: "company_locations/create", payload: { id: 102 } });
    await receipt.work?.();
    expect(await db.select().from(schema.locations)).toEqual([]);
  });
});
```

**Step 2: Run them**

Run: `npx vitest run src/server/shopify/admin-drafts.test.ts src/server/desk/connection-refresh.test.ts src/server/shopify/webhooks.test.ts`
Expected: FAIL. `COMPANY_LOCATION_WEBHOOK_TOPICS` is not exported; 13 topics instead of 16; the location webhook is ignored (no `work`), so the table stays empty.

**Step 3: Minimal implementation**

`src/server/shopify/admin.ts`, after `DRAFT_WEBHOOK_TOPICS`:

```ts
// Company locations (comprehensive design section 2), only with a companies
// scope. Shopify accepts them with read_customers too, which every
// connection holds, so they can never be the refusal that stops
// registration; they still go before the draft topics, which stay last.
export const COMPANY_LOCATION_WEBHOOK_TOPICS = [
  "COMPANY_LOCATIONS_CREATE",
  "COMPANY_LOCATIONS_UPDATE",
  "COMPANY_LOCATIONS_DELETE",
] as const;

export type WebhookTopic =
  | (typeof BASE_WEBHOOK_TOPICS)[number]
  | (typeof COMPANY_LOCATION_WEBHOOK_TOPICS)[number]
  | (typeof DRAFT_WEBHOOK_TOPICS)[number];

export function webhookTopicsFor(granted: readonly string[] | null | undefined): WebhookTopic[] {
  return [
    ...BASE_WEBHOOK_TOPICS,
    ...(companiesEnabled(granted) ? COMPANY_LOCATION_WEBHOOK_TOPICS : []),
    ...(draftsEnabled(granted) ? DRAFT_WEBHOOK_TOPICS : []),
  ];
}
```

(Replace the old `WebhookTopic` type and `webhookTopicsFor`; `companiesEnabled` already sits above them from Task 4.)

`src/server/shopify/webhooks.ts`:

- Import `import { applyLocationWebhook } from "../sync/locations";`.
- Add `const LOCATION_TOPICS = new Set(["company_locations/create", "company_locations/update", "company_locations/delete"]);`.
- Add to `Job`: `| { kind: "location"; locationGid: string } | { kind: "location-deleted"; locationId: string }`.
- `gidOf`'s `type` parameter: `"Order" | "Customer" | "DraftOrder" | "CompanyLocation"`.
- In `jobFor`, before the customer fallback:

```ts
  if (LOCATION_TOPICS.has(topic)) {
    const locationGid = gidOf(payload, "id", "CompanyLocation");
    if (!locationGid) {
      return null;
    }
    return topic === "company_locations/delete"
      ? { kind: "location-deleted", locationId: legacyIdOf(locationGid) }
      : { kind: "location", locationGid };
  }
```

- Accept the topics: add `&& !LOCATION_TOPICS.has(topic)` to the "anything else: 200 and ignored" condition.
- In `runJob`, right after the `customer-deleted` early return:

```ts
  if (job.kind === "location" || job.kind === "location-deleted") {
    await applyLocationWebhook(db, env, workspaceId, job, { fetchImpl: opts?.fetchImpl, now: clock });
    return;
  }
```

- Header comment, add a bullet: "Company location topics (comprehensive design section 2), only while the stored grant holds a companies scope: the location is re-fetched and stored (src/server/sync/locations.ts); company_locations/delete, and a location Shopify no longer has, keep the row inactive."

**Step 4: Run them**

Run: `npx vitest run src/server/shopify/admin-drafts.test.ts src/server/desk/connection-refresh.test.ts src/server/shopify/webhooks.test.ts src/server/desk/connection-credentials.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/shopify/admin.ts src/server/shopify/webhooks.ts src/server/shopify/admin-drafts.test.ts src/server/desk/connection-refresh.test.ts src/server/shopify/webhooks.test.ts
git commit -m "feat: company location webhooks keep the locations table current

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/shopify/admin.ts src/server/shopify/webhooks.ts src/server/shopify/admin-drafts.test.ts src/server/desk/connection-refresh.test.ts src/server/shopify/webhooks.test.ts
```

---

### Task 10: Read model: location, branch and cancelled on cards

**Files:**
- Modify: `src/server/desk/read.ts:5-19` (imports), `:27-67` (`OrderSummary`), `:111-149` (`summarize`), `:184-190` (the orders list query in `loadDesk`, as Wave 1a left it), `:236-256` (`OrderDetail`, `getOrderDetail`)
- Modify: `src/app/api/orders/[orderId]/route.ts:9-22` (return `location`)
- Test: `src/server/desk/read.test.ts`, `src/lib/desk-state.test.ts` and `src/components/desk/order-list.test.ts` (fixtures)

**Step 1: Write the failing test** (add to `src/server/desk/read.test.ts`; import `seedLocation` from `./test-helpers`)

```ts
  // Comprehensive design section 2: the Branch column and the cancelled mark.
  it("names each card's branch by its synced company location, else the request's own field", async () => {
    const db = await setup();
    await seedLocation(db, WS, { shopifyLocationId: "101", name: "Mableton" });
    await seedLocation(db, OTHER, { shopifyLocationId: "101", name: "Elsewhere" });
    await seedDraft(db, WS, { id: "d1", createdAt: 3000, shopify: draftSnapshotOf({ location: "Buford, GA" }) });
    await seedDraft(db, WS, { id: "d2", createdAt: 2000, shopify: draftSnapshotOf({ location: "Buford, GA" }) });
    await db.update(schema.orders).set({ locationId: "101" }).where(eq(schema.orders.id, "d1"));
    await seedOrder(db, WS, { id: "o1", createdAt: 1000, shopify: snapshotOf({ cancelledAt: 5000 }) });
    const desk = await loadDesk(db, WS);
    const byId = new Map(desk!.orders.map((order) => [order.id, order]));
    expect(byId.get("d1")).toMatchObject({ locationId: "101", locationName: "Mableton", branch: "Mableton", cancelled: false });
    expect(byId.get("d2")).toMatchObject({ locationId: null, locationName: "", branch: "Buford, GA", cancelled: false });
    expect(byId.get("o1")).toMatchObject({ locationId: null, locationName: "", branch: "", cancelled: true });
  });
```

and inside the `getOrderDetail` describe:

```ts
  it("returns the card's synced location with the order", async () => {
    const db = await setup();
    await seedLocation(db, WS, {
      shopifyLocationId: "101",
      name: "Mableton",
      address: {
        address1: "5 Example Rd",
        address2: "",
        city: "Mableton",
        province: "Georgia",
        provinceCode: "GA",
        zip: "30126",
        country: "United States",
        countryCode: "US",
        phone: "",
        company: "Example Rentals",
      },
    });
    await seedDraft(db, WS, { id: "d1" });
    expect((await getOrderDetail(db, WS, "d1"))?.location).toBeNull();
    await db.update(schema.orders).set({ locationId: "101" }).where(eq(schema.orders.id, "d1"));
    expect((await getOrderDetail(db, WS, "d1"))?.location).toMatchObject({
      shopifyLocationId: "101",
      name: "Mableton",
      active: true,
      address: { address1: "5 Example Rd", provinceCode: "GA" },
    });
  });
```

(Wave 1a's `loadDesk` loads the All view when no view is passed, so these calls see every card.)

**Step 2: Run it**

Run: `npx vitest run src/server/desk/read.test.ts`
Expected: FAIL, the summaries have no `locationId`, `locationName` or `cancelled`, and the detail has no `location`.

**Step 3: Minimal implementation** (`src/server/desk/read.ts`)

- Imports: add `locations` to the schema import, `import { placeLabel } from "@/lib/address";` and `import { getLocation, type LocationView } from "@/server/sync/locations";`.
- `OrderSummary`: replace the `branch` comment with `// The synced company location's name, else "Ship to Branch", else the draft's location (src/lib/address.ts placeLabel).` and add:

```ts
  // The card's Shopify company location (comprehensive design section 2):
  // its legacy id, and its synced name ("" until the location is synced).
  locationId: string | null;
  locationName: string;
  // Shopify reports the order cancelled (cancelledAt on the snapshot).
  cancelled: boolean;
```

- `summarize(row, locationName: string | null)`: set

```ts
    locationId: row.locationId ?? null,
    locationName: locationName ?? "",
    branch: placeLabel(locationName, request.branch),
    cancelled: typeof snapshot.cancelledAt === "number" && snapshot.cancelledAt > 0,
```

and add `locationName ?? ""` to the `searchText` list.

- The orders list query in `loadDesk` (Wave 1a's version joins the statuses for the view; keep that join and its `viewCondition`, add the locations join and the name):

```ts
    // One row past the cap answers hasMore without a second count query.
    db
      .select({ order: orders, locationName: locations.name })
      .from(orders)
      .leftJoin(statuses, statusJoin)
      .leftJoin(locations, and(eq(locations.workspaceId, orders.workspaceId), eq(locations.shopifyLocationId, orders.locationId)))
      .where(and(eq(orders.workspaceId, workspaceId), viewCondition(view)))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1),
```

and map with `orderRows.slice(0, limit).map((row) => summarize(row.order, row.locationName))` in place of Wave 1a's `summarize(row.order)`.

- `OrderDetail`: add `// The card's synced company location, or null.` and `location: LocationView | null;`. In `getOrderDetail`:

```ts
  if (!order) {
    return null;
  }
  const location = order.locationId ? await getLocation(db, workspaceId, order.locationId) : null;
  return { order, itemsTruncated: itemsTruncatedOf(order.shopify), location };
```

`src/app/api/orders/[orderId]/route.ts`: return `{ order: detail.order, itemsTruncated: detail.itemsTruncated, location: detail.location }` and extend the comment with ", plus location (the card's synced company location, or null)".

Every whole `OrderSummary` literal in the tests gains `locationId: null, locationName: "", cancelled: false,` so the type gate stays green: the `order()` helper in `src/lib/desk-state.test.ts` and Wave 1a's `card()` helper in `src/components/desk/order-list.test.ts` (`npx tsc --noEmit --incremental false` lists any other).

**Step 4: Run it**

Run: `npx vitest run src/server/desk/read.test.ts "src/app/api/orders/[orderId]/routes.test.ts"`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/desk/read.ts src/server/desk/read.test.ts "src/app/api/orders/[orderId]/route.ts" src/lib/desk-state.test.ts src/components/desk/order-list.test.ts
git commit -m "feat: cards carry their company location, branch and cancelled mark

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/desk/read.ts src/server/desk/read.test.ts "src/app/api/orders/[orderId]/route.ts" src/lib/desk-state.test.ts src/components/desk/order-list.test.ts
```

---

### Task 11: AddressBlock component and the drawer's ship-to

Use @design-taste-frontend.

**Files:**
- Create: `src/components/address-block.tsx`, `src/components/address-block.test.ts`
- Modify: `src/components/desk/request-parts.tsx:16` (imports), `:310-326` (`ShipToSection`)
- Modify: `src/components/desk/order-drawer.tsx:44-63` (`DrawerOrder`, `DrawerDetail`), `:746` (`ShipToSection` call)
- Modify: `src/components/desk/desk.tsx:300-304` (keep `location` from the detail response)
- Test: `src/components/address-block.test.ts`, `src/components/desk/request-parts.test.ts`, `src/components/desk/order-drawer.test.ts` (fixtures)

**Step 1: Write the failing tests**

Create `src/components/address-block.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AddressBlock } from "./address-block";

// The one address component (comprehensive design section 2).
describe("AddressBlock", () => {
  it("shows the location name in bold, then the lines, then the phone", () => {
    const html = renderToStaticMarkup(
      createElement(AddressBlock, {
        block: { heading: "Buford HQ", lines: ["100 Example Way", "Buford GA 30518"], phone: "+15555550100" },
        empty: "No shipping address.",
      }),
    );
    expect(html.startsWith("<address")).toBe(true);
    expect(html).toContain('<span class="block font-semibold">Buford HQ</span>');
    expect(html).toContain('<span class="block break-words">100 Example Way</span>');
    expect(html).toContain("+15555550100");
  });

  it("shows the address alone without a heading, and the empty text without any address", () => {
    const plain = renderToStaticMarkup(
      createElement(AddressBlock, { block: { heading: null, lines: ["Casey Lin"], phone: null }, empty: "None" }),
    );
    expect(plain).not.toContain("font-semibold");
    expect(plain).toContain(">Casey Lin<");
    const none = renderToStaticMarkup(createElement(AddressBlock, { block: null, empty: "No shipping address." }));
    expect(none).toContain(">No shipping address.</p>");
  });
});
```

Add to `src/components/desk/request-parts.test.ts` (import `ShipToSection`):

```ts
describe("ShipToSection", () => {
  const shipping = {
    name: "Casey Lin",
    company: "Example Rentals",
    phone: "",
    a1: "100 Example Way",
    a2: "",
    city: "Buford",
    prov: "GA",
    zip: "30518",
    country: "US",
  };

  it("names the company location first, in bold, then the street lines", () => {
    const html = renderToStaticMarkup(createElement(ShipToSection, { shipping, location: { name: "Buford HQ", address: null } }));
    expect(html).toContain('<span class="block font-semibold">Buford HQ</span>');
    expect(html).toContain("100 Example Way");
    expect(html).not.toContain("Casey Lin");
  });

  it("shows the address alone without a location, and says when there is none", () => {
    expect(renderToStaticMarkup(createElement(ShipToSection, { shipping, location: null }))).toContain(">Casey Lin<");
    expect(renderToStaticMarkup(createElement(ShipToSection, { shipping: null, location: null }))).toContain("No shipping address.");
  });
});
```

**Step 2: Run them**

Run: `npx vitest run src/components/address-block.test.ts src/components/desk/request-parts.test.ts`
Expected: FAIL, `./address-block` does not resolve and `ShipToSection` takes no location.

**Step 3: Minimal implementation**

Create `src/components/address-block.tsx`:

```tsx
// The one way an address shows in the app (comprehensive design section
// 2): a company location's name in bold, then the address lines, then the
// phone; with no location, the address alone. The lines come from
// src/lib/address.ts, which the emails and the PO PDF share.

import type { AddressBlockModel } from "@/lib/address";

export function AddressBlock({
  block,
  empty,
  className = "",
}: {
  block: AddressBlockModel | null;
  // Shown when there is no address at all.
  empty: string;
  className?: string;
}) {
  if (!block || (block.heading === null && block.lines.length === 0)) {
    return <p className={["text-sm text-ink-2", className].filter(Boolean).join(" ")}>{empty}</p>;
  }
  return (
    <address className={["text-sm not-italic leading-relaxed text-ink", className].filter(Boolean).join(" ")}>
      {block.heading ? <span className="block font-semibold">{block.heading}</span> : null}
      {block.lines.map((line, index) => (
        <span key={index} className="block break-words">
          {line}
        </span>
      ))}
      {block.phone ? <span className="mt-1 block font-mono text-ink-2">{block.phone}</span> : null}
    </address>
  );
}
```

`src/components/desk/request-parts.tsx`: drop `shippingLines` from the `@/lib/order-snapshot` import, add `import { addressBlock, type LocationAddress } from "@/lib/address";` and `import { AddressBlock } from "@/components/address-block";`, and replace `ShipToSection`:

```tsx
// The card's synced company location (src/server/sync/locations.ts), or
// null when it has none or it is not synced yet.
export type ShipToLocation = { name: string; address: LocationAddress | null };

export function ShipToSection({ shipping, location }: { shipping: OrderSnapshot["shipping"]; location: ShipToLocation | null }) {
  return (
    <Section title="Ship to">
      <AddressBlock
        block={addressBlock({ locationName: location?.name, locationAddress: location?.address ?? null, shipping })}
        empty="No shipping address."
      />
    </Section>
  );
}
```

`src/components/desk/order-drawer.tsx`: add `locationId: string | null;` to `DrawerOrder` (after `draftDeletedAt`), import `type ShipToLocation` from `./request-parts`, change the ready variant of `DrawerDetail` to `{ status: "ready"; order: DrawerOrder; itemsTruncated: boolean; location: ShipToLocation | null }`, and line 746 to:

```tsx
            <ShipToSection shipping={snapshot.shipping} location={detail.status === "ready" ? detail.location : null} />
```

`src/components/desk/desk.tsx` in `loadDrawer`:

```ts
        const body = (await detailResult.value.json()) as {
          order: DrawerOrder;
          itemsTruncated: boolean;
          location?: ShipToLocation | null;
        };
        setDetail({ status: "ready", order: body.order, itemsTruncated: body.itemsTruncated, location: body.location ?? null });
```

(import `type ShipToLocation` from `./request-parts`; search desk.tsx for any other `status: "ready"` literal and give it `location` the same way).

**Step 4: Run them**

Run: `npx vitest run src/components/address-block.test.ts src/components/desk/request-parts.test.ts src/components/desk/order-drawer.test.ts`
Expected: PASS. Keep the type gate green: in `src/components/desk/order-drawer.test.ts`, add `locationId: null,` to `draftCard` and `location: null` to the `detail` its `render` passes.

**Step 5: Commit**

Gates, then:

```bash
git add src/components/address-block.tsx src/components/address-block.test.ts src/components/desk/request-parts.tsx src/components/desk/request-parts.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/desk.tsx
git commit -m "feat: the drawer's ship-to names the company location first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/address-block.tsx src/components/address-block.test.ts src/components/desk/request-parts.tsx src/components/desk/request-parts.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/desk.tsx
```



---

### Task 12: Branch column in the desktop list

Use @design-taste-frontend.

Wave 1a rewrote `src/components/desk/order-list.tsx` (its Tasks 10, 13, 16 and 17): `OrderTable` renders one 44px row per card (selection box, Order, Date, Customer, Items, Age, a Total column only while `showPrices` is true, Status) and `OrderCards` the phone cards, with the helpers `requestLine(order)`, `CustomerLine`, `KindMark`, `PricedMark` and `Total`. This task puts a Branch column in the Total column's place for good (design section 2: "The desktop list gets a Branch column in place of the total"), whatever the price display says. On the desktop a card with a price keeps Wave 1a's amber price chip (`PricedMark`) next to its kind; the phone cards keep the branch in their request line and their total under Wave 1a's price rule; the drawer keeps its totals.

**Files:**
- Modify: `src/components/desk/order-list.tsx` (Wave 1a's version: `requestLine`, `CustomerLine`, `OrderTable`'s columns and order cell, `OrderCards`' `CustomerLine` call; add `branchText` and `BranchCell`)
- Modify: `src/components/desk/desk-skeleton.tsx` (Wave 1a's row grid: the Total track becomes the Branch track)
- Test: `src/components/desk/order-list.test.ts` (Wave 1a created it: append a describe and update two of its expectations)

**Step 1: Write the failing test**

In `src/components/desk/order-list.test.ts` (Wave 1a's file), change its import from `./order-list` to `import { BranchCell, OrderList, branchText, requestLine, type ListProps } from "./order-list";` and append:

```ts
// The desktop list's Branch column (comprehensive design section 2): the
// card's synced location, else its request field, in place of the total.
describe("Branch column", () => {
  it("names the card's branch, trimmed, or says there is none", () => {
    expect(branchText({ branch: " Mableton " })).toBe("Mableton");
    expect(renderToStaticMarkup(createElement(BranchCell, { order: { branch: "Mableton" } }))).toContain(">Mableton<");
    expect(renderToStaticMarkup(createElement(BranchCell, { order: { branch: "" } }))).toContain(">No branch<");
  });

  it("leaves the branch out of the request line when the row has a Branch column", () => {
    expect(requestLine({ requestFor: "Casey Lin", branch: "Mableton" }, { withBranch: false })).toBe("For Casey Lin");
    expect(requestLine({ requestFor: "Casey Lin", branch: "Mableton" }, { withBranch: true })).toBe("For Casey Lin · Mableton");
    expect(requestLine({ requestFor: "", branch: "" }, { withBranch: true })).toBeNull();
  });

  it("shows Branch, never Total, on the desktop, and keeps the phone cards as they were", () => {
    const table = render("table");
    expect(table).toContain(">Branch</th>");
    expect(table).not.toContain(">Total</th>");
    expect(table).toContain(" · For Casey Lin</span>");
    expect(table).toContain('title="Buford HQ">Buford HQ</span>');
    expect(render("cards")).toContain("For Casey Lin · Buford HQ");
  });
});
```

In Wave 1a's existing cases:

- `"keeps every table row on one 44px line"`: replace `expect(html).toContain("For Casey Lin · Buford HQ");` with `expect(html).toContain(" · For Casey Lin</span>");` (the branch moved to its own column).
- `"drops the Total column when prices are hidden, and still marks a card that has a price"` (rename it `"never shows a Total column on the desktop, marks a card that has a price, and keeps the cards' totals under the price rule"`): replace its `shown` assertions with

```ts
    const shown = render("table", { orders, showPrices: true });
    expect(shown).not.toContain(">Total</th>");
    expect(shown).toContain(">Branch</th>");
    expect(shown).not.toContain("$0.00");
    expect(shown).toContain("$48.00");
    expect(render("cards", { orders, showPrices: true })).toContain("$0.00");
```

  and keep its `hidden` and cards assertions as they are.

**Step 2: Run it**

Run: `npx vitest run src/components/desk/order-list.test.ts`
Expected: FAIL, `BranchCell` and `branchText` are not exported (`requestLine` is not exported either), and the table still has a Total column.

**Step 3: Minimal implementation** (`src/components/desk/order-list.tsx`, Wave 1a's version)

Replace `requestLine` and add the Branch pieces after it:

```tsx
// "For Casey Lin · Buford HQ" when the request names them. The desktop row
// has its own Branch column, so it leaves the branch out.
export function requestLine(
  order: Pick<OrderSummary, "requestFor" | "branch">,
  opts: { withBranch: boolean },
): string | null {
  const parts = [order.requestFor ? `For ${order.requestFor}` : "", opts.withBranch ? order.branch : ""].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

// The Branch column (comprehensive design section 2): the synced company
// location, else the request's own field (OrderSummary.branch).
export function branchText(order: Pick<OrderSummary, "branch">): string {
  return order.branch.trim();
}

export function BranchCell({ order }: { order: Pick<OrderSummary, "branch"> }) {
  const text = branchText(order);
  return text ? (
    <span className="block truncate text-sm text-ink" title={text}>
      {text}
    </span>
  ) : (
    <span className="text-sm text-ink-2">No branch</span>
  );
}
```

`CustomerLine` takes `withBranch: boolean` (`function CustomerLine({ order, withBranch }: { order: OrderSummary; withBranch: boolean })`) and calls `requestLine(order, { withBranch })`. `OrderTable` renders `<CustomerLine order={order} withBranch={false} />`; `OrderCards` renders `<CustomerLine order={order} withBranch />`.

In `OrderTable`:

- The conditional Total `<col className="w-[7rem]" />` becomes an unconditional `<col className="w-[9rem]" />` in the same place.
- The conditional `<th scope="col" className="px-3 text-right font-semibold">Total</th>` becomes `<th scope="col" className="px-3 font-semibold">Branch</th>` (left aligned, always rendered).
- The conditional Total cell becomes `<td className={`px-3 ${flash}`}><BranchCell order={order} /></td>`, always rendered.
- In the order cell, `PricedMark` no longer depends on `showPrices`: render `<PricedMark order={order} />` after `<KindMark order={order} />` for every card (it shows only for a priced card).

`OrderCards` keeps `{showPrices ? <Total order={order} /> : <PricedMark order={order} />}`; `Total` stays (the cards use it). Keep Wave 1a's row density, selection box column and age column exactly as they are.

`src/components/desk/desk-skeleton.tsx`: in Wave 1a's row grid `grid-cols-[3.5rem_10rem_6.5rem_24%_1fr_5.5rem_7rem_11rem]` the `7rem` track becomes `9rem`, and its cell `<div className="flex justify-end px-3"><Bar className="h-3.5 w-14" /></div>` becomes `<div className="px-3"><Bar className="h-3.5 w-20" /></div>`.

**Step 4: Run it**

Run: `npx vitest run src/components/desk/order-list.test.ts`
Expected: PASS. Local check at 1440x900, light and dark: the Branch column reads at a glance, long names truncate with the full name as the tooltip, "No branch" is muted but AA.

**Step 5: Commit**

Gates, then:

```bash
git add src/components/desk/order-list.tsx src/components/desk/order-list.test.ts src/components/desk/desk-skeleton.tsx
git commit -m "feat: a Branch column in place of the total on the desktop list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/desk/order-list.tsx src/components/desk/order-list.test.ts src/components/desk/desk-skeleton.tsx
```

---

### Task 13: Purchase order surfaces use the formatter

**Files:**
- Modify: `src/lib/po-form.ts:9` (import), `:61-74` (`formFromOrder`)
- Modify: `src/components/desk/po-modal.tsx:534-544` (pass the location to the prefill)
- Modify: `src/components/desk/po-send-confirm.tsx:105-115` (the Ship to `<dt>`/`<dd>` in `SendContent`, rendered with `AddressBlock`)
- Modify: `src/server/po/email.ts:47-57` (heading in bold)
- Modify: `src/server/po/pdf.ts:332-348` (heading and lines from the formatter)
- Test: `src/lib/po-form.test.ts`, `src/server/po/email.test.ts`, existing `src/server/po/pdf.test.ts`

**Step 1: Write the failing tests**

`src/lib/po-form.test.ts`, inside `describe("formFromOrder", ...)`:

```ts
  // Comprehensive design section 2: the ship-to starts with the company
  // location's name, then the order's street lines.
  it("starts the ship-to with the company location's name when the order has one", () => {
    const prefilled = formFromOrder(snapshot, undefined, { name: "Buford HQ", address: null });
    expect(prefilled.shipTo).toBe("Buford HQ\n12 Harbour St\nHalifax NS B3H 1A1\nCanada");
  });
```

`src/server/po/email.test.ts`:

```ts
  it("shows the ship-to's first line in bold, and keeps the plain text as it was", () => {
    const email = vendorPoEmail(env, workspace(), po({ shipTo: ["Buford HQ", "100 Example Way"] }));
    expect(email.html).toContain("<strong>Buford HQ</strong><br>100 Example Way");
    expect(email.text).toContain("Ship to: Buford HQ\n100 Example Way");
  });
```

**Step 2: Run them**

Run: `npx vitest run src/lib/po-form.test.ts src/server/po/email.test.ts`
Expected: FAIL, the prefill has no location heading and the email has no `<strong>`.

**Step 3: Minimal implementation**

`src/lib/po-form.ts`: replace `import { shippingLines } from "./order-snapshot";` with `import { addressBlock, addressBlockLines, type LocationAddress } from "./address";` and change `formFromOrder`:

```ts
// lines: the full line list to start from (the po-lines route); omitted,
// the snapshot's own items; null, it could not be read (the snapshot is
// partial), so the form starts with one empty line and never with a partial
// list. location: the card's synced company location; the ship-to then
// starts with its name (comprehensive design section 2).
export function formFromOrder(
  snapshot: OrderSnapshot,
  given?: PoLine[] | null,
  location?: { name: string; address: LocationAddress | null } | null,
): PoForm {
  const source = given === undefined ? linesFromOrderItems(snapshot.items) : (given ?? []);
  const lines = source.map(formLine);
  const shipTo = addressBlockLines(
    addressBlock({ locationName: location?.name, locationAddress: location?.address ?? null, shipping: snapshot.shipping }),
  );
  return {
    vendorId: "",
    lines: lines.length > 0 ? lines : [emptyLine()],
    shipTo: shipTo.join("\n"),
    notes: "",
  };
}
```

`src/components/desk/po-modal.tsx`: type the order response as `{ order: { name: string; shopify: unknown }; location?: { name: string; address: LocationAddress | null } | null }` and call `formFromOrder(snapshot, lines, order.location ?? null)` (import `type LocationAddress` from `@/lib/address`). The ship-to field's help text becomes "From the order: the location first. One line per row; printed on the purchase order."

`src/components/desk/po-send-confirm.tsx`, the Ship to `<dd>`:

```tsx
        <dt className="text-ink-2">Ship to</dt>
        <dd className="break-words">
          <AddressBlock block={addressBlockFromLines(content.shipTo)} empty="No ship-to address" />
        </dd>
```

(import `AddressBlock` from `@/components/address-block` and `addressBlockFromLines` from `@/lib/address`).

`src/server/po/email.ts`: import `addressBlockFromLines` from `@/lib/address`; replace `const shipTo = po.shipTo.filter((line) => line.trim().length > 0);` with `const block = addressBlockFromLines(po.shipTo);`, and replace the `if (shipTo.length > 0) { rows.push(["Ship to", ...]); }` block with:

```ts
  if (block) {
    // The first line (the location, or the recipient) in bold, like the PDF.
    rows.push([
      "Ship to",
      [`<strong>${escapeHtml(block.heading ?? "")}</strong>`, ...block.lines.map(escapeHtml)].join("<br>"),
    ]);
  }
```

`src/server/po/pdf.ts`: add `import { addressBlockFromLines } from "@/lib/address";` and replace the ship-to drawing (from `const shipTo = input.shipTo.map(...)` to the end of its `for` loop, lines 337-347) with:

```ts
  // The first line (the location, or the recipient) is the heading, as in
  // every other place an address shows (src/lib/address.ts).
  const block = addressBlockFromLines(input.shipTo.map((line) => clean(fonts, line)));
  if (!block) {
    w.text("No ship-to address", x, right, { size: 10, color: palette.muted });
    right -= 13;
  } else {
    for (const line of wrap(fonts.bold, block.heading ?? "", 11, columnWidth)) {
      w.text(line, x, right, { bold: true, size: 11 });
      right -= 14;
    }
    for (const entry of block.lines) {
      for (const line of wrap(fonts.regular, entry, 10, columnWidth)) {
        w.text(line, x, right, { size: 10 });
        right -= 13;
      }
    }
  }
```

It prints exactly what it printed before; the formatter only names the rule.

**Step 4: Run them**

Run: `npx vitest run src/lib/po-form.test.ts src/server/po/email.test.ts src/server/po/pdf.test.ts src/components/desk/po-history.test.ts`
Expected: PASS (`pdf.test.ts` is unchanged and proves the PDF still prints the ship-to).

**Step 5: Commit**

Gates, then:

```bash
git add src/lib/po-form.ts src/lib/po-form.test.ts src/components/desk/po-modal.tsx src/components/desk/po-send-confirm.tsx src/server/po/email.ts src/server/po/email.test.ts src/server/po/pdf.ts
git commit -m "feat: purchase orders ship to the location by name, one formatter everywhere

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/po-form.ts src/lib/po-form.test.ts src/components/desk/po-modal.tsx src/components/desk/po-send-confirm.tsx src/server/po/email.ts src/server/po/email.test.ts src/server/po/pdf.ts
```

---

### Task 14: Status rules for the cancelled status

Wave 1a moved every status rule into one pure module, `src/lib/status-rules.ts` (`checkStatusMove`, used by `changeOrderStatus`, the bulk `changeOrderStatuses` and the desk's bulk confirmation through `planBulkMove`). The Cancelled rules go there, so a single change, a bulk move and the bulk confirmation all refuse the same moves; the status control's options follow in `src/lib/status-options.ts`.

**Files:**
- Modify: `src/lib/status-rules.ts` (Wave 1a's `checkStatusMove` and its comment)
- Modify: `src/server/desk/mutations.ts` (only the header comment of `changeOrderStatus`, which points at the rules)
- Modify: `src/lib/status-options.ts:1-39`
- Test: `src/lib/status-rules.test.ts` (Wave 1a's file), `src/server/desk/mutations.test.ts`, `src/lib/status-options.test.ts`

**Step 1: Write the failing tests**

Append to `src/lib/status-rules.test.ts` (Wave 1a's file; `status(label, link)` is its helper):

```ts
// Comprehensive design section 2: Cancel order and Shopify's cancellations
// own the cancelled status; Shopify cannot un-cancel an order, so only a
// manager moves a cancelled card, and only where Shopify is not involved.
describe("checkStatusMove and the cancelled status", () => {
  const cancelled = status("Cancelled", "cancelled");

  it("never moves a card into the cancelled status", () => {
    expect(checkStatusMove({ isDraft: false, role: "manager", current: status("Approved"), target: cancelled })).toEqual({
      ok: false,
      forbidden: false,
      error: "Use Cancel order to cancel an order. It cancels the order in Shopify.",
    });
    expect(checkStatusMove({ isDraft: true, role: "manager", current: status("New"), target: cancelled })).toEqual({
      ok: false,
      forbidden: false,
      error: "A request is rejected, not cancelled. Use Reject.",
    });
  });

  it("lets only a manager move a cancelled order, and only to a status with no Shopify link", () => {
    expect(checkStatusMove({ isDraft: false, role: "staff", current: cancelled, target: status("Processing") })).toEqual({
      ok: false,
      forbidden: true,
      error: "Only a manager can move a cancelled order.",
    });
    expect(checkStatusMove({ isDraft: false, role: "manager", current: cancelled, target: status("Shipped", "fulfilled") })).toEqual({
      ok: false,
      forbidden: false,
      error: "A cancelled order cannot be marked Shipped. Shopify keeps it cancelled.",
    });
    expect(checkStatusMove({ isDraft: false, role: "manager", current: cancelled, target: status("Issue") })).toEqual({ ok: true });
  });
});
```

Add to `src/server/desk/mutations.test.ts`, inside Wave 1a's `describe("changeOrderStatuses (bulk)", ...)` (it defines `bulk`, and the file's `ctx` and `setup` are in scope; import `seedCancelledStatus` from `./test-helpers`):

```ts
  // The same rules hold for one change and for a bulk move.
  it("keeps the cancelled status for Cancel order, and lets only a manager move a cancelled order to a status with no Shopify link", async () => {
    const db = await setup();
    await seedDraftStatuses(db, WS);
    await seedCancelledStatus(db, WS);
    expect(await changeOrderStatus(db, ctx("o1", "manager"), { statusKey: "cancelled" })).toEqual({
      kind: "invalid",
      error: "Use Cancel order to cancel an order. It cancels the order in Shopify.",
    });
    const moved = await changeOrderStatuses(db, bulk("manager"), { orderIds: ["o1"], statusKey: "cancelled" });
    expect(moved.kind === "ok" ? moved.results.map((row) => row.outcome) : moved).toEqual(["refused"]);
    await db.update(schema.orders).set({ statusKey: "cancelled" }).where(eq(schema.orders.id, "o1"));
    expect(await changeOrderStatus(db, ctx("o1", "staff"), { statusKey: "processing" })).toEqual({
      kind: "forbidden",
      error: "Only a manager can move a cancelled order.",
    });
    expect(await changeOrderStatus(db, ctx("o1", "manager"), { statusKey: "shipped" })).toEqual({
      kind: "invalid",
      error: "A cancelled order cannot be marked Shipped. Shopify keeps it cancelled.",
    });
    expect((await changeOrderStatus(db, ctx("o1", "manager"), { statusKey: "issue" })).kind).toBe("changed");
  });
```

`src/lib/status-options.test.ts`:

```ts
  it("keeps the cancelled status out of the control, and locks a cancelled order for staff", () => {
    const list = [...STATUSES, status("cancelled", 7, "cancelled")];
    expect(keys(statusOptionsFor({ kind: "order", role: "manager", currentKey: "new", statuses: list }).options)).not.toContain("cancelled");
    expect(keys(statusOptionsFor({ kind: "draft", role: "manager", currentKey: "new", statuses: list }).options)).not.toContain("cancelled");
    expect(statusOptionsFor({ kind: "order", role: "staff", currentKey: "cancelled", statuses: list })).toMatchObject({
      disabled: true,
      hint: "Only a manager can move a cancelled order.",
    });
    const manager = statusOptionsFor({ kind: "order", role: "manager", currentKey: "cancelled", statuses: list });
    expect(keys(manager.options)).toEqual(["new", "processing", "issue", "cancelled"]);
    expect(manager.disabled).toBe(false);
  });
```

**Step 2: Run them**

Run: `npx vitest run src/lib/status-rules.test.ts src/server/desk/mutations.test.ts src/lib/status-options.test.ts`
Expected: FAIL: `checkStatusMove` answers `{ ok: true }` for every move into or out of Cancelled, the single and bulk changes move the card, and the control offers Cancelled.

**Step 3: Minimal implementation**

`src/lib/status-rules.ts`, at the top of `checkStatusMove` (before the `if (isDraft)` branch), and extend the comment above it with "- Never into the status linked to cancelled (Cancel order and Shopify's own cancellations put a card there); out of it only for a manager or platform admin, and only to a status with no Shopify link (Shopify cannot un-cancel an order).":

```ts
  if (target.shopifyLink === "cancelled") {
    return {
      ok: false,
      forbidden: false,
      error: isDraft ? "A request is rejected, not cancelled. Use Reject." : "Use Cancel order to cancel an order. It cancels the order in Shopify.",
    };
  }
  if (current?.shopifyLink === "cancelled") {
    if (!roleAtLeast(role, "manager")) {
      return { ok: false, forbidden: true, error: "Only a manager can move a cancelled order." };
    }
    if (target.shopifyLink !== null) {
      return { ok: false, forbidden: false, error: `A cancelled order cannot be marked ${target.label}. Shopify keeps it cancelled.` };
    }
  }
```

`src/server/desk/mutations.ts`: no rule code changes (both changes call `checkStatusMove`); add to `changeOrderStatus`'s header comment "never into the status linked to cancelled; out of it only for a manager, to a status with no Shopify link (src/lib/status-rules.ts)".

`src/lib/status-options.ts`:

```ts
export function statusOptionsFor(input: {
  kind: "draft" | "order";
  role: Role;
  currentKey: string;
  statuses: StatusView[];
}): StatusOptions {
  const { kind, role, currentKey, statuses } = input;
  const current = statuses.find((status) => status.key === currentKey);
  if (kind === "draft") {
    const locked = current?.shopifyLink === "draft_rejected" && !roleAtLeast(role, "manager");
    return {
      options: statuses.filter((status) => status.shopifyLink === null || status.key === currentKey),
      disabled: locked,
      hint: locked ? "Only a manager can reopen a rejected request." : null,
    };
  }
  if (current?.shopifyLink === "cancelled") {
    const locked = !roleAtLeast(role, "manager");
    return {
      options: statuses.filter((status) => status.shopifyLink === null || status.key === currentKey),
      disabled: locked,
      hint: locked ? "Only a manager can move a cancelled order." : null,
    };
  }
  return {
    options: statuses.filter(
      (status) => (status.shopifyLink !== "draft_rejected" && status.shopifyLink !== "cancelled") || status.key === currentKey,
    ),
    disabled: false,
    hint: null,
  };
}
```

and add to the header: "- The cancelled status is never offered (Cancel order sets it); a cancelled order is locked for staff and moves only to statuses with no Shopify link."

**Step 4: Run them**

Run: `npx vitest run src/lib/status-rules.test.ts src/server/desk/mutations.test.ts src/lib/status-options.test.ts src/components/desk/bulk-bar.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/lib/status-rules.ts src/lib/status-rules.test.ts src/server/desk/mutations.ts src/server/desk/mutations.test.ts src/lib/status-options.ts src/lib/status-options.test.ts
git commit -m "feat: the cancelled status belongs to Cancel order and Shopify

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/status-rules.ts src/lib/status-rules.test.ts src/server/desk/mutations.ts src/server/desk/mutations.test.ts src/lib/status-options.ts src/lib/status-options.test.ts
```

---

### Task 15: Shopify to app: cancellations move cards

**Files:**
- Modify: `src/server/shopify/status-sync.ts:22-61` (header), `:111-116` (`MoveReason`), `:184-193` (`allowedFor`), `:219-241` (`initialStatusFor`), `:243-288` (`decideShopifyMove`), `:290-301` (`mightMove`), `:303-321` (`moveText`)
- Test: `src/server/shopify/status-sync.test.ts`, `src/server/shopify/webhooks.test.ts`

**Step 1: Write the failing tests**

`src/server/shopify/status-sync.test.ts` (import `draftSnapshotOf` from the test helpers):

```ts
// Comprehensive design section 2: an order cancelled in Shopify moves its
// card to the cancelled status from any status.
describe("cancellations from Shopify", () => {
  const WITH_CANCELLED: StatusRow[] = [...STATUSES, { key: "cancelled", label: "Cancelled", sort: 9, shopifyLink: "cancelled" }];
  const cancelled = (tags = "") => snapshotOf({ fulfillmentStatus: "unfulfilled", delivered: false, tags, cancelledAt: 5000 });

  it("moves an order Shopify newly reports cancelled to the cancelled status, from any status", () => {
    expect(decide(unfulfilled(), cancelled(), "delivered", none, WITH_CANCELLED)).toEqual({ to: WITH_CANCELLED[5], reason: "cancelled" });
    expect(decide(unfulfilled(), cancelled(), "new", none, WITH_CANCELLED)).toEqual({ to: WITH_CANCELLED[5], reason: "cancelled" });
  });

  it("wins over a tag or a fulfillment in the same change, and acts once", () => {
    const both = snapshotOf({ fulfillmentStatus: "fulfilled", delivered: false, tags: "Ordering Desk: Approved", cancelledAt: 5000 });
    expect(decide(unfulfilled(), both, "new", none, WITH_CANCELLED)).toMatchObject({ reason: "cancelled" });
    expect(decide(cancelled(), cancelled("vip"), "processing", none, WITH_CANCELLED)).toBeNull();
    expect(decide(unfulfilled(), cancelled(), "cancelled", none, WITH_CANCELLED)).toBeNull();
    expect(decide(unfulfilled(), cancelled(), "new", none, STATUSES)).toBeNull();
  });

  it("never moves a card into the cancelled status by a tag", () => {
    expect(decide(unfulfilled(), unfulfilled("Ordering Desk: Cancelled"), "new", none, WITH_CANCELLED)).toBeNull();
  });

  it("follows a draft completed and cancelled in one change to the cancelled status", () => {
    const rows: StatusRow[] = [...WITH_CANCELLED, { key: "done", label: "Done", sort: 10, shopifyLink: "draft_completed" }];
    expect(decide(draftSnapshotOf(), cancelled(), "new", none, rows)).toMatchObject({ reason: "cancelled", to: { key: "cancelled" } });
  });

  it("starts an order Shopify already cancelled in the cancelled status, never by a tag alone", () => {
    expect(initialStatusFor(cancelled(), WITH_CANCELLED, "new")).toBe("cancelled");
    expect(initialStatusFor(unfulfilled("Ordering Desk: Cancelled"), WITH_CANCELLED, "new")).toBe("new");
  });

  it("words the move for the timeline", async () => {
    const { db } = await setup();
    await seedOrder(db, WS, { id: "o1", statusKey: "shipped" });
    const change = await applyShopifyMove(db, WS, "o1", "shipped", WITH_CANCELLED[5], "cancelled", NOW);
    expect(change?.event).toMatchObject({
      text: "Cancelled in Shopify. Status set to Cancelled",
      meta: { from: "shipped", to: "cancelled", reason: "cancelled" },
      source: "shopify",
      actorId: null,
    });
  });
});
```

(The last test needs a `cancelled` status row in the database: the `setup()` of this file seeds `STATUSES`; add `await seedCancelledStatus(db, WS);` after `setup()` in that test, importing it from the test helpers.)

`src/server/shopify/webhooks.test.ts` (import `seedCancelledStatus`):

```ts
// Comprehensive design section 2: an order cancelled in Shopify moves its
// card to Cancelled from any status, with a timeline entry.
describe("orders/cancelled", () => {
  it("moves the card to the cancelled status, whatever status it had", async () => {
    const db = await setup();
    await seedCancelledStatus(db, WS);
    await db.insert(schema.orders).values({
      id: "o_c",
      workspaceId: WS,
      shopifyOrderId: "8101",
      name: "#8101",
      shopify: normalizeOrders([orderNode()])[0],
      statusKey: "shipped",
      createdAt: 1,
      syncedAt: 1,
    });
    const { env } = fakeEnv();
    const shop = store({ node: orderNode({ cancelledAt: "2026-10-02T11:59:30Z" }) });
    const receipt = await deliver(
      db,
      env,
      { topic: "orders/cancelled", payload: { id: 8101, admin_graphql_api_id: "gid://shopify/Order/8101" } },
      shop.impl,
    );
    await receipt.work?.();
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, "o_c"));
    expect(row.statusKey).toBe("cancelled");
    const moves = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.orderId, "o_c"), eq(schema.events.type, "status")));
    expect(moves.map((event) => [event.text, event.source, event.actorId])).toEqual([
      ["Cancelled in Shopify. Status set to Cancelled", "shopify", null],
    ]);
  });
});
```

**Step 2: Run them**

Run: `npx vitest run src/server/shopify/status-sync.test.ts src/server/shopify/webhooks.test.ts`
Expected: FAIL, no move is decided for a cancellation and the card stays in Shipped.

**Step 3: Minimal implementation** (`src/server/shopify/status-sync.ts`)

- `export type MoveReason = "tag" | "fulfilled" | "delivered" | "completed" | "cancelled";`
- After `completedNow`, add:

```ts
// An order snapshot Shopify reports cancelled (comprehensive design section
// 2). Drafts are never cancelled (Shopify deletes them).
export function cancelledIn(snapshot: unknown): boolean {
  return (
    snapshotKind(snapshot) === "order" &&
    isRecord(snapshot) &&
    typeof snapshot.cancelledAt === "number" &&
    snapshot.cancelledAt > 0
  );
}

// The change is Shopify's cancellation: not cancelled before, cancelled now.
export function cancelledNow(before: unknown, after: unknown): boolean {
  return cancelledIn(after) && !cancelledIn(before);
}

function linkedToCancelled(rows: readonly StatusRow[]): StatusRow | undefined {
  return [...rows].sort((a, b) => a.sort - b.sort).find((row) => row.shopifyLink === "cancelled");
}
```

- `allowedFor`: first line `if (row.shopifyLink === "cancelled") { return false; }` and extend its comment: "and no card by a tag into the status linked to cancelled (only Shopify's cancellation puts it there)".
- `initialStatusFor`, in the order path (after the draft branch):

```ts
  if (cancelledIn(snapshot)) {
    const cancelled = linkedToCancelled(rows);
    if (cancelled) {
      return cancelled.key;
    }
  }
  const named = statusesNamed(
    tagsOf(snapshot),
    rows.filter((row) => row.shopifyLink !== "cancelled"),
  );
```

- `decideShopifyMove`, first thing after `byKey`:

```ts
  // A cancellation, from any status; it wins over everything else in the
  // same change (a tag, a fulfillment, a draft's completion).
  if (cancelledNow(input.before, input.after)) {
    const to = linkedToCancelled(input.statuses);
    return to && to.key !== input.currentKey ? { to, reason: "cancelled" } : null;
  }
```

- `mightMove`: add `|| cancelledNow(before, after)` to the returned expression.
- `moveText`: add `case "cancelled": return \`Cancelled in Shopify. Status set to ${to.label}\`;`.
- Header: add a bullet under "Shopify -> app": "Cancellation (comprehensive design section 2): the fresh order snapshot carries cancelledAt and the stored one did not: the card moves to the status linked to cancelled FROM ANY STATUS, and nothing else in the same change counts. A tag never moves a card into that status. An order first seen already cancelled starts there."

**Step 4: Run them**

Run: `npx vitest run src/server/shopify/status-sync.test.ts src/server/shopify/webhooks.test.ts src/server/sync/run.test.ts src/server/sync/drafts.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/shopify/status-sync.ts src/server/shopify/status-sync.test.ts src/server/shopify/webhooks.test.ts
git commit -m "feat: orders cancelled in Shopify move their card to Cancelled

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/shopify/status-sync.ts src/server/shopify/status-sync.test.ts src/server/shopify/webhooks.test.ts
```

---

### Task 16: Shopify cancel documents

**Files:**
- Modify: `src/server/shopify/admin.ts` (append a "Cancel an order" section at the end, after `createFulfillment`, line 705)
- Create: `src/server/shopify/admin-cancel.test.ts`
- Test: `src/server/shopify/client.test.ts` (costs)

**Step 1: Write the failing tests**

Create `src/server/shopify/admin-cancel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CANCEL_ORDER_MUTATION,
  ORDER_CANCEL_STATE_QUERY,
  STAFF_NOTE_MAX,
  cancelOrderInShopify,
  fetchOrderCancelState,
} from "./admin";

// Cancel after approval (comprehensive design section 2): orderCancel as
// the 2026-10 Admin API documents it, against a stubbed fetch.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_cancel_docs_token_never_leak";
const ORDER = "gid://shopify/Order/9001";

type Call = { query: string; variables: Record<string, unknown> };

function stub(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("cancelOrderInShopify", () => {
  it("cancels with no customer email, no restock and no refund, and sends nothing else", async () => {
    const { impl, calls } = stub(() => ({
      data: { orderCancel: { job: { id: "gid://shopify/Job/1", done: false }, orderCancelUserErrors: [] } },
    }));
    expect(await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, "Ordering Desk: Duplicate order", impl)).toEqual({
      kind: "ok",
      jobId: "gid://shopify/Job/1",
      done: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe(CANCEL_ORDER_MUTATION);
    expect(calls[0].variables).toEqual({
      orderId: ORDER,
      reason: "OTHER",
      restock: false,
      notifyCustomer: false,
      staffNote: "Ordering Desk: Duplicate order",
    });
    // No refund argument at all: left out, orderCancel refunds nothing.
    expect(CANCEL_ORDER_MUTATION).not.toMatch(/refund/i);
    expect(CANCEL_ORDER_MUTATION).toContain("orderCancelUserErrors { field message code }");
    expect(CANCEL_ORDER_MUTATION).not.toMatch(/\buserErrors\b/);
  });

  it("cuts the staff note to Shopify's 255 characters", async () => {
    const { impl, calls } = stub(() => ({ data: { orderCancel: { job: null, orderCancelUserErrors: [] } } }));
    await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, "x".repeat(400), impl);
    expect(STAFF_NOTE_MAX).toBe(255);
    expect(String(calls[0].variables.staffNote)).toHaveLength(255);
  });

  it("answers Shopify's refusal in its own words", async () => {
    const { impl } = stub(() => ({
      data: {
        orderCancel: {
          job: null,
          orderCancelUserErrors: [{ field: ["orderId"], message: "Order has already been cancelled", code: "INVALID" }],
        },
      },
    }));
    expect(await cancelOrderInShopify(DOMAIN, TOKEN, ORDER, "Ordering Desk: x", impl)).toEqual({
      kind: "refused",
      detail: "Order has already been cancelled",
    });
  });
});

describe("fetchOrderCancelState", () => {
  it("reads whether Shopify cancelled the order, its fulfillment and its total, or null", async () => {
    const { impl, calls } = stub(() => ({
      data: {
        order: {
          id: ORDER,
          name: "#1234",
          cancelledAt: "2026-10-06T15:00:00Z",
          displayFulfillmentStatus: "UNFULFILLED",
          currentTotalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "USD" } },
        },
      },
    }));
    expect(await fetchOrderCancelState(DOMAIN, TOKEN, ORDER, impl)).toEqual({
      kind: "ok",
      order: { name: "#1234", cancelledAt: "2026-10-06T15:00:00Z", fulfillment: "UNFULFILLED", total: "0.0", currency: "USD" },
    });
    expect(calls[0].query).toBe(ORDER_CANCEL_STATE_QUERY);
    expect(calls[0].variables).toEqual({ id: ORDER });
    const gone = stub(() => ({ data: { order: null } }));
    expect(await fetchOrderCancelState(DOMAIN, TOKEN, ORDER, gone.impl)).toEqual({ kind: "ok", order: null });
  });
});
```

In `src/server/shopify/client.test.ts`, import `CANCEL_ORDER_MUTATION` and `ORDER_CANCEL_STATE_QUERY` from `./admin` and add:

```ts
describe("cancel documents", () => {
  it("prices the state read and the cancel", () => {
    // The order and its total (a price set of two objects); the mutation
    // with its job and its error list.
    expect(requestedQueryCost(ORDER_CANCEL_STATE_QUERY)).toBe(3);
    expect(requestedQueryCost(CANCEL_ORDER_MUTATION)).toBe(3);
  });
});
```

**Step 2: Run them**

Run: `npx vitest run src/server/shopify/admin-cancel.test.ts src/server/shopify/client.test.ts`
Expected: FAIL, the cancel exports do not exist.

**Step 3: Minimal implementation** (append to `src/server/shopify/admin.ts`)

```ts
// ---------------------------------------------------------------------------
// Cancel an order (comprehensive design section 2)

// Read right before a cancel and after a timeout: whether Shopify cancelled
// it already, how it is fulfilled, and its total (Ordering Desk cancels only
// $0 orders, because it never refunds).
export const ORDER_CANCEL_STATE_QUERY = `query OrderCancelState($id: ID!) {
  order(id: $id) {
    id
    name
    cancelledAt
    displayFulfillmentStatus
    currentTotalPriceSet { shopMoney { amount currencyCode } }
  }
}`;

export type OrderCancelState = {
  name: string;
  // Shopify's ISO time, or null while the order is not cancelled.
  cancelledAt: string | null;
  // Shopify's own value, for example UNFULFILLED or FULFILLED.
  fulfillment: string;
  total: string | null;
  currency: string;
};

export async function fetchOrderCancelState(
  shopDomain: string,
  token: string,
  orderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; order: OrderCancelState | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, ORDER_CANCEL_STATE_QUERY, { id: orderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const node = result.data.order;
  if (!isRecord(node)) {
    return { kind: "ok", order: null };
  }
  const money =
    isRecord(node.currentTotalPriceSet) && isRecord(node.currentTotalPriceSet.shopMoney) ? node.currentTotalPriceSet.shopMoney : {};
  const amount = money.amount;
  return {
    kind: "ok",
    order: {
      name: typeof node.name === "string" ? node.name : "",
      cancelledAt: typeof node.cancelledAt === "string" && node.cancelledAt.length > 0 ? node.cancelledAt : null,
      fulfillment: typeof node.displayFulfillmentStatus === "string" ? node.displayFulfillmentStatus : "",
      total: typeof amount === "string" ? amount : typeof amount === "number" && Number.isFinite(amount) ? String(amount) : null,
      currency: typeof money.currencyCode === "string" ? money.currencyCode : "USD",
    },
  };
}

// 2026-10: orderCancel(orderId, reason, restock, notifyCustomer,
// refundMethod, staffNote). refundMethod is left out, which refunds nothing
// (Shopify voids an authorization either way; every IMPACT order is $0).
// The deprecated refund argument and userErrors field are not used. Shopify
// cancels in a background job: an accepted cancel returns the job, and the
// order shows cancelledAt once the job is done.
export const CANCEL_ORDER_MUTATION = `mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String) {
  orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
    job { id done }
    orderCancelUserErrors { field message code }
  }
}`;

// Shopify's limit for a cancellation's staff note.
export const STAFF_NOTE_MAX = 255;

// Sends the cancel once. The customer is never emailed, nothing is
// restocked and nothing is refunded. Refusals come back as refused, in
// Shopify's words.
export async function cancelOrderInShopify(
  shopDomain: string,
  token: string,
  orderGid: string,
  staffNote: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; jobId: string | null; done: boolean } | AdminFailure> {
  const result = await shopifyGraphql(
    shopDomain,
    token,
    CANCEL_ORDER_MUTATION,
    { orderId: orderGid, reason: "OTHER", restock: false, notifyCustomer: false, staffNote: staffNote.slice(0, STAFF_NOTE_MAX) },
    fetchImpl,
  );
  if (result.kind !== "ok") {
    return failed(result);
  }
  const payload = isRecord(result.data.orderCancel) ? result.data.orderCancel : {};
  const refused = userErrorsOf({ userErrors: payload.orderCancelUserErrors });
  if (refused) {
    return { kind: "refused", detail: refused };
  }
  const job = isRecord(payload.job) ? payload.job : null;
  return { kind: "ok", jobId: typeof job?.id === "string" ? job.id : null, done: job?.done === true };
}
```

**Step 4: Run them**

Run: `npx vitest run src/server/shopify/admin-cancel.test.ts src/server/shopify/client.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/shopify/admin.ts src/server/shopify/admin-cancel.test.ts src/server/shopify/client.test.ts
git commit -m "feat: orderCancel without email, restock or refund

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/shopify/admin.ts src/server/shopify/admin-cancel.test.ts src/server/shopify/client.test.ts
```

---

### Task 17: Cancel service

**Files:**
- Modify: `src/server/desk/review.ts:177` (export `Access` as a type), `:209-261` (export `linkedStatus` with the `cancelled` link, `actorNameOf`, `shopifyAccess`)
- Create: `src/server/desk/cancel-order.ts`
- Create: `src/server/desk/cancel-order.test.ts`

**Step 1: Write the failing test** (`src/server/desk/cancel-order.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { NOTE_MAX } from "@/lib/limits";
import { CANCEL_COPY, cancelOrder, followCancellation } from "./cancel-order";
import { REVIEW_READY_TRIES, type ReviewDeps } from "./review";
import { openTestDb, seedCancelledStatus, seedDraft, seedWorkspace, snapshotOf } from "./test-helpers";

// Cancel after approval (comprehensive design section 2) against the real
// migrations and a stubbed Shopify. orderCancel never reaches a real store.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_cancel_token_never_leak";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-06T15:00:00.000Z");
const MANAGER = "u_manager";
const ORDER_ID = "9001";
const ORDER_GID = `gid://shopify/Order/${ORDER_ID}`;

type Call = { op: string; variables: Record<string, unknown> };
type ShopOrder = { exists: boolean; cancelledAt: string | null; total: string; fulfillment: string; tags: string[] };

// One order. An accepted CancelOrder starts Shopify's job; the confirmAt-th
// state read after it sees the order cancelled (1: the first read does).
// handle answers an operation another way.
function fakeShop(
  initial: Partial<ShopOrder> = {},
  opts: { confirmAt?: number; handle?: Partial<Record<string, (call: Call) => Response | Promise<Response>>> } = {},
) {
  const state = { exists: true, cancelledAt: null as string | null, total: "0.0", fulfillment: "UNFULFILLED", tags: [] as string[], pending: false, reads: 0, ...initial };
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "unknown";
    const call = { op, variables: body.variables };
    calls.push(call);
    const custom = opts.handle?.[op];
    if (custom) {
      return custom(call);
    }
    switch (op) {
      case "OrderCancelState":
        if (state.pending) {
          state.reads += 1;
          if (state.reads >= (opts.confirmAt ?? 1)) {
            state.cancelledAt = "2026-10-06T15:00:01Z";
            state.pending = false;
          }
        }
        return Response.json({
          data: {
            order: state.exists
              ? {
                  id: ORDER_GID,
                  name: "#1234",
                  cancelledAt: state.cancelledAt,
                  displayFulfillmentStatus: state.fulfillment,
                  currentTotalPriceSet: { shopMoney: { amount: state.total, currencyCode: "USD" } },
                }
              : null,
          },
        });
      case "CancelOrder":
        state.pending = true;
        return Response.json({ data: { orderCancel: { job: { id: "gid://shopify/Job/1", done: false }, orderCancelUserErrors: [] } } });
      case "OrderById":
        return Response.json({
          data: {
            order: {
              id: ORDER_GID,
              legacyResourceId: ORDER_ID,
              name: "#1234",
              createdAt: "2026-10-05T10:00:00Z",
              cancelledAt: state.cancelledAt,
              tags: state.tags,
              displayFulfillmentStatus: state.fulfillment,
              lineItems: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        });
      case "StatusTags":
        return Response.json({ data: { node: { id: call.variables.id, tags: state.tags } } });
      case "StatusTagAdd":
        state.tags = [...state.tags, ...(call.variables.tags as string[])];
        return Response.json({ data: { tagsAdd: { userErrors: [] } } });
      case "StatusTagRemove":
        state.tags = state.tags.filter((tag) => !(call.variables.tags as string[]).includes(tag));
        return Response.json({ data: { tagsRemove: { userErrors: [] } } });
      default:
        throw new Error("unexpected Shopify request: " + op);
    }
  }) as typeof fetch;
  return { impl, calls, state, ops: () => calls.map((call) => call.op) };
}

async function setup(opts: { cancelledStatus?: boolean; statusKey?: string } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  if (opts.cancelledStatus !== false) {
    await seedCancelledStatus(db, WS);
  }
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes: ["read_orders", "write_orders", "read_customers"],
  });
  await db.insert(schema.orders).values({
    id: "o1",
    workspaceId: WS,
    shopifyOrderId: ORDER_ID,
    name: "#1234",
    shopify: snapshotOf({ shopifyOrderId: ORDER_ID, name: "#1234", total: "0.00" }),
    statusKey: opts.statusKey ?? "approved",
    createdAt: 1000,
    syncedAt: 2000,
  });
  return db;
}

const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const deps = (impl: typeof fetch): ReviewDeps => ({ env, fetchImpl: impl, now: () => NOW, sleep: async () => undefined });
const ctx = (role: "manager" | "staff" | "platform" = "manager", orderId = "o1") => ({ workspaceId: WS, orderId, userId: MANAGER, role });

async function card(db: Db) {
  return (await db.select().from(schema.orders).where(eq(schema.orders.id, "o1")))[0];
}

function timeline(db: Db) {
  return db.select().from(schema.events).where(eq(schema.events.orderId, "o1"));
}

const timeout = (): Response => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

describe("cancelOrder", () => {
  it("needs a reason, a manager, an order and a cancelled status, asking Shopify nothing otherwise", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await cancelOrder(db, ctx(), { reason: "  " }, deps(shop.impl))).toEqual({ kind: "invalid", error: CANCEL_COPY.reason });
    expect(await cancelOrder(db, ctx(), { reason: "x".repeat(NOTE_MAX + 1) }, deps(shop.impl))).toEqual({ kind: "invalid", error: CANCEL_COPY.reason });
    expect(await cancelOrder(db, ctx("staff"), { reason: "Duplicate" }, deps(shop.impl))).toEqual({ kind: "forbidden", error: CANCEL_COPY.forbidden });
    expect(await cancelOrder(db, ctx("manager", "nope"), { reason: "Duplicate" }, deps(shop.impl))).toEqual({ kind: "not-found" });
    await seedDraft(db, WS, { id: "d1" });
    expect(await cancelOrder(db, ctx("manager", "d1"), { reason: "Duplicate" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: CANCEL_COPY.draft,
    });
    const bare = await setup({ cancelledStatus: false });
    expect(await cancelOrder(bare, ctx(), { reason: "Duplicate" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: CANCEL_COPY.noStatus,
    });
    const done = await setup({ statusKey: "cancelled" });
    expect(await cancelOrder(done, ctx(), { reason: "Duplicate" }, deps(shop.impl))).toEqual({ kind: "already-cancelled" });
    expect(shop.calls).toEqual([]);
  });

  it("cancels once with no email, restock or refund, and records the move, the reason and the cancellation", async () => {
    const db = await setup();
    const shop = fakeShop();
    const result = await cancelOrder(db, ctx(), { reason: " Duplicate order " }, deps(shop.impl));
    expect(result).toMatchObject({
      kind: "cancelled",
      confirmed: true,
      order: { id: "o1", statusKey: "cancelled", statusSetBy: MANAGER, statusSetAt: NOW },
    });
    expect(shop.ops()).toEqual(["OrderCancelState", "CancelOrder", "OrderCancelState"]);
    expect(shop.calls[1].variables).toEqual({
      orderId: ORDER_GID,
      reason: "OTHER",
      restock: false,
      notifyCustomer: false,
      staffNote: "Ordering Desk: Duplicate order",
    });
    expect(await card(db)).toMatchObject({ statusKey: "cancelled", statusSetBy: MANAGER, statusSetAt: NOW });
    const entries = await timeline(db);
    expect(entries.map((event) => [event.type, event.text, event.actorId, event.source]).sort()).toEqual([
      ["note", "Duplicate order", MANAGER, "app"],
      ["order_cancelled", "Shopify cancelled the order: no email to the customer, no restock, no refund.", MANAGER, "app"],
      ["status", "Cancelled the order in Shopify. Status set to Cancelled", MANAGER, "app"],
    ]);
    expect(entries.find((event) => event.type === "status")?.meta).toEqual({ from: "approved", to: "cancelled", action: "cancel" });
    expect(entries.find((event) => event.type === "note")?.meta).toEqual({ cancelReason: true });
    expect(entries.find((event) => event.type === "order_cancelled")?.meta).toEqual({ confirmed: true, jobId: "gid://shopify/Job/1" });
  });

  it("still moves the card when Shopify has not finished its job, and says so", async () => {
    const db = await setup();
    const shop = fakeShop({}, { confirmAt: 99 });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toMatchObject({ kind: "cancelled", confirmed: false });
    expect(shop.ops().filter((op) => op === "CancelOrder")).toHaveLength(1);
    expect(shop.ops().filter((op) => op === "OrderCancelState")).toHaveLength(1 + REVIEW_READY_TRIES);
    expect((await timeline(db)).find((event) => event.type === "order_cancelled")?.text).toBe(
      "Shopify accepted the cancellation and is finishing it: no email to the customer, no restock, no refund.",
    );
  });

  it("refuses an order that does not total $0.00, sending nothing", async () => {
    const db = await setup();
    const shop = fakeShop({ total: "12.00" });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "This order totals $12.00. Ordering Desk only cancels orders that total $0.00, because it never refunds. Cancel it in Shopify instead.",
    });
    expect(shop.ops()).toEqual(["OrderCancelState"]);
    expect((await card(db)).statusKey).toBe("approved");
  });

  it("follows an order already cancelled in Shopify without sending anything", async () => {
    const db = await setup();
    const shop = fakeShop({ cancelledAt: "2026-10-06T14:00:00Z" });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toMatchObject({
      kind: "cancelled-in-shopify",
      message: "Order #1234 was already cancelled in Shopify. The card is now Cancelled.",
    });
    expect(shop.ops()).toEqual(["OrderCancelState"]);
    expect(await card(db)).toMatchObject({ statusKey: "cancelled", statusSetBy: null });
    expect((await timeline(db)).map((event) => event.text)).toEqual(["Cancelled in Shopify. Status set to Cancelled"]);
  });

  it("changes nothing when Shopify refuses, and says why in plain words", async () => {
    const refusal = (message: string) => () =>
      Response.json({ data: { orderCancel: { job: null, orderCancelUserErrors: [{ field: ["orderId"], message, code: "INVALID" }] } } });
    const db = await setup();
    const shop = fakeShop({}, { handle: { CancelOrder: refusal("Cannot cancel this order.") } });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify did not cancel the order (Shopify said: Cannot cancel this order). Nothing changed.",
    });
    const fulfilled = fakeShop({ fulfillment: "FULFILLED" }, { handle: { CancelOrder: refusal("Fulfillments must be cancelled first.") } });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(fulfilled.impl))).toEqual({
      kind: "refused",
      status: 409,
      error:
        "Shopify did not cancel this order because items on it are already fulfilled (Shopify said: Fulfillments must be cancelled first). Nothing changed.",
    });
    expect((await card(db)).statusKey).toBe("approved");
    expect(await timeline(db)).toEqual([]);
  });

  it("reads after a timeout and never sends the cancel twice", async () => {
    const db = await setup();
    const landed = fakeShop(
      {},
      {
        handle: {
          CancelOrder: () => {
            landed.state.cancelledAt = "2026-10-06T15:00:01Z";
            return timeout();
          },
        },
      },
    );
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(landed.impl))).toMatchObject({ kind: "cancelled", confirmed: true });
    expect(landed.ops()).toEqual(["OrderCancelState", "CancelOrder", "OrderCancelState"]);

    const other = await setup();
    const lost = fakeShop({}, { handle: { CancelOrder: timeout } });
    expect(await cancelOrder(other, ctx(), { reason: "Duplicate order" }, deps(lost.impl))).toEqual({
      kind: "refused",
      status: 502,
      error: CANCEL_COPY.notConfirmed,
    });
    expect(lost.ops()).toEqual(["OrderCancelState", "CancelOrder", "OrderCancelState"]);
    expect((await card(other)).statusKey).toBe("approved");
  });

  it("refuses an order Shopify no longer has", async () => {
    const db = await setup();
    const shop = fakeShop({ exists: false });
    expect(await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: CANCEL_COPY.gone,
    });
  });
});

describe("followCancellation", () => {
  it("writes Shopify's cancelled order onto the card and tags it Cancelled", async () => {
    const db = await setup();
    const shop = fakeShop();
    const result = await cancelOrder(db, ctx(), { reason: "Duplicate order" }, deps(shop.impl));
    if (result.kind !== "cancelled") {
      throw new Error("expected a cancel");
    }
    await followCancellation(db, env, WS, "o1", result, { fetchImpl: shop.impl, now: () => NOW + 1000 });
    const snapshot = (await card(db)).shopify as Record<string, unknown>;
    expect(snapshot.cancelledAt).toBe(Date.parse("2026-10-06T15:00:01Z"));
    expect(shop.state.tags).toEqual(["Ordering Desk: Cancelled"]);
    expect((await card(db)).statusKey).toBe("cancelled");
  });
});
```

**Step 2: Run it**

Run: `npx vitest run src/server/desk/cancel-order.test.ts`
Expected: FAIL, `Failed to resolve import "./cancel-order"`.

**Step 3: Minimal implementation**

`src/server/desk/review.ts`: change `type Access = ...` to `export type Access = ...`; export `linkedStatus`, `actorNameOf` and `shopifyAccess` (add `export` before each), and widen `linkedStatus`'s link parameter to `"draft_completed" | "draft_rejected" | "cancelled"`. No behavior change.

Create `src/server/desk/cancel-order.ts`:

```ts
// Cancel an order after approval (comprehensive design section 2), behind
// POST /api/orders/[orderId]/cancel. Managers and platform admins only (the
// route answers 403 to staff, like Approve and Reject). Orders only: a
// request that is still a draft is rejected instead. A reason is required:
// saved as a note, and (cut to 255 characters) as Shopify's staff note.
//
// Rules, in order: the card must be an order; a status must follow
// Shopify's cancelled state; a card already in it answers
// already-cancelled. The order is read fresh: gone is refused; already
// cancelled in Shopify moves the card the way the orders/cancelled webhook
// would and sends nothing; a total that is not exactly 0 is refused
// (Ordering Desk never refunds). Then orderCancel goes out ONCE with
// notifyCustomer false, restock false and no refundMethod (no refund). A
// refusal changes nothing and says why in plain words. A timeout or a
// transport failure is followed by a read, never a resend: cancelled counts
// as done, anything else asks the manager to check Shopify (the webhook
// moves the card if Shopify did cancel). Shopify cancels in a background
// job, so an accepted cancel is read back up to REVIEW_READY_TRIES times;
// the card moves either way and the entry says whether Shopify confirmed.
// One batch: the move, its status entry, the reason note and an
// order_cancelled entry, the three entries only when the move landed.

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { applyBatch, rowsAffected } from "@/db/batch";
import { events, orders, statuses, storeConnections } from "@/db/schema";
import { formatMoney } from "@/lib/format";
import { NOTE_MAX } from "@/lib/limits";
import { roleAtLeast } from "@/lib/roles";
import { broadcast, broadcastSync } from "@/server/broadcast";
import { notifyActivity } from "@/server/notify";
import {
  cancelOrderInShopify,
  companiesEnabled,
  failureText,
  fetchOrderCancelState,
  fetchOrderNode,
  type OrderCancelState,
} from "@/server/shopify/admin";
import { pushAndShare, shareShopifyMoves } from "@/server/shopify/fanout";
import { normalizeOrders } from "@/server/shopify/normalize";
import { applyShopifyMove, loadStatusRows, safeErrorReason, type StatusChange } from "@/server/shopify/status-sync";
import { getAccessToken } from "@/server/shopify/token";
import { upsertFetchedOrder } from "@/server/sync/run";
import {
  actorNameOf,
  linkedStatus,
  REVIEW_READY_TRIES,
  REVIEW_RETRY_MS,
  shopifyAccess,
  type ReviewContext,
  type ReviewDeps,
} from "./review";
import { eventView, isRecord, type EventView } from "./shapes";

export const CANCEL_COPY = {
  reason: "Give a reason (up to 4000 characters). It is saved as a note on the order.",
  forbidden: "Only a manager can cancel orders.",
  draft: "This request is still a draft. Use Reject instead; only orders are cancelled.",
  noStatus: "No status follows Shopify's cancelled state. A manager can set one in Settings > Statuses.",
  gone: "Shopify no longer has this order.",
  notConfirmed:
    "Shopify did not answer. Check the order in Shopify before trying again. If Shopify cancelled it, the card moves to Cancelled by itself.",
  moveFailed: "Shopify cancelled the order, but its status could not change here. Set it in the status list.",
} as const;

export type CancelOrderView = { id: string; statusKey: string; statusSetBy: string; statusSetAt: number };

export type CancelResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "forbidden"; error: string }
  | { kind: "refused"; status: 409 | 502; error: string }
  | { kind: "already-cancelled" }
  | { kind: "cancelled-in-shopify"; message: string; change: StatusChange | null }
  | {
      kind: "cancelled";
      order: CancelOrderView;
      events: EventView[];
      statusEvent: EventView;
      noteEvent: EventView;
      cancelEvent: EventView;
      // Shopify's background job was seen done (cancelledAt) before the
      // answer; false: accepted, still finishing.
      confirmed: boolean;
    };

type Card = { id: string; shopifyOrderId: string | null; name: string; statusKey: string };

const refused = <S extends 409 | 502>(status: S, error: string) => ({ kind: "refused" as const, status, error });

function sentence(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

function totalRefusal(state: OrderCancelState): string | null {
  const total = state.total;
  if (total !== null && total.trim().length > 0 && Number(total) === 0) {
    return null;
  }
  const amount = total !== null && total.trim().length > 0 ? formatMoney(total, state.currency) : null;
  return amount
    ? `This order totals ${amount}. Ordering Desk only cancels orders that total $0.00, because it never refunds. Cancel it in Shopify instead.`
    : "Shopify did not report this order's total. Ordering Desk only cancels orders that total $0.00, because it never refunds. Cancel it in Shopify instead.";
}

function refusalText(detail: string, state: OrderCancelState): string {
  const said = sentence(detail);
  return state.fulfillment === "FULFILLED" || state.fulfillment === "PARTIALLY_FULFILLED"
    ? `Shopify did not cancel this order because items on it are already fulfilled (Shopify said: ${said}). Nothing changed.`
    : `Shopify did not cancel the order (Shopify said: ${said}). Nothing changed.`;
}

export async function cancelOrder(db: Db, ctx: ReviewContext, body: unknown, deps: ReviewDeps): Promise<CancelResult> {
  const clock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const raw = isRecord(body) ? body.reason : undefined;
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0 || reason.length > NOTE_MAX) {
    return { kind: "invalid", error: CANCEL_COPY.reason };
  }
  const rows = await db
    .select({ id: orders.id, shopifyOrderId: orders.shopifyOrderId, name: orders.name, statusKey: orders.statusKey })
    .from(orders)
    .where(and(eq(orders.id, ctx.orderId), eq(orders.workspaceId, ctx.workspaceId)))
    .limit(1);
  const card: Card | undefined = rows[0];
  if (!card) {
    return { kind: "not-found" };
  }
  if (!roleAtLeast(ctx.role, "manager")) {
    return { kind: "forbidden", error: CANCEL_COPY.forbidden };
  }
  if (card.shopifyOrderId === null) {
    return refused(409, CANCEL_COPY.draft);
  }
  const target = await linkedStatus(db, ctx.workspaceId, "cancelled");
  if (!target) {
    return refused(409, CANCEL_COPY.noStatus);
  }
  if (card.statusKey === target.key) {
    return { kind: "already-cancelled" };
  }
  const granted = await shopifyAccess(db, ctx.workspaceId, deps);
  if (granted.kind !== "ok") {
    return granted;
  }
  const { access } = granted;
  const gid = `gid://shopify/Order/${card.shopifyOrderId}`;

  const before = await fetchOrderCancelState(access.shopDomain, access.token, gid, access.fetchImpl);
  if (before.kind !== "ok") {
    return refused(502, `Could not check the order in Shopify (${sentence(failureText(before))}). Nothing changed. Try again.`);
  }
  if (before.order === null) {
    return refused(409, CANCEL_COPY.gone);
  }
  if (before.order.cancelledAt !== null) {
    return followShopifyCancel(db, ctx, card, before.order.name || card.name, clock);
  }
  const notZero = totalRefusal(before.order);
  if (notZero) {
    return refused(409, notZero);
  }

  const sent = await cancelOrderInShopify(access.shopDomain, access.token, gid, `Ordering Desk: ${reason}`, access.fetchImpl);
  if (sent.kind === "refused") {
    return refused(409, refusalText(sent.detail, before.order));
  }
  let confirmed = false;
  if (sent.kind === "ok") {
    confirmed = sent.done;
    for (let attempt = 0; !confirmed && attempt < REVIEW_READY_TRIES; attempt++) {
      await sleep(REVIEW_RETRY_MS);
      const read = await fetchOrderCancelState(access.shopDomain, access.token, gid, access.fetchImpl);
      confirmed = read.kind === "ok" && read.order !== null && read.order.cancelledAt !== null;
    }
  } else {
    // A timeout or transport failure: read, never send again.
    const read = await fetchOrderCancelState(access.shopDomain, access.token, gid, access.fetchImpl);
    if (read.kind !== "ok" || read.order === null || read.order.cancelledAt === null) {
      return refused(502, CANCEL_COPY.notConfirmed);
    }
    confirmed = true;
  }
  return commitCancel(db, ctx, card, target, reason, confirmed, sent.kind === "ok" ? sent.jobId : null, clock());
}

// The order was cancelled in Shopify before this cancel: nothing is sent;
// the card moves exactly as the orders/cancelled webhook would move it.
async function followShopifyCancel(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  orderName: string,
  clock: () => number,
): Promise<CancelResult> {
  const rows = await loadStatusRows(db, ctx.workspaceId);
  const to = rows.find((row) => row.shopifyLink === "cancelled");
  const change = to ? await applyShopifyMove(db, ctx.workspaceId, card.id, card.statusKey, to, "cancelled", clock()) : null;
  return {
    kind: "cancelled-in-shopify",
    message: `Order ${orderName} was already cancelled in Shopify. The card is now Cancelled.`,
    change,
  };
}

async function commitCancel(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  target: { key: string; label: string },
  reason: string,
  confirmed: boolean,
  jobId: string | null,
  now: number,
): Promise<CancelResult> {
  const base = { workspaceId: ctx.workspaceId, orderId: card.id, actorId: ctx.userId, createdAt: now, source: "app" as const };
  const statusEvent = {
    ...base,
    id: crypto.randomUUID(),
    type: "status" as const,
    text: `Cancelled the order in Shopify. Status set to ${target.label}`,
    meta: { from: card.statusKey, to: target.key, action: "cancel" },
  };
  const noteEvent = { ...base, id: crypto.randomUUID(), type: "note" as const, text: reason, meta: { cancelReason: true } };
  const cancelEvent = {
    ...base,
    id: crypto.randomUUID(),
    type: "order_cancelled" as const,
    text: confirmed
      ? "Shopify cancelled the order: no email to the customer, no restock, no refund."
      : "Shopify accepted the cancellation and is finishing it: no email to the customer, no restock, no refund.",
    meta: { confirmed, jobId },
  };
  const statusExists = sql`exists (select 1 from ${statuses} where ${statuses.workspaceId} = ${ctx.workspaceId} and ${statuses.key} = ${target.key})`;
  const moved = sql`exists (select 1 from ${orders} where ${orders.id} = ${card.id} and ${orders.statusKey} = ${target.key} and ${orders.statusSetAt} = ${now} and ${orders.statusSetBy} = ${ctx.userId})`;
  // Values in the events table's column order (as in changeOrderStatus).
  const insertWhenMoved = (event: typeof statusEvent | typeof noteEvent | typeof cancelEvent) =>
    db
      .insert(events)
      .select(
        sql`select ${event.id}, ${event.workspaceId}, ${event.orderId}, ${event.type}, ${event.text}, ${event.actorId}, ${JSON.stringify(event.meta)}, ${event.createdAt}, ${event.source} where ${moved}`,
      );
  const [update] = await applyBatch(db, [
    db
      .update(orders)
      .set({ statusKey: target.key, statusSetBy: ctx.userId, statusSetAt: now })
      .where(
        and(
          eq(orders.id, card.id),
          eq(orders.workspaceId, ctx.workspaceId),
          isNotNull(orders.shopifyOrderId),
          ne(orders.statusKey, target.key),
          statusExists,
        ),
      ),
    insertWhenMoved(statusEvent),
    insertWhenMoved(noteEvent),
    insertWhenMoved(cancelEvent),
  ]);
  if (rowsAffected(update, "cancel") === 0) {
    const fresh = await db.select({ statusKey: orders.statusKey }).from(orders).where(eq(orders.id, card.id)).limit(1);
    return fresh[0]?.statusKey === target.key ? { kind: "already-cancelled" } : refused(409, CANCEL_COPY.moveFailed);
  }
  const actorName = await actorNameOf(db, ctx.userId);
  const [statusView, noteView, cancelView] = [statusEvent, noteEvent, cancelEvent].map((event) => ({ ...eventView(event), actorName }));
  return {
    kind: "cancelled",
    order: { id: card.id, statusKey: target.key, statusSetBy: ctx.userId, statusSetAt: now },
    events: [statusView, noteView, cancelView],
    statusEvent: statusView,
    noteEvent: noteView,
    cancelEvent: cancelView,
    confirmed,
  };
}

// The order as Shopify has it now, written onto the card (cancelledAt
// lands on the snapshot, so the drawer stops saying "not confirmed").
async function refreshOrderSnapshot(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  deps: Omit<ReviewDeps, "env">,
): Promise<void> {
  const clock = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const rows = await db
    .select({ shopifyOrderId: orders.shopifyOrderId })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
    .limit(1);
  const shopifyOrderId = rows[0]?.shopifyOrderId;
  if (!shopifyOrderId) {
    return;
  }
  // Taken before the fetch, like a sync run's now (the claim rule).
  const now = clock();
  const token = await getAccessToken(db, env, workspaceId, { fetchImpl, now: clock });
  if (token.kind !== "ok") {
    return;
  }
  // The same selection the sync uses for this store (the company location
  // only with a companies scope, Task 4).
  const grant = await db
    .select({ scopes: storeConnections.scopes })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, workspaceId))
    .limit(1);
  const fetched = await fetchOrderNode(token.shopDomain, token.token, `gid://shopify/Order/${shopifyOrderId}`, fetchImpl, {
    companies: companiesEnabled(grant[0]?.scopes),
  });
  const [order] = fetched.kind === "ok" && fetched.node ? normalizeOrders([fetched.node]) : [];
  if (!order) {
    return;
  }
  const outcome = await upsertFetchedOrder(db, workspaceId, order, now);
  if (outcome.kind === "updated" || outcome.kind === "attached") {
    await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [outcome.orderId] });
    await shareShopifyMoves(db, env, workspaceId, outcome.statusChanges, { fetchImpl, now: clock });
  }
}

// After the response: open desks hear about it, members who follow all
// activity get one push, Shopify's cancelled order is written onto the card,
// and the order gets the "Ordering Desk: Cancelled" tag. Never throws.
export async function followCancellation(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  result: Extract<CancelResult, { kind: "cancelled" | "cancelled-in-shopify" }>,
  deps: Omit<ReviewDeps, "env">,
): Promise<void> {
  const opts = { fetchImpl: deps.fetchImpl, now: deps.now };
  try {
    if (result.kind === "cancelled") {
      await broadcast(env, workspaceId, { kind: "order.status", event: result.statusEvent, order: result.order });
      await broadcast(env, workspaceId, { kind: "order.note", event: result.noteEvent });
      await broadcast(env, workspaceId, { kind: "order.activity", event: result.cancelEvent });
      await notifyActivity(db, env, workspaceId, result.statusEvent, opts);
    } else if (result.change) {
      await shareShopifyMoves(db, env, workspaceId, [result.change], opts);
    }
    await refreshOrderSnapshot(db, env, workspaceId, orderId, deps);
    if (result.kind === "cancelled") {
      await pushAndShare(db, env, workspaceId, orderId, opts);
    }
  } catch (e) {
    console.warn("[cancel] " + JSON.stringify({ workspaceId, orderId, follow: safeErrorReason(e) }));
  }
}
```

**Step 4: Run it**

Run: `npx vitest run src/server/desk/cancel-order.test.ts src/server/desk/review.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/desk/cancel-order.ts src/server/desk/cancel-order.test.ts src/server/desk/review.ts
git commit -m "feat: managers cancel approved orders in Shopify, sent once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/desk/cancel-order.ts src/server/desk/cancel-order.test.ts src/server/desk/review.ts
```

---

### Task 18: Cancel route

**Files:**
- Create: `src/app/api/orders/[orderId]/cancel/route.ts`
- Create: `src/app/api/orders/[orderId]/cancel-route.test.ts`

**Step 1: Write the failing test** (`src/app/api/orders/[orderId]/cancel-route.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedMember, seedOrder, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The cancel route: who may call it (401 signed out, 404 for outsiders like
// every order route, 403 for staff, managers and platform admins through)
// and what runs after the response. The service is covered in
// src/server/desk/cancel-order.test.ts; here it is stood in.
type Session = { user: { id: string; email: string } } | null;
const state: { db: Db | null; session: Session; after: Promise<unknown>[] } = { db: null, session: null, after: [] };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "admin@rmh.example" },
    ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));
vi.mock("@/server/desk/cancel-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/desk/cancel-order")>();
  return {
    ...real,
    cancelOrder: vi.fn(async () => ({
      kind: "cancelled",
      order: { id: "o1", statusKey: "cancelled", statusSetBy: "u", statusSetAt: 1 },
      events: [],
      statusEvent: {},
      noteEvent: {},
      cancelEvent: {},
      confirmed: true,
    })),
    followCancellation: vi.fn(async () => undefined),
  };
});

const { POST } = await import("./cancel/route");
const service = await import("@/server/desk/cancel-order");

const context = { params: Promise.resolve({ orderId: "o1" }) };
const post = (body?: unknown) =>
  new Request("https://orderingdesk.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const STAFF: Session = { user: { id: "u_staff", email: "staff@example.com" } };
const MANAGER: Session = { user: { id: "u_manager", email: "manager@example.com" } };
const ADMIN: Session = { user: { id: "u_admin", email: "admin@rmh.example" } };
const STRANGER: Session = { user: { id: "u_stranger", email: "stranger@example.com" } };

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  vi.mocked(service.cancelOrder).mockClear();
  vi.mocked(service.followCancellation).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedOrder(db, "ws_impact", { id: "o1" });
  for (const [id, email] of [
    ["u_staff", "staff@example.com"],
    ["u_manager", "manager@example.com"],
    ["u_admin", "admin@rmh.example"],
    ["u_stranger", "stranger@example.com"],
  ] as const) {
    await seedUser(db, id, email);
  }
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_impact", "u_manager", "manager");
});

describe("POST /api/orders/[orderId]/cancel", () => {
  it("answers 401 signed out, 404 to an outsider and 403 to staff, touching nothing", async () => {
    expect((await POST(post({ reason: "Duplicate" }), context)).status).toBe(401);
    state.session = STRANGER;
    expect((await POST(post({ reason: "Duplicate" }), context)).status).toBe(404);
    state.session = STAFF;
    const staff = await POST(post({ reason: "Duplicate" }), context);
    expect(staff.status).toBe(403);
    expect(await staff.json()).toEqual({ error: "Only a manager can cancel orders." });
    expect(service.cancelOrder).not.toHaveBeenCalled();
  });

  it("lets a manager and a platform admin cancel, following up after the response", async () => {
    for (const [session, role] of [
      [MANAGER, "manager"],
      [ADMIN, "platform"],
    ] as const) {
      state.session = session;
      state.after = [];
      const response = await POST(post({ reason: "Duplicate" }), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: "cancelled",
        order: { id: "o1", statusKey: "cancelled", statusSetBy: "u", statusSetAt: 1 },
        events: [],
        confirmed: true,
      });
      expect(vi.mocked(service.cancelOrder).mock.lastCall?.[1]).toEqual({
        workspaceId: "ws_impact",
        orderId: "o1",
        userId: session!.user.id,
        role,
      });
      expect(vi.mocked(service.cancelOrder).mock.lastCall?.[2]).toEqual({ reason: "Duplicate" });
      await Promise.all(state.after);
      expect(service.followCancellation).toHaveBeenCalled();
    }
  });

  it("passes refusals and bad input through with their status", async () => {
    state.session = MANAGER;
    vi.mocked(service.cancelOrder).mockResolvedValueOnce({ kind: "refused", status: 409, error: "Shopify no longer has this order." });
    const refusedResponse = await POST(post({ reason: "Duplicate" }), context);
    expect(refusedResponse.status).toBe(409);
    expect(await refusedResponse.json()).toEqual({ error: "Shopify no longer has this order." });
    vi.mocked(service.cancelOrder).mockResolvedValueOnce({ kind: "invalid", error: "Give a reason." });
    expect((await POST(post({}), context)).status).toBe(400);
    vi.mocked(service.cancelOrder).mockResolvedValueOnce({ kind: "already-cancelled" });
    expect(await (await POST(post({ reason: "Duplicate" }), context)).json()).toEqual({ kind: "already-cancelled" });
    expect(service.followCancellation).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run it**

Run: `npx vitest run "src/app/api/orders/[orderId]/cancel-route.test.ts"`
Expected: FAIL, `Failed to resolve import "./cancel/route"`.

**Step 3: Minimal implementation** (`src/app/api/orders/[orderId]/cancel/route.ts`)

```ts
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CANCEL_COPY, cancelOrder, followCancellation } from "@/server/desk/cancel-order";
import { guardResponse, requireMemberByOrder, roleAtLeast } from "@/server/guard";

type RouteContext = { params: Promise<{ orderId: string }> };

// Cancel an order after approval (comprehensive design section 2;
// src/server/desk/cancel-order.ts). Body {reason}: trimmed, 1 to 4000
// characters. Managers and platform admins: 404 for outsiders (as every
// order route), 403 for staff. 200 {kind: "cancelled", order, events,
// confirmed}, 200 {kind: "already-cancelled"}, 200 {kind:
// "cancelled-in-shopify", message}; 400, 409 or 502 {error} otherwise
// (nothing changed unless the error says so). Shopify never emails the
// customer, restocks or refunds. The order snapshot, the status tag and the
// pushes follow after the response.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: CANCEL_COPY.forbidden }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as unknown;
    const { env, ctx } = getCloudflareContext();
    const result = await cancelOrder(db, { workspaceId, orderId, userId, role }, body, { env });
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused":
        return NextResponse.json({ error: result.error }, { status: result.status });
      case "already-cancelled":
        return NextResponse.json({ kind: result.kind });
      case "cancelled-in-shopify":
        ctx.waitUntil(followCancellation(db, env, workspaceId, orderId, result, {}));
        return NextResponse.json({ kind: result.kind, message: result.message });
      case "cancelled":
        ctx.waitUntil(followCancellation(db, env, workspaceId, orderId, result, {}));
        return NextResponse.json({ kind: result.kind, order: result.order, events: result.events, confirmed: result.confirmed });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
```

**Step 4: Run it**

Run: `npx vitest run "src/app/api/orders/[orderId]/cancel-route.test.ts"`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add "src/app/api/orders/[orderId]/cancel/route.ts" "src/app/api/orders/[orderId]/cancel-route.test.ts"
git commit -m "feat: POST /api/orders/[orderId]/cancel for managers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- "src/app/api/orders/[orderId]/cancel/route.ts" "src/app/api/orders/[orderId]/cancel-route.test.ts"
```

---

### Task 19: Cancel in the drawer

Use @design-taste-frontend.

**Files:**
- Create: `src/components/desk/cancel-order.tsx`, `src/components/desk/cancel-order.test.ts`
- Modify: `src/lib/order-snapshot.ts:33-57,78-130` (`cancelledAt` on the read snapshot)
- Modify: `src/components/desk/order-drawer.tsx` (props at `:450-504`, header chips at `:579-589`, the panel after `PurchaseOrders` at `:768-776`; the timeline icon already comes from Task 2's event look)
- Modify: `src/components/desk/order-list.tsx` (Wave 1a's `KindMark`: a "Cancelled in Shopify" chip)
- Modify: `src/components/desk/desk.tsx` (a `cancelOrderAction` next to `reject`, `:557-596`; pass it at `:757-758`)
- Test: `src/components/desk/cancel-order.test.ts`, `src/lib/order-snapshot.test.ts`, `src/components/desk/order-drawer.test.ts` (props)

**Step 1: Write the failing tests**

Create `src/components/desk/cancel-order.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CancelOrderPanel, type CancelPanelProps } from "./cancel-order";

// Cancel after approval in the drawer (comprehensive design section 2). The
// server enforces every rule; this checks the panel says the same thing.
const base: CancelPanelProps = {
  name: "#1234",
  canCancel: true,
  cancelled: false,
  pending: false,
  block: null,
  onCancel: async () => null,
};
const render = (overrides: Partial<CancelPanelProps> = {}) =>
  renderToStaticMarkup(createElement(CancelOrderPanel, { ...base, ...overrides }));

describe("CancelOrderPanel", () => {
  it("offers managers Cancel order and says what Shopify will and will not do", () => {
    const html = render();
    expect(html).toContain(">Cancel order<");
    expect(html).toContain("Shopify does not email the customer, restock items or refund anything. This cannot be undone.");
    expect(html).not.toContain('disabled=""');
  });

  it("shows staff nothing while the order is open", () => {
    expect(render({ canCancel: false })).toBe("");
  });

  it("says a cancelled order is cancelled, and when Shopify has not confirmed it yet", () => {
    expect(render({ cancelled: true })).toContain("This order is cancelled in Shopify.");
    expect(render({ cancelled: true })).not.toContain(">Cancel order<");
    expect(render({ cancelled: true, pending: true, canCancel: false })).toContain(
      "Shopify accepted the cancellation but has not confirmed it yet.",
    );
  });

  it("disables Cancel order with its reason", () => {
    const html = render({ block: "No status follows Shopify's cancelled state. A manager can set one in Settings > Statuses." });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Cancel order</);
    expect(html).toContain("No status follows Shopify&#x27;s cancelled state.");
  });
});
```

(React escapes the apostrophe in text as `&#x27;`; if your React version writes `&#39;`, match that.)

`src/lib/order-snapshot.test.ts`, add:

```ts
  it("reads when Shopify cancelled the order, or null", () => {
    expect(readSnapshot({ cancelledAt: 5000 }).cancelledAt).toBe(5000);
    expect(readSnapshot({ cancelledAt: "soon" }).cancelledAt).toBeNull();
    expect(readSnapshot({}).cancelledAt).toBeNull();
  });
```

**Step 2: Run them**

Run: `npx vitest run src/components/desk/cancel-order.test.ts src/lib/order-snapshot.test.ts`
Expected: FAIL, `./cancel-order` does not resolve and `cancelledAt` is undefined.

**Step 3: Minimal implementation**

`src/lib/order-snapshot.ts`: add to `OrderSnapshot` `// When Shopify cancelled the order (ms), or null.` `cancelledAt: number | null;` and to `readSnapshot` `cancelledAt: typeof s.cancelledAt === "number" && Number.isFinite(s.cancelledAt) && s.cancelledAt > 0 ? s.cancelledAt : null,`.

Create `src/components/desk/cancel-order.tsx`:

```tsx
"use client";

// Cancel an order after approval (comprehensive design section 2), near the
// end of an order card's drawer. Managers and platform admins see it; the
// server enforces every rule again. Three steps: a reason (required, saved
// as a note), a review that says exactly what Shopify will and will not do,
// and the irreversible confirm, which follows the Approve step: focus lands
// on the question, a press within CONFIRM_ARM_MS of opening is ignored, and
// Escape or Back steps back. A failure stays in the step with focus on the
// message.

import { useEffect, useId, useRef, useState } from "react";
import { ProhibitIcon } from "@phosphor-icons/react/Prohibit";
import { NOTE_MAX } from "@/lib/limits";
import { InlineMessage, Section, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { focusSoon } from "@/components/settings/kit";
import { confirmArmed } from "./po-send-confirm";

const REASON_REQUIRED = "Give a reason (up to 4000 characters). It is saved as a note on the order.";
const WHAT_HAPPENS = "Shopify does not email the customer, restock items or refund anything. This cannot be undone.";

export type CancelPanelProps = {
  name: string;
  // A manager or platform admin.
  canCancel: boolean;
  // The card sits in the status linked to Shopify's cancelled state.
  cancelled: boolean;
  // Shopify has not confirmed it yet (no cancelledAt on the snapshot).
  pending: boolean;
  // Why Cancel order cannot be used (no cancelled status), or null.
  block: string | null;
  onCancel: (reason: string) => Promise<string | null>;
};

export function CancelOrderPanel({ name, canCancel, cancelled, pending, block, onCancel }: CancelPanelProps) {
  const id = useId();
  const [step, setStep] = useState<"idle" | "reason" | "confirm">("idle");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const openedAt = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (step === "reason") {
      fieldRef.current?.focus();
    }
    if (step === "confirm") {
      openedAt.current = Date.now();
      questionRef.current?.focus();
    }
  }, [step]);

  if (cancelled) {
    return (
      <Section title="Cancelled">
        <p className="text-sm text-ink">This order is cancelled in Shopify.</p>
        {pending ? (
          <div className="mt-3">
            <InlineMessage tone="warn">
              Shopify accepted the cancellation but has not confirmed it yet. Check the order in Shopify if this note stays.
            </InlineMessage>
          </div>
        ) : null}
      </Section>
    );
  }
  if (!canCancel) {
    return null;
  }

  function back(to: "idle" | "reason") {
    setError(null);
    setStep(to);
    focusSoon(() => (to === "idle" ? openRef.current : fieldRef.current));
  }

  function review() {
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > NOTE_MAX) {
      setError(REASON_REQUIRED);
      focusSoon(() => fieldRef.current);
      return;
    }
    setError(null);
    setStep("confirm");
  }

  async function confirm() {
    if (busy || !confirmArmed(openedAt.current, Date.now())) {
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onCancel(reason.trim());
    if (!mounted.current) {
      return;
    }
    setBusy(false);
    if (failure) {
      setError(failure);
      focusSoon(() => errorRef.current);
    }
  }

  return (
    <Section title="Cancel order">
      {step === "idle" ? (
        <>
          <p className="text-sm text-ink-2">Cancels the order in Shopify. {WHAT_HAPPENS}</p>
          <div className="mt-3">
            <button
              ref={openRef}
              type="button"
              onClick={() => setStep("reason")}
              disabled={block !== null}
              aria-describedby={block ? `${id}-why` : undefined}
              className={ui.buttonDangerSecondary}
            >
              <ProhibitIcon size={16} aria-hidden />
              Cancel order
            </button>
          </div>
          {block ? (
            <p id={`${id}-why`} className="mt-2 text-sm text-ink-2">
              {block}
            </p>
          ) : null}
        </>
      ) : null}

      {step === "reason" ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              back("idle");
            }
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={`${id}-reason`} className={ui.label}>
            Reason (saved as a note on this order)
          </label>
          <p id={`${id}-help`} className="-mt-1 text-sm text-ink-2">
            Shopify keeps the first 255 characters as a staff note. The customer never sees it.
          </p>
          <textarea
            id={`${id}-reason`}
            ref={fieldRef}
            rows={3}
            required
            maxLength={NOTE_MAX}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (error === REASON_REQUIRED && event.target.value.trim().length > 0) {
                setError(null);
              }
            }}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
            aria-invalid={error ? true : undefined}
            className={ui.textarea}
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className={ui.errorText}>
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={ui.buttonPrimary}>
              Review cancellation
            </button>
            <button type="button" onClick={() => back("idle")} className={ui.buttonSecondary}>
              Keep the order
            </button>
          </div>
        </form>
      ) : null}

      {step === "confirm" ? (
        <div
          className="flex flex-col gap-3"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.stopPropagation();
              back("reason");
            }
          }}
        >
          <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm text-ink outline-none">
            <span className="font-semibold">Cancel order {name} in Shopify?</span> {WHAT_HAPPENS}
          </p>
          <blockquote className="whitespace-pre-wrap break-words rounded-panel bg-surface-2 px-3 py-2 text-sm text-ink">
            {reason.trim()}
          </blockquote>
          {error ? (
            <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2" data-tone="red">
            <button
              type="button"
              onClick={() => void confirm()}
              aria-busy={busy || undefined}
              aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
              className={ui.buttonDanger}
            >
              {busy ? <Spinner /> : <ProhibitIcon size={16} aria-hidden />}
              {busy ? "Cancelling" : "Cancel order in Shopify"}
            </button>
            <button type="button" onClick={() => back("reason")} disabled={busy} className={ui.buttonSecondary}>
              Back
            </button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
```

`src/components/desk/order-drawer.tsx`:

- Props: add `// Cancel an order after approval: the error to show, or null.` `onCancelOrder: (reason: string) => Promise<string | null>;` and import `CancelOrderPanel` from `./cancel-order`.
- After `const rejectedStatus = ...` add:

```ts
  const cancelledStatus = statuses.find((status) => status.shopifyLink === "cancelled");
  const inCancelled = cancelledStatus !== undefined && statusKey === cancelledStatus.key;
  // Shopify cancelled the order but the card sits elsewhere (no cancelled
  // status, or a manager moved it): say so next to the name.
  const cancelledChip = kind === "order" && snapshot !== null && snapshot.cancelledAt !== null && !inCancelled;
```

- Header: after the Deleted chip add `{cancelledChip ? <Chip tone="slate" size="sm">Cancelled in Shopify</Chip> : null}` (Wave 1a's drawer already imports `Chip` from `@/components/kit`).
- After the `PurchaseOrders` block:

```tsx
            {kind === "order" ? (
              <CancelOrderPanel
                name={name}
                canCancel={canReview}
                cancelled={inCancelled}
                pending={inCancelled && snapshot.cancelledAt === null}
                block={cancelledStatus ? null : "No status follows Shopify's cancelled state. A manager can set one in Settings > Statuses."}
                onCancel={onCancelOrder}
              />
            ) : null}
```

`src/components/desk/order-list.tsx` (Wave 1a's version): `KindMark` takes the key of the cancelled status (`function KindMark({ order, cancelledKey }: { order: OrderSummary; cancelledKey: string | undefined })`), and both `OrderTable` and `OrderCards` pass `cancelledKey={statuses.find((status) => status.shopifyLink === "cancelled")?.key}`. Keep Wave 1a's draft branch (the Draft and Deleted chips) as it is; its order branch (today `return order.draftName ? <span ...>{`from ${order.draftName}`}</span> : null;`) becomes:

```tsx
  // An order Shopify cancelled while its card sits outside the cancelled
  // status (none exists, or a manager moved it) says so.
  const cancelled = order.cancelled && order.statusKey !== cancelledKey;
  if (!order.draftName && !cancelled) {
    return null;
  }
  return (
    <>
      {order.draftName ? <span className="shrink-0 truncate text-xs text-ink-2">{`from ${order.draftName}`}</span> : null}
      {cancelled ? (
        <Chip tone="slate" size="sm">
          Cancelled in Shopify
        </Chip>
      ) : null}
    </>
  );
```

`src/components/desk/desk.tsx`, after `reject`:

```ts
  // Cancel an order after approval (comprehensive design section 2): the
  // error to show inline, or null. The server reads Shopify first, so a
  // retry after a lost answer never sends a second cancel.
  const cancelOrderAction = useCallback(
    async (orderId: string, reason: string): Promise<string | null> => {
      let response: Response;
      try {
        response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
      } catch {
        return "Could not reach the server. Check the order before trying again; a cancel that went through is never sent twice.";
      }
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        kind?: "cancelled" | "already-cancelled" | "cancelled-in-shopify";
        order?: LiveOrderStatus;
        events?: EventView[];
        confirmed?: boolean;
        message?: string;
      } | null;
      if (!response.ok || !body?.kind) {
        return body?.error ?? `Not cancelled (the server answered ${response.status}). Try again.`;
      }
      if (body.kind === "cancelled") {
        for (const event of body.events ?? []) {
          if (event.type === "status" && body.order) {
            applyEvent({ kind: "order.status", event, order: body.order });
          } else if (event.type === "note") {
            applyEvent({ kind: "order.note", event });
          } else {
            applyEvent({ kind: "order.activity", event });
          }
        }
        toast({
          title: body.confirmed
            ? "Cancelled in Shopify. No email, restock or refund."
            : "Shopify is finishing the cancellation. No email, restock or refund.",
          tone: "good",
        });
      } else if (body.kind === "already-cancelled") {
        toast({ title: "This order is already cancelled.", tone: "info" });
      } else {
        toast({ title: body.message ?? "This order was already cancelled in Shopify.", tone: "info" });
      }
      void reload();
      if (openRef.current === orderId) {
        void loadDrawer(orderId, true);
      }
      return null;
    },
    [applyEvent, toast, reload, loadDrawer],
  );
```

and pass `onCancelOrder={(reason) => cancelOrderAction(drawerOrderId, reason)}` to `OrderDrawerContent`. In `src/components/desk/order-drawer.test.ts`, add `onCancelOrder: none,` to the props its `render` passes (the type gate needs it).

**Step 4: Run them**

Run: `npx vitest run src/components/desk/cancel-order.test.ts src/lib/order-snapshot.test.ts src/components/desk/order-drawer.test.ts`
Expected: PASS. Then a local visual check: `npm run dev`, open an approved order card as a manager, walk Cancel order to the confirm step at 1440x900 and 375x812 in light and dark (the local sample store cannot reach Shopify, so the final press shows the server's refusal in the step; that is the error path to check).

**Step 5: Commit**

Gates, then:

```bash
git add src/components/desk/cancel-order.tsx src/components/desk/cancel-order.test.ts src/lib/order-snapshot.ts src/lib/order-snapshot.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/order-list.tsx src/components/desk/desk.tsx
git commit -m "feat: Cancel order in the drawer with reason, review and confirm

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/desk/cancel-order.tsx src/components/desk/cancel-order.test.ts src/lib/order-snapshot.ts src/lib/order-snapshot.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/order-list.tsx src/components/desk/desk.tsx
```

---

### Task 20: Edit helpers (pure)

**Files:**
- Create: `src/lib/request-edit.ts`, `src/lib/request-edit.test.ts`

**Step 1: Write the failing test** (`src/lib/request-edit.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  EDIT_COPY,
  EDIT_LINES_MAX,
  EDIT_QUANTITY_MAX,
  bodyFromForm,
  editLanded,
  lineLabel,
  parseEditBody,
  requestContentKey,
  summarizeEdit,
  type RequestEditor,
} from "./request-edit";

// Editing a request before approval (comprehensive design section 2): what
// the server and the drawer share.

const EDITOR: RequestEditor = {
  updatedAt: "2026-10-06T14:00:00Z",
  lines: [
    { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 2 },
    { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
  ],
  locationId: "101",
  locationName: "Buford HQ",
  locations: [
    { shopifyLocationId: "101", name: "Buford HQ", address: "100 Example Way, Buford GA 30518, US" },
    { shopifyLocationId: "102", name: "Mableton", address: "5 Example Rd, Mableton GA 30126, US" },
  ],
};
const AT = EDITOR.updatedAt;

describe("parseEditBody", () => {
  it("reads lines, quantities and an optional location", () => {
    expect(parseEditBody({ updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" })).toEqual({
      updatedAt: AT,
      lines: [{ uuid: "u-1", quantity: 1 }],
      locationId: "102",
    });
    expect(parseEditBody({ updatedAt: AT, lines: [{ uuid: "u-1", quantity: 3 }] })).toMatchObject({ locationId: null });
  });

  it("refuses an empty list, a bad quantity and anything malformed", () => {
    expect(parseEditBody({ updatedAt: AT, lines: [] })).toEqual({ error: EDIT_COPY.keepOne });
    for (const quantity of [0, 1.5, EDIT_QUANTITY_MAX + 1, "2"]) {
      expect(parseEditBody({ updatedAt: AT, lines: [{ uuid: "u-1", quantity }] })).toEqual({ error: EDIT_COPY.quantity });
    }
    for (const body of [
      null,
      { lines: [{ uuid: "u-1", quantity: 1 }] },
      { updatedAt: "yesterday", lines: [{ uuid: "u-1", quantity: 1 }] },
      { updatedAt: AT, lines: [{ uuid: "u 1", quantity: 1 }] },
      { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }, { uuid: "u-1", quantity: 2 }] },
      { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "gid://shopify/CompanyLocation/102" },
      { updatedAt: AT, lines: Array.from({ length: EDIT_LINES_MAX + 1 }, (_, i) => ({ uuid: `u-${i}`, quantity: 1 })) },
    ]) {
      expect(parseEditBody(body)).toEqual({ error: EDIT_COPY.invalid });
    }
  });
});

describe("summarizeEdit", () => {
  it("names every change in plain words, with the before and after", () => {
    expect(summarizeEdit(EDITOR, { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" })).toEqual({
      changes: ["Hard Hat (White): quantity 2 to 1", "Removed Safety Vest (L)", "Ship to Mableton instead of Buford HQ"],
      before: { lines: ["2 x Hard Hat (White)", "1 x Safety Vest (L)"], shipTo: "Buford HQ" },
      after: { lines: ["1 x Hard Hat (White)"], shipTo: "Mableton" },
    });
  });

  it("finds nothing to change when nothing changed", () => {
    const same = [
      { uuid: "u-1", quantity: 2 },
      { uuid: "u-2", quantity: 1 },
    ];
    expect(summarizeEdit(EDITOR, { updatedAt: AT, lines: same, locationId: null }).changes).toEqual([]);
    expect(summarizeEdit(EDITOR, { updatedAt: AT, lines: same, locationId: "101" }).changes).toEqual([]);
  });

  it("labels a line by its title and variant, skipping Shopify's default variant", () => {
    expect(lineLabel({ title: "Hard Hat", variantTitle: "White" })).toBe("Hard Hat (White)");
    expect(lineLabel({ title: "Gloves", variantTitle: "Default Title" })).toBe("Gloves");
    expect(lineLabel({ title: " ", variantTitle: "" })).toBe("Untitled item");
  });
});

describe("bodyFromForm", () => {
  it("reads the editor's form into a body, sending the location only when it changed", () => {
    expect(bodyFromForm(EDITOR, { quantities: { "u-1": " 3 ", "u-2": "1" }, removed: new Set(["u-2"]), locationId: "101" })).toEqual({
      updatedAt: AT,
      lines: [{ uuid: "u-1", quantity: 3 }],
      locationId: null,
    });
    expect(bodyFromForm(EDITOR, { quantities: {}, removed: new Set(), locationId: "102" })).toEqual({
      updatedAt: AT,
      lines: [
        { uuid: "u-1", quantity: 2 },
        { uuid: "u-2", quantity: 1 },
      ],
      locationId: "102",
    });
  });

  it("refuses a bad quantity or no line left", () => {
    expect(bodyFromForm(EDITOR, { quantities: { "u-1": "0" }, removed: new Set(), locationId: null })).toEqual({ error: EDIT_COPY.quantity });
    expect(bodyFromForm(EDITOR, { quantities: { "u-1": "two" }, removed: new Set(), locationId: null })).toEqual({ error: EDIT_COPY.quantity });
    expect(bodyFromForm(EDITOR, { quantities: {}, removed: new Set(["u-1", "u-2"]), locationId: null })).toEqual({ error: EDIT_COPY.keepOne });
  });
});

describe("editLanded", () => {
  it("says whether Shopify's draft now holds exactly the edit", () => {
    const body = { updatedAt: AT, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" };
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102" }, body)).toBe(true);
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 1 }], locationId: "101" }, body)).toBe(false);
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 2 }, { uuid: "u-2", quantity: 1 }], locationId: "102" }, body)).toBe(false);
    expect(editLanded({ lines: [{ uuid: "u-1", quantity: 1 }], locationId: "101" }, { ...body, locationId: null })).toBe(true);
  });
});

describe("requestContentKey", () => {
  it("changes with the items, quantities, location or total, and is empty without a card", () => {
    const card = { itemTitles: ["Hard Hat"], itemCount: 2, locationId: "101", total: "0.00" };
    expect(requestContentKey(card)).toBe(requestContentKey({ ...card }));
    expect(requestContentKey({ ...card, itemCount: 1 })).not.toBe(requestContentKey(card));
    expect(requestContentKey({ ...card, locationId: "102" })).not.toBe(requestContentKey(card));
    expect(requestContentKey({ ...card, total: "12.00" })).not.toBe(requestContentKey(card));
    expect(requestContentKey(undefined)).toBe("");
  });
});
```

**Step 2: Run it**

Run: `npx vitest run src/lib/request-edit.test.ts`
Expected: FAIL, `Failed to resolve import "./request-edit"`.

**Step 3: Minimal implementation** (`src/lib/request-edit.ts`)

```ts
// Editing a request before approval (comprehensive design section 2): the
// editor the server hands the drawer, the body the drawer sends back, the
// checks both sides share, and the plain before-and-after summary the
// review step shows and the timeline keeps. Pure; relative imports only
// (the server bundles this too).

export const EDIT_LINES_MAX = 50;
export const EDIT_QUANTITY_MAX = 999;

const UUID = /^[A-Za-z0-9-]{1,64}$/;
const LOCATION_ID = /^[1-9]\d{0,19}$/;
const WHOLE = /^\d+$/;

// One draft line as the editor shows it. propertyCount: the personalization
// fields riding on the line (underscore keys left out), kept exactly.
export type EditableLine = {
  uuid: string;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  propertyCount: number;
};

// A company location the request may ship to; address on one line.
export type EditLocationOption = { shopifyLocationId: string; name: string; address: string };

// updatedAt: Shopify's updatedAt as the editor read it, the token a save
// must repeat. locations: empty when the location cannot change.
export type RequestEditor = {
  updatedAt: string;
  lines: EditableLine[];
  locationId: string | null;
  locationName: string;
  locations: EditLocationOption[];
};

// lines: every line that stays, with its quantity (a line left out is
// removed). locationId: the new company location, or null to keep it.
export type EditRequestBody = { updatedAt: string; lines: { uuid: string; quantity: number }[]; locationId: string | null };

export type EditSummary = {
  changes: string[];
  before: { lines: string[]; shipTo: string };
  after: { lines: string[]; shipTo: string };
};

export const EDIT_COPY = {
  invalid: "The changes could not be read. Close the editor, open it again and make them again.",
  keepOne: "A request keeps at least one item. Reject it instead if nothing should ship.",
  quantity: `Each quantity must be a whole number from 1 to ${EDIT_QUANTITY_MAX}.`,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEditBody(body: unknown): EditRequestBody | { error: string } {
  if (
    !isRecord(body) ||
    typeof body.updatedAt !== "string" ||
    body.updatedAt.length === 0 ||
    body.updatedAt.length > 40 ||
    Number.isNaN(Date.parse(body.updatedAt))
  ) {
    return { error: EDIT_COPY.invalid };
  }
  if (!Array.isArray(body.lines) || body.lines.length > EDIT_LINES_MAX) {
    return { error: EDIT_COPY.invalid };
  }
  if (body.lines.length === 0) {
    return { error: EDIT_COPY.keepOne };
  }
  const lines: { uuid: string; quantity: number }[] = [];
  const seen = new Set<string>();
  for (const raw of body.lines) {
    if (!isRecord(raw) || typeof raw.uuid !== "string" || !UUID.test(raw.uuid) || seen.has(raw.uuid)) {
      return { error: EDIT_COPY.invalid };
    }
    if (typeof raw.quantity !== "number" || !Number.isInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > EDIT_QUANTITY_MAX) {
      return { error: EDIT_COPY.quantity };
    }
    seen.add(raw.uuid);
    lines.push({ uuid: raw.uuid, quantity: raw.quantity });
  }
  let locationId: string | null = null;
  if (body.locationId !== undefined && body.locationId !== null) {
    if (typeof body.locationId !== "string" || !LOCATION_ID.test(body.locationId)) {
      return { error: EDIT_COPY.invalid };
    }
    locationId = body.locationId;
  }
  return { updatedAt: body.updatedAt, lines, locationId };
}

// "Hard Hat (White)"; Shopify's "Default Title" variant is no variant.
export function lineLabel(line: Pick<EditableLine, "title" | "variantTitle">): string {
  const title = line.title.trim() || "Untitled item";
  const variant = line.variantTitle.trim();
  return variant && variant !== "Default Title" ? `${title} (${variant})` : title;
}

function placeName(editor: RequestEditor, locationId: string | null): string {
  if (locationId === null) {
    return editor.locationName || "no company location";
  }
  const option = editor.locations.find((entry) => entry.shopifyLocationId === locationId);
  if (option) {
    return option.name;
  }
  return locationId === editor.locationId && editor.locationName ? editor.locationName : `location ${locationId}`;
}

export function summarizeEdit(editor: RequestEditor, body: EditRequestBody): EditSummary {
  const quantities = new Map(body.lines.map((line) => [line.uuid, line.quantity]));
  const changes: string[] = [];
  for (const line of editor.lines) {
    const next = quantities.get(line.uuid);
    if (next === undefined) {
      changes.push(`Removed ${lineLabel(line)}`);
    } else if (next !== line.quantity) {
      changes.push(`${lineLabel(line)}: quantity ${line.quantity} to ${next}`);
    }
  }
  const moves = body.locationId !== null && body.locationId !== editor.locationId;
  if (moves) {
    changes.push(`Ship to ${placeName(editor, body.locationId)} instead of ${placeName(editor, editor.locationId)}`);
  }
  return {
    changes,
    before: { lines: editor.lines.map((line) => `${line.quantity} x ${lineLabel(line)}`), shipTo: placeName(editor, editor.locationId) },
    after: {
      lines: editor.lines
        .filter((line) => quantities.has(line.uuid))
        .map((line) => `${quantities.get(line.uuid)} x ${lineLabel(line)}`),
      shipTo: placeName(editor, moves ? body.locationId : editor.locationId),
    },
  };
}

// The editor form's state as a body: quantities as typed, removed lines,
// the picked location (sent only when it changed).
export function bodyFromForm(
  editor: RequestEditor,
  form: { quantities: Record<string, string>; removed: ReadonlySet<string>; locationId: string | null },
): EditRequestBody | { error: string } {
  const lines: { uuid: string; quantity: number }[] = [];
  for (const line of editor.lines) {
    if (form.removed.has(line.uuid)) {
      continue;
    }
    const raw = (form.quantities[line.uuid] ?? String(line.quantity)).trim();
    if (!WHOLE.test(raw)) {
      return { error: EDIT_COPY.quantity };
    }
    const quantity = Number(raw);
    if (quantity < 1 || quantity > EDIT_QUANTITY_MAX) {
      return { error: EDIT_COPY.quantity };
    }
    lines.push({ uuid: line.uuid, quantity });
  }
  if (lines.length === 0) {
    return { error: EDIT_COPY.keepOne };
  }
  return { updatedAt: editor.updatedAt, lines, locationId: form.locationId !== editor.locationId ? form.locationId : null };
}

// Whether Shopify's draft now holds exactly the edit (the read after a
// timeout: done, or never sent).
export function editLanded(
  current: { lines: { uuid: string; quantity: number }[]; locationId: string | null },
  body: EditRequestBody,
): boolean {
  if (current.lines.length !== body.lines.length) {
    return false;
  }
  const wanted = new Map(body.lines.map((line) => [line.uuid, line.quantity]));
  return (
    current.lines.every((line) => wanted.get(line.uuid) === line.quantity) &&
    (body.locationId === null || current.locationId === body.locationId)
  );
}

// Changes whenever the request's content changes (items, quantities,
// location, total): an open Approve confirmation closes when it does.
export function requestContentKey(
  summary: { itemTitles: string[]; itemCount: number; locationId: string | null; total: string } | undefined,
): string {
  return summary ? JSON.stringify([summary.itemTitles, summary.itemCount, summary.locationId, summary.total]) : "";
}
```

**Step 4: Run it**

Run: `npx vitest run src/lib/request-edit.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/lib/request-edit.ts src/lib/request-edit.test.ts
git commit -m "feat: shared checks and plain summaries for editing requests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/request-edit.ts src/lib/request-edit.test.ts
```

---

### Task 21: Shopify edit documents

**Files:**
- Modify: `src/server/shopify/admin.ts` (imports at `:11-12`; a "Edit a request" section after the approve section, before the line item section at `:409`)
- Create: `src/server/shopify/admin-edit.test.ts`
- Test: `src/server/shopify/client.test.ts` (costs)

**Step 1: Write the failing tests**

Create `src/server/shopify/admin-edit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DRAFT_FOR_EDIT_QUERY, EDIT_DRAFT_MUTATION, fetchDraftForEdit, productsEnabled, updateDraftOrder } from "./admin";

// Editing a request (comprehensive design section 2): the fresh read and
// draftOrderUpdate, against a stubbed fetch.

const DOMAIN = "impact-rentals.myshopify.com";
const TOKEN = "shpat_edit_docs_token_never_leak";
const DRAFT = "gid://shopify/DraftOrder/12";
const LONG = "x".repeat(2500);

type Call = { query: string; variables: Record<string, unknown> };

function stub(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? "{}")) as Call;
    calls.push(call);
    const body = answer(call);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const editNode = {
  id: DRAFT,
  name: "#D12",
  status: "OPEN",
  updatedAt: "2026-10-06T14:00:00Z",
  purchasingEntity: {
    __typename: "PurchasingCompany",
    company: { id: "gid://shopify/Company/7" },
    contact: { id: "gid://shopify/CompanyContact/31" },
    location: { id: "gid://shopify/CompanyLocation/101", name: "Buford HQ" },
  },
  shippingAddress: { firstName: "Casey", lastName: "Lin" },
  lineItems: {
    nodes: [
      {
        uuid: "u-1",
        custom: false,
        quantity: 2,
        title: "Hard Hat",
        sku: "HH-1",
        variantTitle: "White",
        variant: { id: "gid://shopify/ProductVariant/501" },
        customAttributes: [
          { key: "Full Name", value: "Casey Lin" },
          { key: "Office Address", value: "100 Example Way\r\nBuford, GA 30518" },
          { key: "Notes", value: LONG },
          { key: "Empty", value: null },
        ],
        appliedDiscount: null,
        priceOverride: null,
        components: [],
      },
      {
        uuid: "u-2",
        custom: true,
        quantity: 1,
        title: "Custom banner",
        sku: null,
        variantTitle: null,
        variant: null,
        customAttributes: [],
        appliedDiscount: { title: "Staff" },
        priceOverride: null,
        components: [{ uuid: "c-1" }],
      },
    ],
    pageInfo: { hasNextPage: false },
  },
};

describe("fetchDraftForEdit", () => {
  it("reads every line with its uuid, variant and attributes exactly, and the company location", async () => {
    const { impl, calls } = stub(() => ({ data: { draftOrder: editNode } }));
    expect(await fetchDraftForEdit(DOMAIN, TOKEN, DRAFT, impl)).toEqual({
      kind: "ok",
      draft: {
        name: "#D12",
        status: "OPEN",
        updatedAt: "2026-10-06T14:00:00Z",
        company: {
          companyGid: "gid://shopify/Company/7",
          companyId: "7",
          contactGid: "gid://shopify/CompanyContact/31",
          locationGid: "gid://shopify/CompanyLocation/101",
          locationId: "101",
          locationName: "Buford HQ",
        },
        recipient: { firstName: "Casey", lastName: "Lin" },
        lines: [
          {
            uuid: "u-1",
            variantId: "gid://shopify/ProductVariant/501",
            quantity: 2,
            title: "Hard Hat",
            variantTitle: "White",
            sku: "HH-1",
            custom: false,
            // Never capped or trimmed: a save sends these back exactly.
            attributes: [
              { key: "Full Name", value: "Casey Lin" },
              { key: "Office Address", value: "100 Example Way\r\nBuford, GA 30518" },
              { key: "Notes", value: LONG },
              { key: "Empty", value: "" },
            ],
            priced: false,
            bundle: false,
          },
          {
            uuid: "u-2",
            variantId: null,
            quantity: 1,
            title: "Custom banner",
            variantTitle: "",
            sku: "",
            custom: true,
            attributes: [],
            priced: true,
            bundle: true,
          },
        ],
        complete: true,
      },
    });
    expect(calls[0].query).toBe(DRAFT_FOR_EDIT_QUERY);
    expect(calls[0].variables).toEqual({ id: DRAFT });
  });

  it("reads a customer's own draft without a company, and null when Shopify has none", async () => {
    const plain = stub(() => ({
      data: { draftOrder: { ...editNode, purchasingEntity: { __typename: "Customer" }, lineItems: { nodes: [], pageInfo: { hasNextPage: true } } } },
    }));
    expect(await fetchDraftForEdit(DOMAIN, TOKEN, DRAFT, plain.impl)).toMatchObject({
      kind: "ok",
      draft: { company: null, lines: [], complete: false },
    });
    const gone = stub(() => ({ data: { draftOrder: null } }));
    expect(await fetchDraftForEdit(DOMAIN, TOKEN, DRAFT, gone.impl)).toEqual({ kind: "ok", draft: null });
  });
});

describe("updateDraftOrder", () => {
  it("sends the id and the input exactly, and returns the updated draft", async () => {
    const input = { lineItems: [{ uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 1, customAttributes: [] }] };
    const { impl, calls } = stub(() => ({ data: { draftOrderUpdate: { draftOrder: { id: DRAFT, name: "#D12" }, userErrors: [] } } }));
    expect(await updateDraftOrder(DOMAIN, TOKEN, DRAFT, input, impl)).toEqual({ kind: "ok", node: { id: DRAFT, name: "#D12" } });
    expect(calls[0].query).toBe(EDIT_DRAFT_MUTATION);
    expect(calls[0].variables).toEqual({ id: DRAFT, input });
  });

  it("answers Shopify's refusal in its own words", async () => {
    const { impl } = stub(() => ({
      data: { draftOrderUpdate: { draftOrder: null, userErrors: [{ field: ["lineItems"], message: "Quantity is invalid" }] } },
    }));
    expect(await updateDraftOrder(DOMAIN, TOKEN, DRAFT, { lineItems: [] }, impl)).toEqual({ kind: "refused", detail: "Quantity is invalid" });
  });
});

describe("productsEnabled", () => {
  it("needs read_products or write_products to read variant ids", () => {
    expect(productsEnabled(["read_products"])).toBe(true);
    expect(productsEnabled(["write_products"])).toBe(true);
    expect(productsEnabled(["write_draft_orders"])).toBe(false);
    expect(productsEnabled(null)).toBe(false);
  });
});
```

In `src/server/shopify/client.test.ts`, import `DRAFT_FOR_EDIT_QUERY` and `EDIT_DRAFT_MUTATION` from `./admin` and add to `describe("draft order documents", ...)`:

```ts
  it("keeps the edit read and the edit mutation under budget", () => {
    // The draft, the purchasing entity (5 as this estimator prices the
    // company fragment), the shipping address, and 50 line slots of 6 (the
    // line, its variant, attributes, discount, price override and bundle
    // components) with the connection and its pageInfo.
    expect(requestedQueryCost(DRAFT_FOR_EDIT_QUERY)).toBe(1 + 5 + 1 + (3 + 50 * 6));
    expect(requestedQueryCost(EDIT_DRAFT_MUTATION)).toBe(1 + (1 + 18 + 4 * 35) + 1);
    expect(requestedQueryCost(DRAFT_FOR_EDIT_QUERY)).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });
```

**Step 2: Run them**

Run: `npx vitest run src/server/shopify/admin-edit.test.ts src/server/shopify/client.test.ts`
Expected: FAIL, the edit exports do not exist.

**Step 3: Minimal implementation** (`src/server/shopify/admin.ts`)

- Imports: `import { EDIT_LINES_MAX } from "../../lib/request-edit";` and add `companyLocationIdOf` to the `./normalize` import.
- After `completeDraft`, add:

```ts
// ---------------------------------------------------------------------------
// Edit a request (comprehensive design section 2)

// Reading a line's variant id needs read_products (or write_products).
export function productsEnabled(granted: readonly string[] | null | undefined): boolean {
  return Array.isArray(granted) && (granted.includes("read_products") || granted.includes("write_products"));
}

// Read fresh before an edit and after a timeout: every line with its uuid,
// variant and custom attributes exactly as Shopify has them (the stored
// snapshot caps attribute values, so it is never the source of a save),
// what would make a line impossible to keep exactly, the purchasing
// company, contact and location, the recipient's name, and updatedAt (the
// edit's concurrency token). 310 points by the client.test.ts estimator.
export const DRAFT_FOR_EDIT_QUERY = `query DraftForEdit($id: ID!) {
  draftOrder(id: $id) {
    id
    name
    status
    updatedAt
    purchasingEntity {
      __typename
      ... on PurchasingCompany { company { id } contact { id } location { id name } }
    }
    shippingAddress { firstName lastName }
    lineItems(first: ${EDIT_LINES_MAX}) {
      nodes {
        uuid
        custom
        quantity
        title
        sku
        variantTitle
        variant { id }
        customAttributes { key value }
        appliedDiscount { title }
        priceOverride { amount }
        components { uuid }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

export type DraftForEditLine = {
  uuid: string;
  // The ProductVariant gid, or null (a custom line, or a deleted variant).
  variantId: string | null;
  quantity: number;
  title: string;
  variantTitle: string;
  sku: string;
  custom: boolean;
  // Exactly as Shopify sent them; a null value reads as "".
  attributes: { key: string; value: string }[];
  // The line carries its own discount or a price override.
  priced: boolean;
  // The line is a bundle with components.
  bundle: boolean;
};

export type DraftForEdit = {
  name: string;
  // Shopify's own value: OPEN, INVOICE_SENT or COMPLETED.
  status: string;
  updatedAt: string;
  // Null for a customer's own (D2C) draft. Gids for the update, legacy ids
  // for the locations table.
  company: {
    companyGid: string;
    companyId: string;
    contactGid: string | null;
    locationGid: string;
    locationId: string;
    locationName: string;
  } | null;
  recipient: { firstName: string; lastName: string } | null;
  lines: DraftForEditLine[];
  // Shopify said there are no more lines than the ones read.
  complete: boolean;
};

const COMPANY_GID = /^gid:\/\/shopify\/Company\/([1-9]\d{0,19})$/;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function draftForEditOf(node: Record<string, unknown>): DraftForEdit {
  const entity = isRecord(node.purchasingEntity) ? node.purchasingEntity : null;
  const companyNode = entity && isRecord(entity.company) ? entity.company : null;
  const contactNode = entity && isRecord(entity.contact) ? entity.contact : null;
  const locationNode = entity && isRecord(entity.location) ? entity.location : null;
  const companyGid = text(companyNode?.id);
  const locationGid = text(locationNode?.id);
  const companyId = companyGid.match(COMPANY_GID)?.[1] ?? null;
  const locationId = companyLocationIdOf(locationGid);
  const shipping = isRecord(node.shippingAddress) ? node.shippingAddress : null;
  const connection = isRecord(node.lineItems) ? node.lineItems : {};
  const nodes = Array.isArray(connection.nodes) ? connection.nodes.filter(isRecord) : [];
  const pageInfo = isRecord(connection.pageInfo) ? connection.pageInfo : {};
  return {
    name: text(node.name),
    status: text(node.status),
    updatedAt: text(node.updatedAt),
    company:
      companyId && locationId
        ? {
            companyGid,
            companyId,
            contactGid: typeof contactNode?.id === "string" ? contactNode.id : null,
            locationGid,
            locationId,
            locationName: text(locationNode?.name),
          }
        : null,
    recipient: shipping ? { firstName: text(shipping.firstName), lastName: text(shipping.lastName) } : null,
    lines: nodes
      .filter((line) => typeof line.uuid === "string" && line.uuid.length > 0)
      .map((line) => ({
        uuid: line.uuid as string,
        variantId: isRecord(line.variant) && typeof line.variant.id === "string" ? line.variant.id : null,
        quantity: typeof line.quantity === "number" && Number.isInteger(line.quantity) ? line.quantity : 1,
        title: text(line.title),
        variantTitle: text(line.variantTitle),
        sku: text(line.sku),
        custom: line.custom === true,
        attributes: Array.isArray(line.customAttributes)
          ? line.customAttributes
              .filter(isRecord)
              .filter((attribute) => typeof attribute.key === "string")
              .map((attribute) => ({ key: attribute.key as string, value: text(attribute.value) }))
          : [],
        priced: isRecord(line.appliedDiscount) || isRecord(line.priceOverride),
        bundle: Array.isArray(line.components) && line.components.length > 0,
      })),
    complete: pageInfo.hasNextPage === false,
  };
}

// The draft as Shopify has it now, or null when it no longer exists.
export async function fetchDraftForEdit(
  shopDomain: string,
  token: string,
  draftOrderGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; draft: DraftForEdit | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, DRAFT_FOR_EDIT_QUERY, { id: draftOrderGid }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  return { kind: "ok", draft: isRecord(result.data.draftOrder) ? draftForEditOf(result.data.draftOrder) : null };
}

// draftOrderUpdate with the input the edit service builds (the full line
// list, the purchasing entity, and a shipping address only for a new
// location; never tags, note or cart attributes). The response carries the
// draft in the sync's own selection, so the card is written at once.
export const EDIT_DRAFT_MUTATION = `mutation EditDraft($id: ID!, $input: DraftOrderInput!) {
  draftOrderUpdate(id: $id, input: $input) {
    draftOrder {${DRAFT_FIELDS}
    }
    userErrors { field message }
  }
}`;

export async function updateDraftOrder(
  shopDomain: string,
  token: string,
  draftOrderGid: string,
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: "ok"; node: Record<string, unknown> | null } | AdminFailure> {
  const result = await shopifyGraphql(shopDomain, token, EDIT_DRAFT_MUTATION, { id: draftOrderGid, input }, fetchImpl);
  if (result.kind !== "ok") {
    return failed(result);
  }
  const payload = result.data.draftOrderUpdate;
  const refused = userErrorsOf(payload);
  if (refused) {
    return { kind: "refused", detail: refused };
  }
  return { kind: "ok", node: isRecord(payload) && isRecord(payload.draftOrder) ? payload.draftOrder : null };
}
```

**Step 4: Run them**

Run: `npx vitest run src/server/shopify/admin-edit.test.ts src/server/shopify/client.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/shopify/admin.ts src/server/shopify/admin-edit.test.ts src/server/shopify/client.test.ts
git commit -m "feat: read a draft exactly for editing, and draftOrderUpdate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/shopify/admin.ts src/server/shopify/admin-edit.test.ts src/server/shopify/client.test.ts
```

---

### Task 22: Edit service

**Files:**
- Create: `src/server/desk/edit-request.ts`, `src/server/desk/edit-request.test.ts`

**Step 1: Write the failing test** (`src/server/desk/edit-request.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { EDIT_COPY } from "@/lib/request-edit";
import { EDIT_REFUSALS, editRequest, loadRequestEditor } from "./edit-request";
import { REVIEW_COPY, REVIEW_READY_TRIES, type ReviewDeps } from "./review";
import { openTestDb, seedDraft, seedDraftStatuses, seedLocation, seedOrder, seedWorkspace } from "./test-helpers";

// Editing a request before approval (comprehensive design section 2)
// against the real migrations and a stubbed Shopify. draftOrderUpdate never
// reaches a real store.

const WS = "ws_impact";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TOKEN = "shpat_edit_token_never_leak";
const SHOP = "impact-rentals.myshopify.com";
const NOW = Date.parse("2026-10-06T15:00:00.000Z");
const MANAGER = "u_manager";
const DRAFT_GID = "gid://shopify/DraftOrder/12";
const UPDATED = "2026-10-06T14:00:00Z";
const SCOPES = ["read_orders", "write_orders", "read_customers", "write_draft_orders", "read_products", "read_companies"];

const address = (city: string, zip: string, address1: string) => ({
  address1,
  address2: "",
  city,
  province: "Georgia",
  provinceCode: "GA",
  zip,
  country: "United States",
  countryCode: "US",
  phone: "",
  company: "Example Rentals",
});

type ShopLine = {
  uuid: string;
  variantId: string | null;
  quantity: number;
  title: string;
  variantTitle: string;
  sku: string;
  attributes: { key: string; value: string }[];
  custom?: boolean;
  priced?: boolean;
  bundle?: boolean;
};
type ShopDraft = {
  exists: boolean;
  status: string;
  updatedAt: string;
  b2b: boolean;
  contact: boolean;
  locationId: string;
  lines: ShopLine[];
  total: string;
  ready: boolean;
  more: boolean;
};
type Call = { op: string; variables: Record<string, unknown> };

const LINES: ShopLine[] = [
  {
    uuid: "u-1",
    variantId: "gid://shopify/ProductVariant/501",
    quantity: 2,
    title: "Hard Hat",
    variantTitle: "White",
    sku: "HH-1",
    attributes: [
      { key: "Full Name", value: "Casey Lin" },
      { key: "_pdf", value: "https://cdn.shopify.com/s/files/1/proof.pdf" },
      { key: "Office Address", value: "100 Example Way\r\nBuford, GA 30518" },
    ],
  },
  { uuid: "u-2", variantId: "gid://shopify/ProductVariant/502", quantity: 1, title: "Safety Vest", variantTitle: "L", sku: "SV-L", attributes: [] },
];
const NAMES: Record<string, string> = { "101": "Buford HQ", "102": "Mableton" };

// A store with draft #D12. EditDraft applies its input like Shopify would;
// totalAfterEdit and readyAfterEdit say what Shopify reports afterwards.
function fakeShop(
  initial: Partial<ShopDraft> = {},
  opts: {
    totalAfterEdit?: string;
    readyAfterEdit?: boolean;
    handle?: Partial<Record<string, (call: Call) => Response | Promise<Response>>>;
  } = {},
) {
  const state: ShopDraft = {
    exists: true,
    status: "OPEN",
    updatedAt: UPDATED,
    b2b: true,
    contact: true,
    locationId: "101",
    lines: LINES.map((line) => ({ ...line, attributes: [...line.attributes] })),
    total: "0.0",
    ready: true,
    more: false,
    ...initial,
  };
  const calls: Call[] = [];
  const location = () => ({ id: `gid://shopify/CompanyLocation/${state.locationId}`, name: NAMES[state.locationId] ?? "Elsewhere" });
  const editNode = () => ({
    id: DRAFT_GID,
    name: "#D12",
    status: state.status,
    updatedAt: state.updatedAt,
    purchasingEntity: state.b2b
      ? {
          __typename: "PurchasingCompany",
          company: { id: "gid://shopify/Company/7" },
          contact: state.contact ? { id: "gid://shopify/CompanyContact/31" } : null,
          location: location(),
        }
      : { __typename: "Customer" },
    shippingAddress: { firstName: "Casey", lastName: "Lin" },
    lineItems: {
      nodes: state.lines.map((line) => ({
        uuid: line.uuid,
        custom: line.custom ?? false,
        quantity: line.quantity,
        title: line.title,
        sku: line.sku,
        variantTitle: line.variantTitle,
        variant: line.variantId ? { id: line.variantId } : null,
        customAttributes: line.attributes,
        appliedDiscount: line.priced ? { title: "Staff" } : null,
        priceOverride: null,
        components: line.bundle ? [{ uuid: "c-1" }] : [],
      })),
      pageInfo: { hasNextPage: state.more },
    },
  });
  const fullNode = () => ({
    id: DRAFT_GID,
    legacyResourceId: "12",
    name: "#D12",
    status: state.status,
    createdAt: "2026-10-05T10:00:00Z",
    updatedAt: state.updatedAt,
    email: "jordan@example.com",
    tags: [],
    customAttributes: [],
    purchasingEntity: state.b2b
      ? { __typename: "PurchasingCompany", company: { id: "gid://shopify/Company/7", name: "Example Rentals" }, location: location() }
      : { __typename: "Customer" },
    totalPriceSet: { shopMoney: { amount: state.total, currencyCode: "USD" } },
    lineItems: {
      nodes: state.lines.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        sku: line.sku,
        variantTitle: line.variantTitle,
        custom: false,
        customAttributes: line.attributes,
        originalUnitPriceSet: { shopMoney: { amount: "0.0" } },
      })),
      pageInfo: { hasNextPage: false },
    },
  });
  const applyEdit = (input: Record<string, unknown>) => {
    const items = input.lineItems as { uuid: string; quantity: number; customAttributes: { key: string; value: string }[] }[];
    state.lines = items.map((item) => ({
      ...(state.lines.find((line) => line.uuid === item.uuid) as ShopLine),
      quantity: item.quantity,
      attributes: item.customAttributes,
    }));
    const entity = input.purchasingEntity as { purchasingCompany?: { companyLocationId: string } } | undefined;
    if (entity?.purchasingCompany) {
      state.locationId = entity.purchasingCompany.companyLocationId.split("/").pop() as string;
    }
    state.updatedAt = "2026-10-06T15:00:05Z";
    state.total = opts.totalAfterEdit ?? state.total;
    state.ready = opts.readyAfterEdit ?? true;
  };
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "unknown";
    const call = { op, variables: body.variables };
    calls.push(call);
    const custom = opts.handle?.[op];
    if (custom) {
      return custom(call);
    }
    switch (op) {
      case "DraftForEdit":
        return Response.json({ data: { draftOrder: state.exists ? editNode() : null } });
      case "EditDraft":
        applyEdit(call.variables.input as Record<string, unknown>);
        return Response.json({ data: { draftOrderUpdate: { draftOrder: fullNode(), userErrors: [] } } });
      case "DraftOrderById":
        return Response.json({ data: { draftOrder: state.exists ? fullNode() : null } });
      case "DraftBeforeApprove":
        return Response.json({
          data: {
            draftOrder: {
              id: DRAFT_GID,
              name: "#D12",
              status: state.status,
              ready: state.ready,
              completedAt: null,
              order: null,
              totalPriceSet: { shopMoney: { amount: state.total, currencyCode: "USD" } },
            },
          },
        });
      default:
        throw new Error("unexpected Shopify request: " + op);
    }
  }) as typeof fetch;
  return { impl, calls, state, applyEdit, ops: () => calls.map((call) => call.op) };
}

async function setup(opts: { scopes?: string[]; deleted?: boolean } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedDraftStatuses(db, WS);
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes: opts.scopes ?? SCOPES,
  });
  await seedDraft(db, WS, { id: "d1", draftId: "12", name: "#D12", draftDeletedAt: opts.deleted ? NOW - 5000 : null });
  await seedLocation(db, WS, { shopifyLocationId: "101", name: "Buford HQ", address: address("Buford", "30518", "100 Example Way") });
  await seedLocation(db, WS, { shopifyLocationId: "102", name: "Mableton", address: address("Mableton", "30126", "5 Example Rd") });
  await seedLocation(db, WS, { shopifyLocationId: "103", name: "Other Co Yard", companyId: "8", address: address("Athens", "30601", "9 Example Ln") });
  await seedLocation(db, WS, { shopifyLocationId: "104", name: "Closed Yard", active: false, address: address("Athens", "30601", "1 Example Ct") });
  await seedLocation(db, WS, { shopifyLocationId: "105", name: "No Address" });
  return db;
}

const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const deps = (impl: typeof fetch): ReviewDeps => ({ env, fetchImpl: impl, now: () => NOW, sleep: async () => undefined });
const ctx = (role: "manager" | "staff" | "platform" = "manager", orderId = "d1") => ({ workspaceId: WS, orderId, userId: MANAGER, role });
const body = (overrides: Record<string, unknown> = {}) => ({ updatedAt: UPDATED, lines: [{ uuid: "u-1", quantity: 1 }], locationId: "102", ...overrides });

async function card(db: Db) {
  return (await db.select().from(schema.orders).where(eq(schema.orders.id, "d1")))[0];
}

function timeline(db: Db) {
  return db.select().from(schema.events).where(eq(schema.events.orderId, "d1"));
}

const timeout = (): Response => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

describe("loadRequestEditor", () => {
  it("reads the draft fresh and lists the company's active locations that have an address", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await loadRequestEditor(db, ctx(), deps(shop.impl))).toEqual({
      kind: "editor",
      editor: {
        updatedAt: UPDATED,
        lines: [
          { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 2 },
          { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
        ],
        locationId: "101",
        locationName: "Buford HQ",
        locations: [
          { shopifyLocationId: "101", name: "Buford HQ", address: "100 Example Way, Buford GA 30518, US" },
          { shopifyLocationId: "102", name: "Mableton", address: "5 Example Rd, Mableton GA 30126, US" },
        ],
      },
    });
    expect(shop.ops()).toEqual(["DraftForEdit"]);
  });

  it("is for managers, on requests Shopify still has, with the scopes it needs", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await loadRequestEditor(db, ctx("staff"), deps(shop.impl))).toEqual({ kind: "forbidden", error: EDIT_REFUSALS.forbidden });
    expect(await loadRequestEditor(db, ctx("manager", "nope"), deps(shop.impl))).toEqual({ kind: "not-found" });
    await seedOrder(db, WS, { id: "o1", name: "#1234" });
    expect(await loadRequestEditor(db, ctx("manager", "o1"), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "This request is already order #1234, so it cannot be edited.",
    });
    expect(await loadRequestEditor(await setup({ deleted: true }), ctx(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: REVIEW_COPY.deleted,
    });
    expect(await loadRequestEditor(await setup({ scopes: ["read_orders", "read_products"] }), ctx(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: REVIEW_COPY.draftsOff,
    });
    expect(await loadRequestEditor(await setup({ scopes: ["read_orders", "write_draft_orders"] }), ctx(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: EDIT_REFUSALS.products,
    });
    expect(shop.calls).toEqual([]);
  });

  it("refuses drafts it cannot keep exactly, and follows Shopify's state", async () => {
    const db = await setup();
    const cases: Array<[Partial<ShopDraft>, string]> = [
      [{ more: true }, EDIT_REFUSALS.tooMany],
      [{ lines: [{ ...LINES[0], custom: true, variantId: null }] }, EDIT_REFUSALS.custom],
      [{ lines: [{ ...LINES[0], priced: true }] }, EDIT_REFUSALS.priced],
      [{ lines: [{ ...LINES[0], bundle: true }] }, EDIT_REFUSALS.bundle],
      [{ lines: [{ ...LINES[0], variantId: null }] }, EDIT_REFUSALS.noVariant],
      [{ status: "COMPLETED" }, EDIT_REFUSALS.completed],
      [{ status: "WHATEVER" }, REVIEW_COPY.unknownState],
    ];
    for (const [initial, error] of cases) {
      expect(await loadRequestEditor(db, ctx(), deps(fakeShop(initial).impl)), error).toEqual({ kind: "refused", status: 409, error });
    }
  });

  it("marks the card deleted when Shopify no longer has the draft", async () => {
    const db = await setup();
    expect(await loadRequestEditor(db, ctx(), deps(fakeShop({ exists: false }).impl))).toMatchObject({
      kind: "refused",
      status: 409,
      error: REVIEW_COPY.deleted,
      deleted: { orderId: "d1" },
    });
    expect((await card(db)).draftDeletedAt).toBe(NOW);
  });
});

describe("editRequest", () => {
  it("sends the complete line list once, every attribute kept, with the new location and its address", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await editRequest(db, ctx(), body(), deps(shop.impl))).toMatchObject({
      kind: "edited",
      warning: null,
      event: {
        type: "draft_edited",
        text: "Edited the request: Hard Hat (White): quantity 2 to 1; Removed Safety Vest (L); Ship to Mableton instead of Buford HQ",
        actorId: MANAGER,
        source: "app",
      },
    });
    expect(shop.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftBeforeApprove"]);
    expect(shop.calls[1].variables).toEqual({
      id: DRAFT_GID,
      input: {
        lineItems: [{ uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 1, customAttributes: LINES[0].attributes }],
        purchasingEntity: {
          purchasingCompany: {
            companyId: "gid://shopify/Company/7",
            companyContactId: "gid://shopify/CompanyContact/31",
            companyLocationId: "gid://shopify/CompanyLocation/102",
          },
        },
        shippingAddress: {
          address1: "5 Example Rd",
          city: "Mableton",
          company: "Example Rentals",
          countryCode: "US",
          provinceCode: "GA",
          zip: "30126",
          firstName: "Casey",
          lastName: "Lin",
        },
      },
    });
    const row = await card(db);
    expect(row.locationId).toBe("102");
    expect((row.shopify as { items: { qty: number }[] }).items.map((item) => item.qty)).toEqual([1]);
    const entries = await timeline(db);
    expect(entries.map((event) => [event.type, event.actorId])).toEqual([["draft_edited", MANAGER]]);
    expect(entries[0].meta).toMatchObject({
      changes: ["Hard Hat (White): quantity 2 to 1", "Removed Safety Vest (L)", "Ship to Mableton instead of Buford HQ"],
    });
  });

  it("keeps the location for a quantity change, and sends only the lines for a customer's own draft", async () => {
    const db = await setup();
    const b2b = fakeShop();
    expect((await editRequest(db, ctx(), body({ locationId: null }), deps(b2b.impl))).kind).toBe("edited");
    expect(b2b.calls[1].variables.input).toEqual({
      lineItems: [{ uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 1, customAttributes: LINES[0].attributes }],
      purchasingEntity: {
        purchasingCompany: {
          companyId: "gid://shopify/Company/7",
          companyContactId: "gid://shopify/CompanyContact/31",
          companyLocationId: "gid://shopify/CompanyLocation/101",
        },
      },
    });
    const other = await setup();
    const plain = fakeShop({ b2b: false });
    const both = [
      { uuid: "u-1", quantity: 3 },
      { uuid: "u-2", quantity: 1 },
    ];
    expect((await editRequest(other, ctx(), body({ locationId: null, lines: both }), deps(plain.impl))).kind).toBe("edited");
    expect(plain.calls[1].variables.input).toEqual({
      lineItems: [
        { uuid: "u-1", variantId: "gid://shopify/ProductVariant/501", quantity: 3, customAttributes: LINES[0].attributes },
        { uuid: "u-2", variantId: "gid://shopify/ProductVariant/502", quantity: 1, customAttributes: [] },
      ],
    });
  });

  it("refuses a save when the draft changed since the editor opened, handing back the fresh editor", async () => {
    const db = await setup();
    const shop = fakeShop({ updatedAt: "2026-10-06T14:30:00Z" });
    expect(await editRequest(db, ctx(), body(), deps(shop.impl))).toMatchObject({
      kind: "refused",
      status: 409,
      error: EDIT_REFUSALS.stale,
      editor: { updatedAt: "2026-10-06T14:30:00Z" },
    });
    expect(shop.ops()).toEqual(["DraftForEdit"]);
  });

  it("refuses lines that are gone and locations the company cannot ship to", async () => {
    const db = await setup();
    const cases: Array<[Record<string, unknown>, Partial<ShopDraft>, string]> = [
      [{ lines: [{ uuid: "u-9", quantity: 1 }] }, {}, EDIT_REFUSALS.unknownLine],
      [{ locationId: "103" }, {}, EDIT_REFUSALS.location],
      [{ locationId: "104" }, {}, EDIT_REFUSALS.location],
      [{ locationId: "999" }, {}, EDIT_REFUSALS.location],
      [{ locationId: "105" }, {}, "Shopify has no shipping address for No Address. Add one to that location in Shopify, then try again."],
      [{ locationId: "102" }, { contact: false }, EDIT_REFUSALS.noContact],
      [{ locationId: "102" }, { b2b: false }, EDIT_REFUSALS.location],
    ];
    for (const [overrides, initial, error] of cases) {
      const shop = fakeShop(initial);
      expect(await editRequest(db, ctx(), body(overrides), deps(shop.impl)), error).toMatchObject({ kind: "refused", status: 409, error });
      expect(shop.ops()).toEqual(["DraftForEdit"]);
    }
  });

  it("answers unchanged when nothing changed, sending nothing", async () => {
    const db = await setup();
    const shop = fakeShop();
    const same = [
      { uuid: "u-1", quantity: 2 },
      { uuid: "u-2", quantity: 1 },
    ];
    expect(await editRequest(db, ctx(), body({ lines: same, locationId: "101" }), deps(shop.impl))).toEqual({ kind: "unchanged" });
    expect(shop.ops()).toEqual(["DraftForEdit"]);
  });

  it("checks the body and the role before asking Shopify", async () => {
    const db = await setup();
    const shop = fakeShop();
    expect(await editRequest(db, ctx(), body({ lines: [] }), deps(shop.impl))).toEqual({ kind: "invalid", error: EDIT_COPY.keepOne });
    expect(await editRequest(db, ctx("staff"), body(), deps(shop.impl))).toEqual({ kind: "forbidden", error: EDIT_REFUSALS.forbidden });
    expect(shop.calls).toEqual([]);
  });

  it("changes nothing when Shopify refuses", async () => {
    const db = await setup();
    const before = await card(db);
    const shop = fakeShop(
      {},
      {
        handle: {
          EditDraft: () =>
            Response.json({ data: { draftOrderUpdate: { draftOrder: null, userErrors: [{ field: ["lineItems"], message: "Quantity is invalid." }] } } }),
        },
      },
    );
    expect(await editRequest(db, ctx(), body(), deps(shop.impl))).toEqual({
      kind: "refused",
      status: 409,
      error: "Shopify did not save the changes: Quantity is invalid. Nothing changed.",
    });
    expect(await card(db)).toEqual(before);
    expect(await timeline(db)).toEqual([]);
  });

  it("reads after a timeout and never sends the edit twice", async () => {
    const db = await setup();
    const landed = fakeShop(
      {},
      {
        handle: {
          EditDraft: (call) => {
            landed.applyEdit(call.variables.input as Record<string, unknown>);
            return timeout();
          },
        },
      },
    );
    expect(await editRequest(db, ctx(), body(), deps(landed.impl))).toMatchObject({ kind: "edited" });
    expect(landed.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftForEdit", "DraftOrderById", "DraftBeforeApprove"]);
    expect((await card(db)).locationId).toBe("102");

    const other = await setup();
    const lost = fakeShop({}, { handle: { EditDraft: timeout } });
    expect(await editRequest(other, ctx(), body(), deps(lost.impl))).toEqual({
      kind: "refused",
      status: 502,
      error: EDIT_REFUSALS.noAnswerUnchanged,
    });
    expect(lost.ops()).toEqual(["DraftForEdit", "EditDraft", "DraftForEdit"]);
    expect(await timeline(other)).toEqual([]);
  });

  it("warns when Shopify totals the edited request above $0.00, or is still calculating it", async () => {
    const db = await setup();
    const priced = fakeShop({}, { totalAfterEdit: "12.00" });
    expect(await editRequest(db, ctx(), body(), deps(priced.impl))).toMatchObject({
      kind: "edited",
      warning: "Shopify now totals this request at $12.00. Approve needs $0.00, so complete it in Shopify or edit it again.",
    });
    const other = await setup();
    const busy = fakeShop({}, { readyAfterEdit: false });
    expect(await editRequest(other, ctx(), body(), deps(busy.impl))).toMatchObject({ kind: "edited", warning: EDIT_REFUSALS.calculating });
    expect(busy.ops().filter((op) => op === "DraftBeforeApprove")).toHaveLength(1 + REVIEW_READY_TRIES);
  });
});
```

**Step 2: Run it**

Run: `npx vitest run src/server/desk/edit-request.test.ts`
Expected: FAIL, `Failed to resolve import "./edit-request"`.

**Step 3: Minimal implementation** (`src/server/desk/edit-request.ts`)

```ts
// Edit a request before approval (comprehensive design section 2), behind
// GET and POST /api/orders/[orderId]/edit. Managers and platform admins
// only (the routes answer 403 to staff, like Approve and Reject). Drafts
// only: change a line's quantity (1 to 999), remove lines (one stays), and
// move the ship-to to another active location of the same company.
//
// GET reads the draft fresh from Shopify (never the stored snapshot, whose
// attribute values are capped) and returns the editor: the lines with
// their Shopify line uuid, the draft's updatedAt and the company's active
// locations. POST repeats the read and refuses when updatedAt moved (the
// fresh editor comes back), then sends draftOrderUpdate ONCE with the
// complete line list (uuid, variant, quantity, every custom attribute
// exactly as read), the purchasing entity's company location, and for a new
// location its shipping address. Nothing else on the draft is sent, so tags,
// notes, cart attributes and the order discount stay as they are. A refusal
// changes nothing; a timeout or transport failure is followed by a read,
// never a resend. The updated draft is written onto the card through the
// sync's own writer, a draft_edited entry names the actor and the changes,
// and a total above $0 afterwards comes back as a warning (Approve needs
// $0).

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, orders, storeConnections } from "@/db/schema";
import { addressBlock, oneLineAddress, type LocationAddress } from "@/lib/address";
import { formatMoney } from "@/lib/format";
import { roleAtLeast } from "@/lib/roles";
import {
  EDIT_LINES_MAX,
  editLanded,
  parseEditBody,
  summarizeEdit,
  type EditRequestBody,
  type RequestEditor,
} from "@/lib/request-edit";
import { broadcast, broadcastSync } from "@/server/broadcast";
import {
  draftGid,
  draftsEnabled,
  failureText,
  fetchDraftForApprove,
  fetchDraftForEdit,
  fetchDraftNode,
  productsEnabled,
  updateDraftOrder,
  type DraftForEdit,
} from "@/server/shopify/admin";
import { shareShopifyMoves } from "@/server/shopify/fanout";
import { companyLocationGid } from "@/server/shopify/locations";
import { normalizeDrafts } from "@/server/shopify/normalize";
import { safeErrorReason, type StatusChange } from "@/server/shopify/status-sync";
import { markDraftDeleted, upsertFetchedDraft } from "@/server/sync/drafts";
import { getLocation, listLocations, type LocationView } from "@/server/sync/locations";
import {
  actorNameOf,
  REVIEW_COPY,
  REVIEW_READY_TRIES,
  REVIEW_RETRY_MS,
  shopifyAccess,
  type Access,
  type ReviewContext,
  type ReviewDeps,
} from "./review";
import { eventView, type EventView } from "./shapes";

export const EDIT_REFUSALS = {
  forbidden: "Only a manager can edit requests.",
  alreadyOrder: (name: string) => `This request is already order ${name}, so it cannot be edited.`,
  products:
    "Editing requests needs the read_products permission on the store's Shopify app. A platform admin can add it, then press Refresh connection in Settings.",
  completed: "This request was already completed in Shopify. The card updates on the next sync.",
  tooMany: `This request has more than ${EDIT_LINES_MAX} items. Edit it in Shopify.`,
  custom: "This request has a custom item, which Ordering Desk cannot keep exactly. Edit it in Shopify.",
  priced: "An item on this request has its own price or discount, which Ordering Desk cannot keep exactly. Edit it in Shopify.",
  bundle: "This request has a bundle, which Ordering Desk cannot edit. Edit it in Shopify.",
  noVariant: "An item on this request is no longer in the catalog, so Shopify would drop it. Edit it in Shopify.",
  stale:
    "This request changed in Shopify since you opened the editor. The editor now shows the latest version. Make your changes again.",
  unknownLine: "An item you edited is no longer on this request. The editor now shows the latest version.",
  location: "Pick one of the company's locations. The list was refreshed.",
  noContact: "Shopify has no company contact on this request, so its location cannot change. Quantities can still change.",
  noAddress: (name: string) => `Shopify has no shipping address for ${name}. Add one to that location in Shopify, then try again.`,
  noAnswerUnchanged: "Shopify did not answer. Nothing changed. Try again.",
  noAnswer: "Shopify did not answer. Check the request in Shopify before editing it again. The card updates on the next sync.",
  calculating: "Shopify is still calculating the new total. Approve checks it again before it creates the order.",
} as const;

type Refused = {
  kind: "refused";
  status: 409 | 502;
  error: string;
  // The fresh editor, when the refusal comes with one (stale, gone lines,
  // a location the list no longer offers).
  editor?: RequestEditor;
  // The card was just marked deleted (the route shares it).
  deleted?: { orderId: string; event: EventView };
};

export type EditorResult = { kind: "not-found" } | { kind: "forbidden"; error: string } | Refused | { kind: "editor"; editor: RequestEditor };

export type EditResult =
  | { kind: "invalid"; error: string }
  | { kind: "not-found" }
  | { kind: "forbidden"; error: string }
  | Refused
  | { kind: "unchanged" }
  | { kind: "edited"; event: EventView; warning: string | null; statusChanges: StatusChange[] };

type Card = { id: string; name: string; shopifyDraftId: string };

const EDITABLE_STATES = new Set(["OPEN", "INVOICE_SENT"]);
const EVENT_TEXT_MAX = 1000;

function refused(status: 409 | 502, error: string, extra: Partial<Refused> = {}): Refused {
  return { kind: "refused", status, error, ...extra };
}

function sentence(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

// Everything checked before Shopify: the card, the role, the grant.
async function editableCard(db: Db, ctx: ReviewContext): Promise<{ kind: "ok"; card: Card } | Exclude<EditorResult, { kind: "editor" }>> {
  const rows = await db
    .select({
      id: orders.id,
      shopifyOrderId: orders.shopifyOrderId,
      shopifyDraftId: orders.shopifyDraftId,
      name: orders.name,
      draftDeletedAt: orders.draftDeletedAt,
    })
    .from(orders)
    .where(and(eq(orders.id, ctx.orderId), eq(orders.workspaceId, ctx.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { kind: "not-found" };
  }
  if (!roleAtLeast(ctx.role, "manager")) {
    return { kind: "forbidden", error: EDIT_REFUSALS.forbidden };
  }
  if (row.shopifyOrderId !== null) {
    return refused(409, EDIT_REFUSALS.alreadyOrder(row.name));
  }
  if (row.draftDeletedAt !== null || row.shopifyDraftId === null) {
    return refused(409, REVIEW_COPY.deleted);
  }
  const grant = await db
    .select({ scopes: storeConnections.scopes })
    .from(storeConnections)
    .where(eq(storeConnections.workspaceId, ctx.workspaceId))
    .limit(1);
  const scopes = grant[0]?.scopes;
  if (!draftsEnabled(scopes)) {
    return refused(409, REVIEW_COPY.draftsOff);
  }
  if (!productsEnabled(scopes)) {
    return refused(409, EDIT_REFUSALS.products);
  }
  return { kind: "ok", card: { id: row.id, name: row.name, shopifyDraftId: row.shopifyDraftId } };
}

function editRefusal(draft: DraftForEdit): string | null {
  if (!draft.complete) {
    return EDIT_REFUSALS.tooMany;
  }
  if (draft.lines.some((line) => line.custom)) {
    return EDIT_REFUSALS.custom;
  }
  if (draft.lines.some((line) => line.priced)) {
    return EDIT_REFUSALS.priced;
  }
  if (draft.lines.some((line) => line.bundle)) {
    return EDIT_REFUSALS.bundle;
  }
  if (draft.lines.some((line) => line.variantId === null)) {
    return EDIT_REFUSALS.noVariant;
  }
  return null;
}

// The draft read fresh, with every refusal a read can give.
async function readDraft(
  db: Db,
  ctx: ReviewContext,
  card: Card,
  access: Access,
  clock: () => number,
): Promise<{ kind: "ok"; draft: DraftForEdit } | Refused> {
  const read = await fetchDraftForEdit(access.shopDomain, access.token, draftGid(card.shopifyDraftId), access.fetchImpl);
  if (read.kind !== "ok") {
    return refused(502, `Could not read the request in Shopify (${sentence(failureText(read))}). Nothing changed. Try again.`);
  }
  if (read.draft === null) {
    const marked = await markDraftDeleted(db, ctx.workspaceId, card.shopifyDraftId, clock());
    return refused(409, REVIEW_COPY.deleted, marked.kind === "deleted" ? { deleted: { orderId: marked.orderId, event: marked.event } } : {});
  }
  if (read.draft.status === "COMPLETED") {
    return refused(409, EDIT_REFUSALS.completed);
  }
  if (!EDITABLE_STATES.has(read.draft.status)) {
    return refused(409, REVIEW_COPY.unknownState);
  }
  const refusal = editRefusal(read.draft);
  return refusal ? refused(409, refusal) : { kind: "ok", draft: read.draft };
}

async function editorFor(db: Db, workspaceId: string, draft: DraftForEdit): Promise<RequestEditor> {
  const company = draft.company;
  const movable = company !== null && company.contactGid !== null;
  const rows = movable ? await listLocations(db, workspaceId, { companyId: company.companyId, activeOnly: true }) : [];
  const options = rows
    .filter((row) => row.address !== null)
    .map((row) => ({
      shopifyLocationId: row.shopifyLocationId,
      name: row.name,
      address: oneLineAddress(addressBlock({ locationName: row.name, locationAddress: row.address })),
    }));
  if (movable && !options.some((option) => option.shopifyLocationId === company.locationId)) {
    options.unshift({ shopifyLocationId: company.locationId, name: company.locationName || `Location ${company.locationId}`, address: "" });
  }
  return {
    updatedAt: draft.updatedAt,
    lines: draft.lines.map((line) => ({
      uuid: line.uuid,
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      propertyCount: line.attributes.filter((attribute) => !attribute.key.startsWith("_")).length,
    })),
    locationId: company?.locationId ?? null,
    locationName: company?.locationName ?? "",
    locations: options,
  };
}

export async function loadRequestEditor(db: Db, ctx: ReviewContext, deps: ReviewDeps): Promise<EditorResult> {
  const clock = deps.now ?? Date.now;
  const checked = await editableCard(db, ctx);
  if (checked.kind !== "ok") {
    return checked;
  }
  const granted = await shopifyAccess(db, ctx.workspaceId, deps);
  if (granted.kind !== "ok") {
    return granted;
  }
  const fresh = await readDraft(db, ctx, checked.card, granted.access, clock);
  if (fresh.kind !== "ok") {
    return fresh;
  }
  return { kind: "editor", editor: await editorFor(db, ctx.workspaceId, fresh.draft) };
}

// Shopify's mailing address input from the location's synced address, with
// the current recipient's name (the employee the box is for).
function mailingAddress(address: LocationAddress, recipient: DraftForEdit["recipient"]): Record<string, string> {
  const fields: Record<string, string> = {
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    company: address.company,
    countryCode: address.countryCode,
    provinceCode: address.provinceCode,
    zip: address.zip,
    phone: address.phone,
    firstName: recipient?.firstName ?? "",
    lastName: recipient?.lastName ?? "",
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim().length > 0));
}

function draftInput(draft: DraftForEdit, body: EditRequestBody, location: LocationView | null): Record<string, unknown> {
  const quantities = new Map(body.lines.map((line) => [line.uuid, line.quantity]));
  const input: Record<string, unknown> = {
    lineItems: draft.lines
      .filter((line) => quantities.has(line.uuid))
      .map((line) => ({
        uuid: line.uuid,
        variantId: line.variantId,
        quantity: quantities.get(line.uuid),
        customAttributes: line.attributes.map((attribute) => ({ key: attribute.key, value: attribute.value })),
      })),
  };
  const company = draft.company;
  if (company && company.contactGid) {
    input.purchasingEntity = {
      purchasingCompany: {
        companyId: company.companyGid,
        companyContactId: company.contactGid,
        companyLocationId: location ? companyLocationGid(location.shopifyLocationId) : company.locationGid,
      },
    };
  }
  if (location?.address) {
    input.shippingAddress = mailingAddress(location.address, draft.recipient);
  }
  return input;
}

// Approve needs $0: Shopify's total once it finished calculating.
async function totalWarning(access: Access, gid: string, deps: ReviewDeps): Promise<string | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt <= REVIEW_READY_TRIES; attempt++) {
    const read = await fetchDraftForApprove(access.shopDomain, access.token, gid, access.fetchImpl);
    if (read.kind !== "ok" || read.draft === null) {
      return null;
    }
    if (read.draft.ready) {
      const total = read.draft.total;
      if (total !== null && total.trim().length > 0 && Number(total) === 0) {
        return null;
      }
      const amount = total !== null && total.trim().length > 0 ? formatMoney(total, read.draft.currency) : "an amount Shopify did not report";
      return `Shopify now totals this request at ${amount}. Approve needs $0.00, so complete it in Shopify or edit it again.`;
    }
    if (attempt < REVIEW_READY_TRIES) {
      await sleep(REVIEW_RETRY_MS);
    }
  }
  return EDIT_REFUSALS.calculating;
}

export async function editRequest(db: Db, ctx: ReviewContext, body: unknown, deps: ReviewDeps): Promise<EditResult> {
  const clock = deps.now ?? Date.now;
  const parsed = parseEditBody(body);
  if ("error" in parsed) {
    return { kind: "invalid", error: parsed.error };
  }
  const checked = await editableCard(db, ctx);
  if (checked.kind !== "ok") {
    return checked;
  }
  const { card } = checked;
  const granted = await shopifyAccess(db, ctx.workspaceId, deps);
  if (granted.kind !== "ok") {
    return granted;
  }
  const { access } = granted;
  const gid = draftGid(card.shopifyDraftId);
  const fresh = await readDraft(db, ctx, card, access, clock);
  if (fresh.kind !== "ok") {
    return fresh;
  }
  const draft = fresh.draft;
  const editor = await editorFor(db, ctx.workspaceId, draft);
  if (draft.updatedAt !== parsed.updatedAt) {
    return refused(409, EDIT_REFUSALS.stale, { editor });
  }
  const onDraft = new Set(draft.lines.map((line) => line.uuid));
  if (parsed.lines.some((line) => !onDraft.has(line.uuid))) {
    return refused(409, EDIT_REFUSALS.unknownLine, { editor });
  }

  let location: LocationView | null = null;
  if (parsed.locationId !== null && parsed.locationId !== (draft.company?.locationId ?? null)) {
    if (!draft.company) {
      return refused(409, EDIT_REFUSALS.location, { editor });
    }
    if (!draft.company.contactGid) {
      return refused(409, EDIT_REFUSALS.noContact, { editor });
    }
    const row = await getLocation(db, ctx.workspaceId, parsed.locationId);
    if (!row || !row.active || row.companyId !== draft.company.companyId) {
      return refused(409, EDIT_REFUSALS.location, { editor });
    }
    if (!row.address) {
      return refused(409, EDIT_REFUSALS.noAddress(row.name), { editor });
    }
    location = row;
  }

  const summary = summarizeEdit(editor, parsed);
  if (summary.changes.length === 0) {
    return { kind: "unchanged" };
  }

  // Taken before Shopify answers, like a sync run's now (the claim rule).
  const now = clock();
  const sent = await updateDraftOrder(access.shopDomain, access.token, gid, draftInput(draft, parsed, location), access.fetchImpl);
  let node: Record<string, unknown> | null = null;
  if (sent.kind === "ok") {
    node = sent.node;
  } else if (sent.kind === "refused") {
    return refused(409, `Shopify did not save the changes: ${sentence(sent.detail)}. Nothing changed.`);
  } else {
    // A timeout or transport failure: read, never send again.
    const after = await fetchDraftForEdit(access.shopDomain, access.token, gid, access.fetchImpl);
    if (after.kind !== "ok" || after.draft === null) {
      return refused(502, EDIT_REFUSALS.noAnswer);
    }
    const current = { lines: after.draft.lines, locationId: after.draft.company?.locationId ?? null };
    if (!editLanded(current, parsed)) {
      return refused(502, after.draft.updatedAt === parsed.updatedAt ? EDIT_REFUSALS.noAnswerUnchanged : EDIT_REFUSALS.noAnswer);
    }
    const full = await fetchDraftNode(access.shopDomain, access.token, gid, access.fetchImpl);
    node = full.kind === "ok" ? full.node : null;
  }

  let statusChanges: StatusChange[] = [];
  const [updated] = node ? normalizeDrafts([node]) : [];
  if (updated) {
    const written = await upsertFetchedDraft(db, ctx.workspaceId, updated, now);
    if (written.kind === "updated" || written.kind === "attached") {
      statusChanges = written.statusChanges;
    }
  }
  const event = {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    orderId: card.id,
    type: "draft_edited" as const,
    text: `Edited the request: ${summary.changes.join("; ")}`.slice(0, EVENT_TEXT_MAX),
    actorId: ctx.userId,
    meta: { changes: summary.changes, before: summary.before, after: summary.after },
    createdAt: now,
    source: "app" as const,
  };
  await db.insert(events).values(event);
  const actorName = await actorNameOf(db, ctx.userId);
  const warning = await totalWarning(access, gid, deps);
  return { kind: "edited", event: { ...eventView(event), actorName }, warning, statusChanges };
}

// After the response: open desks reload the card and hear the entry; a
// status move Shopify reported meanwhile is shared. Never throws.
export async function followEdit(
  db: Db,
  env: CloudflareEnv,
  workspaceId: string,
  orderId: string,
  result: Extract<EditResult, { kind: "edited" }>,
  deps: Omit<ReviewDeps, "env">,
): Promise<void> {
  try {
    await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [orderId] });
    await broadcast(env, workspaceId, { kind: "order.activity", event: result.event });
    await shareShopifyMoves(db, env, workspaceId, result.statusChanges, { fetchImpl: deps.fetchImpl, now: deps.now });
  } catch (e) {
    console.warn("[edit] " + JSON.stringify({ workspaceId, orderId, follow: safeErrorReason(e) }));
  }
}
```

**Step 4: Run it**

Run: `npx vitest run src/server/desk/edit-request.test.ts`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add src/server/desk/edit-request.ts src/server/desk/edit-request.test.ts
git commit -m "feat: managers edit requests through draftOrderUpdate, sent once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/server/desk/edit-request.ts src/server/desk/edit-request.test.ts
```

---

### Task 23: Edit routes

**Files:**
- Create: `src/app/api/orders/[orderId]/edit/route.ts`
- Create: `src/app/api/orders/[orderId]/edit-route.test.ts`

**Step 1: Write the failing test** (`src/app/api/orders/[orderId]/edit-route.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@/db";
import { openTestDb, seedDraft, seedMember, seedUser, seedWorkspace } from "@/server/desk/test-helpers";

// The edit routes: who may call them (401 signed out, 404 for outsiders,
// 403 for staff) and what runs after the response. The service is covered
// in src/server/desk/edit-request.test.ts; here it is stood in.
type Session = { user: { id: string; email: string } } | null;
const state: { db: Db | null; session: Session; after: Promise<unknown>[] } = { db: null, session: null, after: [] };

const EDITOR = { updatedAt: "2026-10-06T14:00:00Z", lines: [], locationId: null, locationName: "", locations: [] };

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "orderingdesk.test" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { APP_URL: "https://orderingdesk.test", PLATFORM_ADMIN_EMAILS: "admin@rmh.example" },
    ctx: { waitUntil: (promise: Promise<unknown>) => state.after.push(promise) },
  }),
}));
vi.mock("@/server/auth", () => ({ getAuth: async () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("@/db", () => ({ getDb: () => state.db, getDbFromEnv: () => state.db }));
vi.mock("@/server/broadcast", () => ({ broadcast: vi.fn(async () => undefined), broadcastSync: vi.fn(async () => undefined) }));
vi.mock("@/server/notify", () => ({ notifyActivity: vi.fn(async () => ({ pushed: 0 })) }));
vi.mock("@/server/desk/edit-request", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/desk/edit-request")>();
  return {
    ...real,
    loadRequestEditor: vi.fn(async () => ({ kind: "editor", editor: EDITOR })),
    editRequest: vi.fn(async () => ({ kind: "edited", event: { id: "e1" }, warning: null, statusChanges: [] })),
    followEdit: vi.fn(async () => undefined),
  };
});

const { GET, POST } = await import("./edit/route");
const service = await import("@/server/desk/edit-request");

const context = { params: Promise.resolve({ orderId: "d1" }) };
const get = () => new Request("https://orderingdesk.test/x");
const post = (body?: unknown) =>
  new Request("https://orderingdesk.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const STAFF: Session = { user: { id: "u_staff", email: "staff@example.com" } };
const MANAGER: Session = { user: { id: "u_manager", email: "manager@example.com" } };
const ADMIN: Session = { user: { id: "u_admin", email: "admin@rmh.example" } };
const STRANGER: Session = { user: { id: "u_stranger", email: "stranger@example.com" } };

beforeEach(async () => {
  const { db } = openTestDb();
  state.db = db;
  state.session = null;
  state.after = [];
  vi.mocked(service.loadRequestEditor).mockClear();
  vi.mocked(service.editRequest).mockClear();
  vi.mocked(service.followEdit).mockClear();
  await seedWorkspace(db, "ws_impact");
  await seedDraft(db, "ws_impact", { id: "d1" });
  for (const [id, email] of [
    ["u_staff", "staff@example.com"],
    ["u_manager", "manager@example.com"],
    ["u_admin", "admin@rmh.example"],
    ["u_stranger", "stranger@example.com"],
  ] as const) {
    await seedUser(db, id, email);
  }
  await seedMember(db, "ws_impact", "u_staff", "staff");
  await seedMember(db, "ws_impact", "u_manager", "manager");
});

describe("GET and POST /api/orders/[orderId]/edit", () => {
  it("answers 401 signed out, 404 to an outsider and 403 to staff, touching nothing", async () => {
    expect((await GET(get(), context)).status).toBe(401);
    expect((await POST(post({}), context)).status).toBe(401);
    state.session = STRANGER;
    expect((await GET(get(), context)).status).toBe(404);
    expect((await POST(post({}), context)).status).toBe(404);
    state.session = STAFF;
    for (const response of [await GET(get(), context), await POST(post({}), context)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only a manager can edit requests." });
    }
    expect(service.loadRequestEditor).not.toHaveBeenCalled();
    expect(service.editRequest).not.toHaveBeenCalled();
  });

  it("hands a manager and a platform admin the editor", async () => {
    for (const [session, role] of [
      [MANAGER, "manager"],
      [ADMIN, "platform"],
    ] as const) {
      state.session = session;
      const response = await GET(get(), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ editor: EDITOR });
      expect(vi.mocked(service.loadRequestEditor).mock.lastCall?.[1]).toEqual({
        workspaceId: "ws_impact",
        orderId: "d1",
        userId: session!.user.id,
        role,
      });
    }
  });

  it("saves an edit and follows up after the response", async () => {
    state.session = MANAGER;
    const response = await POST(post({ updatedAt: "2026-10-06T14:00:00Z", lines: [], locationId: null }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "edited", event: { id: "e1" }, warning: null });
    expect(vi.mocked(service.editRequest).mock.lastCall?.[2]).toEqual({ updatedAt: "2026-10-06T14:00:00Z", lines: [], locationId: null });
    await Promise.all(state.after);
    expect(service.followEdit).toHaveBeenCalled();
  });

  it("passes refusals through with their status and the fresh editor", async () => {
    state.session = MANAGER;
    vi.mocked(service.editRequest).mockResolvedValueOnce({ kind: "refused", status: 409, error: "This request changed.", editor: EDITOR });
    const stale = await POST(post({}), context);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "This request changed.", editor: EDITOR });
    vi.mocked(service.editRequest).mockResolvedValueOnce({ kind: "invalid", error: "Bad." });
    expect((await POST(post({}), context)).status).toBe(400);
    vi.mocked(service.editRequest).mockResolvedValueOnce({ kind: "unchanged" });
    expect(await (await POST(post({}), context)).json()).toEqual({ kind: "unchanged" });
    vi.mocked(service.loadRequestEditor).mockResolvedValueOnce({ kind: "refused", status: 502, error: "Shopify did not answer." });
    expect((await GET(get(), context)).status).toBe(502);
    expect(service.followEdit).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run it**

Run: `npx vitest run "src/app/api/orders/[orderId]/edit-route.test.ts"`
Expected: FAIL, `Failed to resolve import "./edit/route"`.

**Step 3: Minimal implementation** (`src/app/api/orders/[orderId]/edit/route.ts`)

```ts
import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Db } from "@/db";
import { broadcast, broadcastSync } from "@/server/broadcast";
import { EDIT_REFUSALS, editRequest, followEdit, loadRequestEditor } from "@/server/desk/edit-request";
import type { EventView } from "@/server/desk/shapes";
import { guardResponse, requireMemberByOrder, roleAtLeast } from "@/server/guard";
import { notifyActivity } from "@/server/notify";

type RouteContext = { params: Promise<{ orderId: string }> };

// A draft Shopify deleted: open desks show the card as deleted.
function shareDeleted(db: Db, env: CloudflareEnv, workspaceId: string, deleted: { orderId: string; event: EventView }) {
  return (async () => {
    await broadcastSync(env, workspaceId, { addedOrderIds: [], updatedOrderIds: [deleted.orderId] });
    await broadcast(env, workspaceId, { kind: "order.activity", event: deleted.event });
    await notifyActivity(db, env, workspaceId, deleted.event);
  })();
}

// The request editor (comprehensive design section 2;
// src/server/desk/edit-request.ts): the draft read fresh from Shopify.
// Managers and platform admins: 404 for outsiders, 403 for staff. 200
// {editor}; 409 or 502 {error} when it cannot be edited now.
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: EDIT_REFUSALS.forbidden }, { status: 403 });
    }
    const { env, ctx } = getCloudflareContext();
    const result = await loadRequestEditor(db, { workspaceId, orderId, userId, role }, { env });
    switch (result.kind) {
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused":
        if (result.deleted) {
          ctx.waitUntil(shareDeleted(db, env, workspaceId, result.deleted));
        }
        return NextResponse.json({ error: result.error }, { status: result.status });
      case "editor":
        return NextResponse.json({ editor: result.editor });
    }
  } catch (e) {
    return guardResponse(e);
  }
}

// Save an edit. Body {updatedAt, lines: [{uuid, quantity}], locationId}
// (src/lib/request-edit.ts). 200 {kind: "edited", event, warning}, 200
// {kind: "unchanged"}; 400 {error}; 409 {error, editor?} (editor: the fresh
// one, when the request changed meanwhile); 502 {error}. Shopify gets the
// update once; nothing changed unless the answer says so.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    const { db, userId, workspaceId, role } = await requireMemberByOrder(orderId, "staff");
    if (!roleAtLeast(role, "manager")) {
      return NextResponse.json({ error: EDIT_REFUSALS.forbidden }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as unknown;
    const { env, ctx } = getCloudflareContext();
    const result = await editRequest(db, { workspaceId, orderId, userId, role }, body, { env });
    switch (result.kind) {
      case "invalid":
        return NextResponse.json({ error: result.error }, { status: 400 });
      case "not-found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: result.error }, { status: 403 });
      case "refused":
        if (result.deleted) {
          ctx.waitUntil(shareDeleted(db, env, workspaceId, result.deleted));
        }
        return NextResponse.json(
          { error: result.error, ...(result.editor ? { editor: result.editor } : {}) },
          { status: result.status },
        );
      case "unchanged":
        return NextResponse.json({ kind: result.kind });
      case "edited":
        ctx.waitUntil(followEdit(db, env, workspaceId, orderId, result, {}));
        return NextResponse.json({ kind: result.kind, event: result.event, warning: result.warning });
    }
  } catch (e) {
    return guardResponse(e);
  }
}
```

**Step 4: Run it**

Run: `npx vitest run "src/app/api/orders/[orderId]/edit-route.test.ts"`
Expected: PASS.

**Step 5: Commit**

Gates, then:

```bash
git add "src/app/api/orders/[orderId]/edit/route.ts" "src/app/api/orders/[orderId]/edit-route.test.ts"
git commit -m "feat: GET and POST /api/orders/[orderId]/edit for managers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- "src/app/api/orders/[orderId]/edit/route.ts" "src/app/api/orders/[orderId]/edit-route.test.ts"
```

---

### Task 24: Edit in the drawer

Use @design-taste-frontend.

**Files:**
- Create: `src/components/desk/edit-request.tsx`, `src/components/desk/edit-request.test.ts`
- Modify: `src/components/desk/review-panel.tsx` (Wave 1a's version: `ReviewActionsProps` and `ReviewActions`, which hold the review modes; an Edit request mode, the content key, the save notice. `ReviewPanelProps` picks the new props up through its `Omit<ReviewActionsProps, "afterReject">`)
- Modify: `src/components/desk/order-drawer.tsx` (props `:450-504`, and the `ReviewActions` call in the drawer footer that Wave 1a's Task 19 added)
- Modify: `src/components/desk/desk.tsx` (an `editRequestAction` next to `approve`, pass it to the drawer)
- Modify: `src/components/settings/store-connection.tsx:137-140` (name `read_products` for editing)
- Test: `src/components/desk/edit-request.test.ts`, `src/components/desk/review-panel.test.ts`, `src/components/desk/order-drawer.test.ts` (props)

**Step 1: Write the failing tests**

Create `src/components/desk/edit-request.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestEditor } from "@/lib/request-edit";
import { EditRequestForm, EditReview } from "./edit-request";

// The request editor (comprehensive design section 2) as the drawer renders
// it. The server enforces every rule again.

const EDITOR: RequestEditor = {
  updatedAt: "2026-10-06T14:00:00Z",
  lines: [
    { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 2 },
    { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
  ],
  locationId: "101",
  locationName: "Buford HQ",
  locations: [
    { shopifyLocationId: "101", name: "Buford HQ", address: "100 Example Way, Buford GA 30518, US" },
    { shopifyLocationId: "102", name: "Mableton", address: "5 Example Rd, Mableton GA 30126, US" },
  ],
};

const renderForm = (editor: RequestEditor = EDITOR, notice: string | null = null) =>
  renderToStaticMarkup(
    createElement(EditRequestForm, { name: "#D12", editor, notice, onReview: () => undefined, onClose: () => undefined }),
  );

describe("EditRequestForm", () => {
  it("lists each item with its quantity and a way to remove it, and the company's locations", () => {
    const html = renderForm();
    expect(html).toContain("Edit request #D12");
    expect(html).toContain("Hard Hat (White)");
    expect(html).toContain('value="2"');
    expect(html).toContain("Personalization kept exactly (2 fields)");
    expect(html.match(/>Remove</g)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*value="101"[^>]*checked=""/);
    expect(html).toContain("5 Example Rd, Mableton GA 30126, US");
    // Nothing changed yet: nothing to review.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Review changes</);
  });

  it("keeps the last item, says why, names the one location, and shows a refresh notice", () => {
    const one = renderForm(
      { ...EDITOR, lines: [EDITOR.lines[0]], locations: [] },
      "This request changed in Shopify since you opened the editor.",
    );
    expect(one).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Remove<\/button>/);
    expect(one).toContain("A request keeps at least one item.");
    expect(one).toContain("This request changed in Shopify since you opened the editor.");
    expect(one).toContain("Ships to");
  });
});

describe("EditReview", () => {
  it("asks once more, with every change and the before and after", () => {
    const html = renderToStaticMarkup(
      createElement(EditReview, {
        name: "#D12",
        summary: {
          changes: ["Removed Safety Vest (L)"],
          before: { lines: ["2 x Hard Hat (White)", "1 x Safety Vest (L)"], shipTo: "Buford HQ" },
          after: { lines: ["2 x Hard Hat (White)"], shipTo: "Buford HQ" },
        },
        error: null,
        busy: false,
        onSave: () => undefined,
        onBack: () => undefined,
      }),
    );
    expect(html).toContain("Save these changes to request #D12 in Shopify?");
    expect(html).toContain("<li>Removed Safety Vest (L)</li>");
    expect(html).toContain(">Before<");
    expect(html).toContain(">After<");
    expect(html).toContain(">Save changes<");
  });
});
```

In `src/components/desk/review-panel.test.ts`, add to `base`:

```ts
  canEdit: true,
  editBlock: null,
  contentKey: "k1",
  editor: () => null,
```

and:

```ts
  // Comprehensive design section 2: managers edit a request before approval.
  it("offers managers Edit request, with its reason when it cannot be used", () => {
    expect(render()).toContain(">Edit request<");
    const blocked = render({ editBlock: "Shopify no longer has this draft.", approveBlock: "Shopify no longer has this draft." });
    const editButton = blocked.match(/<button[^>]*>(?:(?!<\/button>).)*Edit request<\/button>/)?.[0] ?? "";
    expect(editButton).toContain('disabled=""');
    expect(blocked.match(/Shopify no longer has this draft\./g)).toHaveLength(1);
    expect(render({ canEdit: false })).not.toContain("Edit request");
    expect(render({ canReview: false })).not.toContain("Edit request");
  });
```

**Step 2: Run them**

Run: `npx vitest run src/components/desk/edit-request.test.ts src/components/desk/review-panel.test.ts`
Expected: FAIL, `./edit-request` does not resolve and the panel has no Edit request.

**Step 3: Minimal implementation**

Create `src/components/desk/edit-request.tsx`:

```tsx
"use client";

// Edit a request before approval (comprehensive design section 2): change
// a quantity, remove lines (one stays), switch the ship-to among the
// company's locations. Opened from the review panel, so an open Approve
// confirmation closes. Two steps: the editor, then a before-and-after
// review whose Save follows the Approve step (focus on the question, a
// press within CONFIRM_ARM_MS of opening ignored). The server re-reads the
// draft and refuses when it changed since the editor opened; the editor
// then reloads with the latest version and says why.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowUUpLeftIcon } from "@phosphor-icons/react/ArrowUUpLeft";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { MinusIcon } from "@phosphor-icons/react/Minus";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import {
  EDIT_QUANTITY_MAX,
  bodyFromForm,
  lineLabel,
  summarizeEdit,
  type EditRequestBody,
  type EditSummary,
  type RequestEditor,
} from "@/lib/request-edit";
import { InlineMessage, Spinner } from "@/components/kit";
import { ui } from "@/components/ui";
import { focusSoon } from "@/components/settings/kit";
import { confirmArmed } from "./po-send-confirm";

// What a save came to: an error (with the fresh editor when the request
// changed meanwhile), or saved with an optional warning (a total above $0).
export type EditSaveOutcome = { error: string; editor?: RequestEditor } | { warning: string | null };

export function EditRequestForm({
  name,
  editor,
  notice,
  onReview,
  onClose,
}: {
  name: string;
  editor: RequestEditor;
  // Why the editor reloaded (the request changed in Shopify), or null.
  notice: string | null;
  onReview: (body: EditRequestBody, summary: EditSummary) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(editor.lines.map((line) => [line.uuid, String(line.quantity)])),
  );
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [locationId, setLocationId] = useState<string | null>(editor.locationId);
  const [error, setError] = useState<string | null>(null);
  const kept = editor.lines.filter((line) => !removed.has(line.uuid)).length;
  const parsed = bodyFromForm(editor, { quantities, removed, locationId });
  const summary = "error" in parsed ? null : summarizeEdit(editor, parsed);

  function step(uuid: string, delta: number) {
    setQuantities((current) => {
      const value = Number(current[uuid]);
      const next = Number.isInteger(value) ? Math.min(EDIT_QUANTITY_MAX, Math.max(1, value + delta)) : 1;
      return { ...current, [uuid]: String(next) };
    });
  }

  function toggle(uuid: string) {
    setRemoved((current) => {
      const next = new Set(current);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  }

  function review() {
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (summary && summary.changes.length > 0) {
      setError(null);
      onReview(parsed, summary);
    }
  }

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <h4 className="font-display text-sm font-semibold text-ink">Edit request {name}</h4>
      {notice ? <InlineMessage tone="warn">{notice}</InlineMessage> : null}
      <ul className="flex flex-col gap-3" aria-label="Items">
        {editor.lines.map((line) => {
          const gone = removed.has(line.uuid);
          const label = lineLabel(line);
          const lastOne = !gone && kept <= 1;
          return (
            <li key={line.uuid} className="rounded-panel border border-line bg-surface p-3">
              <p className={`text-sm font-medium ${gone ? "text-ink-2 line-through" : "text-ink"}`}>{label}</p>
              {line.sku || line.propertyCount > 0 ? (
                <p className="text-xs text-ink-2">
                  {line.sku ? <span className="whitespace-nowrap font-mono">SKU {line.sku}</span> : null}
                  {line.sku && line.propertyCount > 0 ? " · " : null}
                  {line.propertyCount > 0
                    ? `Personalization kept exactly (${line.propertyCount} ${line.propertyCount === 1 ? "field" : "fields"})`
                    : null}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {gone ? null : (
                  <div className="flex items-center gap-1" role="group" aria-label={`Quantity of ${label}`}>
                    <button type="button" onClick={() => step(line.uuid, -1)} className={ui.iconButton}>
                      <MinusIcon size={16} aria-hidden />
                      <span className="sr-only">One fewer {label}</span>
                    </button>
                    <input
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={quantities[line.uuid] ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setQuantities((current) => ({ ...current, [line.uuid]: value }));
                      }}
                      aria-label={`Quantity of ${label}`}
                      className={`${ui.input} w-20 px-2 text-center tabular-nums`}
                    />
                    <button type="button" onClick={() => step(line.uuid, 1)} className={ui.iconButton}>
                      <PlusIcon size={16} aria-hidden />
                      <span className="sr-only">One more {label}</span>
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => toggle(line.uuid)}
                  disabled={lastOne}
                  aria-describedby={lastOne ? `${id}-keep` : undefined}
                  className={`${ui.buttonQuiet} h-10`}
                >
                  {gone ? <ArrowUUpLeftIcon size={16} aria-hidden /> : <TrashIcon size={16} aria-hidden />}
                  {gone ? "Keep" : "Remove"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {kept <= 1 ? (
        <p id={`${id}-keep`} className="text-xs text-ink-2">
          A request keeps at least one item.
        </p>
      ) : null}
      {editor.locations.length > 1 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className={`${ui.label} mb-1`}>Ship to</legend>
          {editor.locations.map((option) => (
            <label
              key={option.shopifyLocationId}
              className="flex cursor-pointer items-start gap-3 rounded-panel border border-line bg-surface p-3 has-[:checked]:border-primary-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
            >
              <input
                type="radio"
                name={`${id}-location`}
                value={option.shopifyLocationId}
                checked={locationId === option.shopifyLocationId}
                onChange={() => setLocationId(option.shopifyLocationId)}
                className="mt-0.5 size-4 shrink-0 accent-primary-strong"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{option.name}</span>
                {option.address ? <span className="block text-xs text-ink-2">{option.address}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : editor.locationName ? (
        <p className="text-sm text-ink-2">
          Ships to <span className="font-semibold text-ink">{editor.locationName}</span>.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={ui.errorText}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={review}
          disabled={summary !== null && summary.changes.length === 0}
          className={ui.buttonPrimary}
        >
          Review changes
        </button>
        <button type="button" onClick={onClose} className={ui.buttonSecondary}>
          Close
        </button>
      </div>
    </div>
  );
}

export function EditReview({
  name,
  summary,
  error,
  busy,
  onSave,
  onBack,
}: {
  name: string;
  summary: EditSummary;
  error: string | null;
  busy: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  const id = useId();
  const questionRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const openedAt = useRef<number | null>(null);

  useEffect(() => {
    openedAt.current = Date.now();
    questionRef.current?.focus();
  }, []);

  useEffect(() => {
    if (error) {
      focusSoon(() => errorRef.current);
    }
  }, [error]);

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <p id={`${id}-question`} ref={questionRef} tabIndex={-1} className="text-sm text-ink outline-none">
        <span className="font-semibold">Save these changes to request {name} in Shopify?</span> Personalization and proof
        links stay exactly as they are. Shopify recalculates the request; Approve still needs a $0.00 total.
      </p>
      <ul className="list-disc pl-5 text-sm text-ink">
        {summary.changes.map((change, index) => (
          <li key={index}>{change}</li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["Before", summary.before],
            ["After", summary.after],
          ] as const
        ).map(([title, side]) => (
          <section key={title} aria-labelledby={`${id}-${title}`} className="rounded-panel bg-surface-2 p-3">
            <h5 id={`${id}-${title}`} className="text-xs font-semibold text-ink-2">
              {title}
            </h5>
            <ul className="mt-1 text-sm text-ink">
              {side.lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-2">Ship to {side.shipTo}</p>
          </section>
        ))}
      </div>
      {error ? (
        <p id={`${id}-error`} ref={errorRef} tabIndex={-1} role="alert" className={`${ui.errorText} outline-none`}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            if (!busy && confirmArmed(openedAt.current, Date.now())) {
              onSave();
            }
          }}
          aria-busy={busy || undefined}
          aria-describedby={`${id}-question${error ? ` ${id}-error` : ""}`}
          className={ui.buttonPrimary}
        >
          {busy ? <Spinner /> : <CheckIcon size={16} aria-hidden />}
          {busy ? "Saving" : "Save changes"}
        </button>
        <button type="button" onClick={onBack} disabled={busy} className={ui.buttonSecondary}>
          Back to editing
        </button>
      </div>
    </div>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; editor: RequestEditor; notice: string | null };

// The editor's data: the draft read fresh through GET /api/orders/[id]/edit.
export function EditRequest({
  orderId,
  name,
  onSave,
  onClose,
}: {
  orderId: string;
  name: string;
  onSave: (body: EditRequestBody) => Promise<EditSaveOutcome>;
  onClose: (warning?: string | null) => void;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [review, setReview] = useState<{ body: EditRequestBody; summary: EditSummary } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(
    async (notice: string | null) => {
      setState({ status: "loading" });
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/edit`, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as { editor?: RequestEditor; error?: string } | null;
        if (!mounted.current) {
          return;
        }
        setState(
          response.ok && body?.editor
            ? { status: "ready", editor: body.editor, notice }
            : { status: "error", message: body?.error ?? `The request did not load (the server answered ${response.status}).` },
        );
      } catch {
        if (mounted.current) {
          setState({ status: "error", message: "Could not reach the server. Check your connection and try again." });
        }
      }
    },
    [orderId],
  );

  useEffect(() => {
    mounted.current = true;
    void load(null);
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function save() {
    if (!review || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await onSave(review.body);
    if (!mounted.current) {
      return;
    }
    setBusy(false);
    if ("error" in outcome) {
      if (outcome.editor) {
        setReview(null);
        setState({ status: "ready", editor: outcome.editor, notice: outcome.error });
      } else {
        setError(outcome.error);
      }
      return;
    }
    onClose(outcome.warning);
  }

  if (state.status === "loading") {
    return (
      <div aria-label="Loading the request from Shopify" className="flex flex-col gap-2">
        <span className="od-skeleton h-4 w-40" />
        <span className="od-skeleton h-16 w-full rounded-panel" />
        <span className="od-skeleton h-16 w-full rounded-panel" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <InlineMessage tone="bad">{state.message}</InlineMessage>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load(null)} className={ui.buttonSecondary}>
            Try again
          </button>
          <button type="button" onClick={() => onClose()} className={`${ui.buttonQuiet} h-10`}>
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      {/* Kept mounted while reviewing, so Back keeps what was typed. */}
      <div hidden={review !== null}>
        <EditRequestForm
          key={state.editor.updatedAt}
          name={name}
          editor={state.editor}
          notice={state.notice}
          onReview={(body, summary) => setReview({ body, summary })}
          onClose={() => onClose()}
        />
      </div>
      {review ? (
        <EditReview
          name={name}
          summary={review.summary}
          error={error}
          busy={busy}
          onSave={() => void save()}
          onBack={() => {
            setReview(null);
            setError(null);
          }}
        />
      ) : null}
    </>
  );
}
```

`src/components/desk/review-panel.tsx` (Wave 1a's version, where `ReviewActions` holds the modes `"idle" | "approve" | "approve-next" | "reject"` and `ReviewPanel` wraps `ReviewSummary` and `ReviewActions`):

- Imports: add `import { PencilSimpleIcon } from "@phosphor-icons/react/PencilSimple";` (`InlineMessage` already comes from `@/components/kit`).
- `ReviewActionsProps`, add (they reach `ReviewPanelProps` through its `Omit<ReviewActionsProps, "afterReject">`):

```ts
  // Managers edit a request before approval (comprehensive design section
  // 2). editBlock: why Edit request cannot be used now, or null.
  canEdit: boolean;
  editBlock: string | null;
  // Changes when the request's content changes (requestContentKey in
  // src/lib/request-edit.ts): an open Approve confirmation closes, so
  // nobody approves what they did not see.
  contentKey: string;
  // The editor (src/components/desk/edit-request.tsx). close takes the
  // warning a save left (a total above $0), if any.
  editor: (close: (warning?: string | null) => void) => React.ReactNode;
```

- `type Mode = "idle" | "approve" | "approve-next" | "reject" | "edit";`
- In `ReviewActions`: destructure the four props; add `const [notice, setNotice] = useState<string | null>(null);`, `const [shownKey, setShownKey] = useState(contentKey);`, `const editRef = useRef<HTMLButtonElement>(null);`, and right after the existing state (adjusting state when a prop changes, during render, before any early return):

```ts
  // The request changed (an edit here or by someone else, a sync): an open
  // Approve confirmation (with or without "and next") closes and says why.
  if (shownKey !== contentKey) {
    setShownKey(contentKey);
    if (mode === "approve" || mode === "approve-next") {
      setMode("idle");
      setNotice("This request changed. Review it again before approving.");
    }
  }
```

- The edit mode, as an early return next to the reject mode's:

```tsx
  if (mode === "edit") {
    return (
      <div>
        {editor((warning) => {
          setMode("idle");
          setNotice(warning ?? null);
          focusSoon(() => editRef.current);
        })}
      </div>
    );
  }
```

- The Approve, Approve and next and Reject buttons' `onClick`s also clear the notice: `() => { setNotice(null); setMode("approve"); }`, and the same with `"approve-next"` and `"reject"`.
- In the idle button row, after the Reject button:

```tsx
        {canEdit ? (
          <button
            ref={editRef}
            type="button"
            onClick={() => {
              setNotice(null);
              setMode("edit");
            }}
            disabled={editBlock !== null}
            aria-describedby={editBlock ? editWhyId : undefined}
            className={ui.buttonSecondary}
          >
            <PencilSimpleIcon size={16} aria-hidden />
            Edit request
          </button>
        ) : null}
```

  with, next to `rejectWhyId`:

```ts
  const editWhyId = approveWhyShown && editBlock === approveBlock ? `${id}-approve-why` : `${id}-edit-why`;
```

  and, below the existing reason lines:

```tsx
      {canEdit && editBlock && editWhyId === `${id}-edit-why` ? (
        <p id={`${id}-edit-why`} className="mt-2 text-sm text-ink-2">
          {editBlock}
        </p>
      ) : null}
```
- Below the reason lines of the idle view, the notice: `{notice ? <div className="mt-3"><InlineMessage tone="warn">{notice}</InlineMessage></div> : null}`.
- Header comment: add "Edit request (managers) opens the request editor in place of the buttons; opening it closes an open Approve confirmation, and a change to the request's content closes one too."

`src/components/desk/order-drawer.tsx`:

- Props: `// Edit a request before approval (src/components/desk/edit-request.tsx).` `onEditRequest: (body: EditRequestBody) => Promise<EditSaveOutcome>;` with `import type { EditRequestBody } from "@/lib/request-edit";`, `import { requestContentKey } from "@/lib/request-edit";` and `import { EditRequest, type EditSaveOutcome } from "./edit-request";`.
- Next to `rejectBlock`: `const editBlock = deleted ? "Shopify no longer has this draft." : !drafts.draftsEnabled ? draftsOff : null;`
- The `<ReviewActions key={orderId} ...>` call in the drawer footer (Wave 1a's Task 19) gains:

```tsx
                canEdit={canReview}
                editBlock={editBlock}
                contentKey={requestContentKey(summary)}
                editor={(close) => <EditRequest orderId={orderId} name={name} onSave={onEditRequest} onClose={close} />}
```

  (The footer scrolls inside its 60dvh cap, so the editor and its review fit a phone screen; the body's `ReviewSummary` stays as it is.)

`src/components/desk/desk.tsx`, after `approve` (import `type EditRequestBody, type RequestEditor` from `@/lib/request-edit` and `type EditSaveOutcome` from `./edit-request`):

```ts
  // Edit a request before approval (comprehensive design section 2). A 409
  // that carries the fresh editor reloads it in place.
  const editRequestAction = useCallback(
    async (orderId: string, body: EditRequestBody): Promise<EditSaveOutcome> => {
      let response: Response;
      try {
        response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        return { error: "Could not reach the server. Your changes are still here; check the request before saving again." };
      }
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        editor?: RequestEditor;
        kind?: "edited" | "unchanged";
        event?: EventView;
        warning?: string | null;
      } | null;
      if (!response.ok || !result?.kind) {
        return {
          error: result?.error ?? `Not saved (the server answered ${response.status}). Try again.`,
          ...(result?.editor ? { editor: result.editor } : {}),
        };
      }
      if (result.kind === "edited" && result.event) {
        applyEvent({ kind: "order.activity", event: result.event });
        toast({ title: "Request updated in Shopify.", tone: "good" });
      } else {
        toast({ title: "Nothing changed on this request.", tone: "info" });
      }
      void reload();
      if (openRef.current === orderId) {
        void loadDrawer(orderId, true);
      }
      return { warning: result.warning ?? null };
    },
    [applyEvent, toast, reload, loadDrawer],
  );
```

and pass `onEditRequest={(body) => editRequestAction(drawerOrderId, body)}` to `OrderDrawerContent`. In `src/components/desk/order-drawer.test.ts`, add `onEditRequest: async () => ({ warning: null }),` to the props its `render` passes.

`src/components/settings/store-connection.tsx` line 140: "read_draft_orders, write_draft_orders and read_companies to bring draft orders (requests) onto the desk, and read_products so managers can edit requests."

**Step 4: Run them**

Run: `npx vitest run src/components/desk/edit-request.test.ts src/components/desk/review-panel.test.ts src/components/desk/order-drawer.test.ts`
Expected: PASS. Then the local visual check in Task 26 covers the editor (it needs the fetch stand-in described there, because the local sample store cannot reach Shopify).

**Step 5: Commit**

Gates, then:

```bash
git add src/components/desk/edit-request.tsx src/components/desk/edit-request.test.ts src/components/desk/review-panel.tsx src/components/desk/review-panel.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/desk.tsx src/components/settings/store-connection.tsx
git commit -m "feat: Edit request in the drawer with a before-and-after review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/desk/edit-request.tsx src/components/desk/edit-request.test.ts src/components/desk/review-panel.tsx src/components/desk/review-panel.test.ts src/components/desk/order-drawer.tsx src/components/desk/order-drawer.test.ts src/components/desk/desk.tsx src/components/settings/store-connection.tsx
```

---

### Task 25: HANDOFF state update

**Files:**
- Modify: `docs/HANDOFF.md` (append a new section at the end)

**Step 1:** No test (documentation). Append `## STATE UPDATE, <date> WAVE 1B locations, editing requests, cancel (supersedes above)` covering, in the house style of the earlier updates (short bullets, no em-dashes):

- Branch, commits (the list from `git log --oneline` since Wave 1a's last commit), NOT pushed, NOT deployed.
- NEW MIGRATION 0012 (`drizzle/0012_locations_edit_cancel.sql`): `locations` table, `orders.location_id`, a closed slate Cancelled status (link `cancelled`) appended to every workspace with room and none yet; new event types `draft_edited` and `order_cancelled` (TypeScript only, no CHECK). No new dependency, binding, secret or wrangler change.
- What shipped: locations sync (when it runs, what active means, the name backfill), `location_id` from the purchasing entity in every snapshot writer, the address rule and where AddressBlock is used (drawer ship-to, PO modal prefill, PO send step, vendor email, PO PDF; the list's Branch column), Edit request (scope, refusals, what is sent and what is not, the concurrency check, the $0 warning, closing an open Approve confirmation), Cancel order (scope, $0 only, what Shopify is told, the confirmed flag), the cancelled status rules, Shopify to app cancellations, the orders query at 798 of 800.
- The id convention: `orders.location_id` and `locations.shopify_location_id` are Shopify legacy ids; join on workspace and that id.
- Deploy order (copy the Deploy notes below).
- Ryan's step: Settings > Store connection > Refresh connection once after the deploy (registers `company_locations/*` and runs the first location sync). If the app lacks `read_products`, add it in the Dev Dashboard, release the version, then Refresh connection (Edit request says so until then).
- Stage 0 live checks with Ryan (checkboxes): edit a test request (one quantity, one removal, one location switch), then in Shopify check the lines, every personalization attribute and proof link, the $0 total, the company location and the shipping address; approve it from the desk; cancel a test $0 order from the desk and check in Shopify: cancelled, no email to the customer, nothing restocked, nothing refunded, staff note present; cancel another test order in Shopify admin and see the card move with "Cancelled in Shopify"; add a company location in Shopify and see it appear (webhook) and on the next day's cron pass; the Branch column on the desk.
- Known limits: the company location on orders, the location sync and the location webhooks need `read_companies` or `write_companies` (a store without one keeps syncing, without locations); the edit uses the location's synced address (refreshed daily and by webhook); a location without a shipping address is not offered; edits are refused for custom lines, item discounts or price overrides, bundles and more than 50 lines; Shopify's cancel job could fail after accepting (the drawer keeps saying "not confirmed"); the order query budget is used up; orders cancelled in Shopify before this deploy move only when Shopify next updates them.

**Step 2:** Run `grep -nP "\x{2014}|\x{2013}" docs/HANDOFF.md` and expect no output.

**Step 3: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: handoff for Wave 1b locations, editing requests and cancel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- docs/HANDOFF.md
```

---

### Task 26: Final verification

**Files:** none changed unless a check fails (then fix test-first in the task it belongs to and commit there).

**Step 1: Full gates**

Run, in order, and expect each to pass: `npm run test`, `npx tsc --noEmit --incremental false`, `npm run build`.

**Step 2: House-rule scans over everything this wave changed**

```bash
git diff --name-only <wave-1a-last-commit>..HEAD > /tmp/w1b-files.txt
grep -nP "\x{2014}|\x{2013}" $(cat /tmp/w1b-files.txt)            # no output: no em-dashes or en-dashes
grep -nP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" $(cat /tmp/w1b-files.txt)   # no output: no emoji
grep -nE "#[0-9a-fA-F]{3,8}\b" $(grep -E "\.tsx$" /tmp/w1b-files.txt)          # no hard-coded colors in components
```

(Use your scratchpad instead of `/tmp` if your session gives you one.)

**Step 3: Migration proof on production-shaped data**

Work in a throwaway directory in your scratchpad, never in the repo, never against remote D1.

```bash
P=<scratchpad>/proof-0012
mkdir -p "$P/migrations"
BACKUP=$(ls -t "../backups"/orderingdesk-*.sql | head -1)          # the newest backup, from the repo root
grep -o "'[0-9]\{4\}_[a-z_]*\.sql'" "$BACKUP" | tail -1             # the last migration that backup had applied, for example '0011_work_queue.sql'
```

Copy `drizzle/0000_*.sql` through that migration into `$P/migrations`, and write `$P/wrangler.jsonc`:

```jsonc
{
  "name": "orderingdesk-migration-proof",
  "compatibility_date": "2026-09-01",
  "d1_databases": [
    { "binding": "DB", "database_name": "orderingdesk", "database_id": "00000000-0000-4000-8000-000000000000", "migrations_dir": "migrations" }
  ]
}
```

Extract the data rows (every INSERT except `sqlite_sequence`, `d1_migrations` and `_cf_` tables) with a statement-aware script, so values that span lines stay whole:

```python
# <scratchpad>/proof-0012/extract.py
import sqlite3, sys
source, out = sys.argv[1], sys.argv[2]
skip = ('INSERT INTO "sqlite_sequence"', 'INSERT INTO "d1_migrations"', 'INSERT INTO "_cf_')
buffer, kept = "", ["PRAGMA defer_foreign_keys = on;"]
for line in open(source, encoding="utf-8"):
    buffer += line
    if sqlite3.complete_statement(buffer):
        statement, buffer = buffer.strip(), ""
        if statement.startswith("INSERT INTO") and not statement.startswith(skip):
            kept.append(statement)
open(out, "w", encoding="utf-8").write("\n".join(kept) + "\n")
print(len(kept) - 1, "rows")
```

Then:

```bash
python3 "$P/extract.py" "$BACKUP" "$P/data.sql"
npx wrangler d1 migrations apply orderingdesk --local --persist-to "$P/state" -c "$P/wrangler.jsonc"
npx wrangler d1 execute orderingdesk --local --persist-to "$P/state" -c "$P/wrangler.jsonc" --file "$P/data.sql"
npx wrangler d1 execute orderingdesk --local --persist-to "$P/state" -c "$P/wrangler.jsonc" --json --command "SELECT name FROM sqlite_master WHERE type='table'" > "$P/tables.json"
```

Record per-table row counts (one `SELECT count(*)` per table from `tables.json`) into `$P/before.json`. Copy the remaining migrations (through `0012_locations_edit_cancel.sql`) into `$P/migrations`, apply again, and record `$P/after.json`. Expect:

- Every table keeps its row count, except `statuses`: plus one per workspace that had fewer than 20 statuses and no `cancelled` key or link (IMPACT: plus one), and `locations` exists with 0 rows.
- `SELECT workspace_id, key, label, color, sort, shopify_link, closed FROM statuses WHERE key = 'cancelled'` shows `Cancelled`, `slate`, the next sort, `cancelled`, `1`.
- `SELECT count(*) FROM orders WHERE location_id IS NOT NULL` is 0, and `PRAGMA table_info(orders)` lists `location_id` last.
- `PRAGMA foreign_key_check` returns nothing.
- Optional, as in 0010's proof: point the app's read model at the proof database (a small script under the scratchpad that opens it with better-sqlite3 and calls `loadDesk`), and see every order open with its timeline.

Write the counts and these results into the HANDOFF section (Task 25) if anything differs from the expectation, and stop if any check fails.

**Step 4: Local visual pass**

- `npm run db:migrate:local`, then seed one location and point the newest request at it (local D1 only):

```bash
npx wrangler d1 execute orderingdesk --local --command "INSERT INTO locations (id, workspace_id, shopify_location_id, company_id, name, address, active, updated_at) SELECT 'loc-sample-1', id, '9001', '1', 'Sample North Yard', '{\"address1\":\"1 Sample Way\",\"address2\":\"\",\"city\":\"Buford\",\"province\":\"Georgia\",\"provinceCode\":\"GA\",\"zip\":\"30518\",\"country\":\"United States\",\"countryCode\":\"US\",\"phone\":\"\",\"company\":\"Example Co\"}', 1, 1 FROM workspaces LIMIT 1"
npx wrangler d1 execute orderingdesk --local --command "UPDATE orders SET location_id = '9001' WHERE id = (SELECT id FROM orders WHERE shopify_order_id IS NULL ORDER BY created_at DESC LIMIT 1)"
```

- `npm run dev`, sign in as in earlier local checks, open the sample workspace. Check at 1440x900 and 375x812, in light and dark: the desktop Branch column (location name, "No branch" muted, no Total column); the drawer's Ship to with the location name in bold; the PO modal ship-to prefill starting with the location; the PO send step's ship-to; the cancel panel through reason, review and confirm on an approved order (the final press shows the server's refusal, since the local sample store cannot reach Shopify); a request drawer as manager and as staff (Edit request offered only to the manager; Approve confirmation closes when Edit request opens).
- The editor itself needs Shopify. To see it locally, stand in for the GET in the browser console (inspection only, nothing committed), then press Edit request:

```js
const realFetch = window.fetch;
window.fetch = (input, init) =>
  String(input).endsWith("/edit") && (!init || !init.method || init.method === "GET")
    ? Promise.resolve(new Response(JSON.stringify({ editor: {
        updatedAt: "2026-10-06T14:00:00Z",
        lines: [
          { uuid: "u-1", title: "Hard Hat", variantTitle: "White", sku: "HH-1", quantity: 2, propertyCount: 2 },
          { uuid: "u-2", title: "Safety Vest", variantTitle: "L", sku: "SV-L", quantity: 1, propertyCount: 0 },
        ],
        locationId: "9001", locationName: "Sample North Yard",
        locations: [
          { shopifyLocationId: "9001", name: "Sample North Yard", address: "1 Sample Way, Buford GA 30518, US" },
          { shopifyLocationId: "9002", name: "Sample South Yard", address: "2 Sample Way, Athens GA 30601, US" },
        ],
      } }), { status: 200, headers: { "content-type": "application/json" } }))
    : realFetch(input, init);
```

  Check the editor and its review step at both sizes and themes: steppers and Remove reachable at 40 px or more, the last item's Remove disabled with its reason, the location cards with a visible focus ring, the review's Before and After stacking on a phone, Save focusing the question first and ignoring a press in its first 400 ms; Save then shows the server's refusal in the step (the sample store again).
- Contrast: run the contrast script the earlier waves used (`<scratchpad>/discovery/contrast.mjs`, or the same method) on the new text: muted "No branch", the location radio labels, the cancelled chip, the pending note. Everything AA.
- Reset any viewport emulation when done.

**Step 5:** If everything passes, there is nothing to commit. Report the gate output, the proof counts and the visual notes to the lead.

---

## Deploy notes (operator, after review)

1. At the final commit: `npm run test`, `npx tsc --noEmit --incremental false` and `npm run build` are green.
2. Backup: export production D1 to `Impact Rentals/backups/orderingdesk-before-0012-<date>.sql` (`npx wrangler d1 export orderingdesk --remote --output ../backups/orderingdesk-before-0012-<date>.sql`) and record a time-travel bookmark (`npx wrangler d1 time-travel info orderingdesk`).
3. Production must already be at 0011 (Wave 1a deployed). `npm run db:migrate:remote` FIRST (applies 0012), then `npm run deploy`. Code deployed before 0012 fails every sync and every order insert (it names `orders.location_id`); the pinned test in `src/server/sync/run.test.ts` says so.
4. Ryan: Settings > Store connection > Refresh connection once (registers the `company_locations/*` webhooks and runs the first location sync). If Edit request says `read_products` is missing: add it to the app in the Dev Dashboard, release, then Refresh connection again.
5. Check the first location sync, which runs right after Refresh connection: `npx wrangler d1 execute orderingdesk --remote --command "SELECT name, active, company_id FROM locations"` (read-only) lists IMPACT's branches. From then on the cron logs a `[locations]` line once a day. Watch `npx wrangler tail` for: no `MAX_COST_EXCEEDED` on the orders page (the estimate is 798 of the 800 budget; Shopify's own price for the union is lower), no 401 on `/api/webhooks/shopify/...` for `company_locations/*`, and the Branch column filling in on the desk.
6. Pages loaded before the deploy have no Edit request, no Cancel order and no Branch column: managers reload once.
7. Scopes: the orders page names the company location only while the stored grant holds `read_companies` or `write_companies` (IMPACT has `read_companies`; check with `SELECT scopes FROM store_connections`). A workspace without it keeps syncing as before, with no location sync, no location webhooks and no `location_id` from orders. Cancel order needs `write_orders` (a required scope) and Edit request needs `read_products`.
8. Then the Stage 0 live checks listed in the HANDOFF section, with Ryan, on test requests and test orders only.
9. Rollback: 0012 is additive, so `npx wrangler rollback` alone undoes a bad deploy (older code never names `orders.location_id` or the `locations` table; the Cancelled status stays as an ordinary closed status). Use the time-travel bookmark only for damaged data.
