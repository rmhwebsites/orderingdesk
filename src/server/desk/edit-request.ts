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
// changes nothing; any other failure is followed by a read, never a resend,
// and an error Shopify answered with (a GraphQL error, a rejected token) is
// then reported in Shopify's own words. The updated draft is written onto
// the card through the sync's own writer, a draft_edited entry names the
// actor and the changes, and a total above $0 afterwards comes back as a
// warning (Approve needs $0).

import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, orders, storeConnections } from "@/db/schema";
import { addressBlock, oneLineAddress, type LocationAddress } from "@/lib/address";
import { formatMoney } from "@/lib/format";
import { roleAtLeast } from "@/lib/roles";
import { eventSource, withVia } from "@/lib/via";
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
  notSaved: (detail: string, unchanged: boolean) =>
    `Shopify did not save the changes: ${sentence(detail)}. ${unchanged ? "Nothing changed." : "Check the request in Shopify before editing it again."}`,
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
export function mailingAddress(address: LocationAddress, recipient: DraftForEdit["recipient"]): Record<string, string> {
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
    return refused(409, EDIT_REFUSALS.notSaved(sent.detail, true));
  } else {
    // Anything but userErrors: read, never send again. A timeout or a
    // transport failure may have run, and so may an internal error Shopify
    // reports as a GraphQL error.
    const after = await fetchDraftForEdit(access.shopDomain, access.token, gid, access.fetchImpl);
    const current = after.kind === "ok" ? after.draft : null;
    const landed = current !== null && editLanded({ lines: current.lines, locationId: current.company?.locationId ?? null }, parsed);
    if (!landed) {
      const unchanged = current !== null && current.updatedAt === parsed.updatedAt;
      if (sent.kind === "fatal" || sent.kind === "auth") {
        // Shopify answered, with an error: its own words for the manager, and
        // ids plus the kind for whoever looks (never the words, which can
        // quote the input).
        console.warn(
          "[edit] " +
            JSON.stringify({ workspaceId: ctx.workspaceId, orderRowId: card.id, shopifyDraftId: card.shopifyDraftId, failure: sent.kind }),
        );
        return refused(409, EDIT_REFUSALS.notSaved(failureText(sent), unchanged));
      }
      return refused(502, unchanged ? EDIT_REFUSALS.noAnswerUnchanged : EDIT_REFUSALS.noAnswer);
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
    meta: withVia({ changes: summary.changes, before: summary.before, after: summary.after }, ctx.via),
    createdAt: now,
    source: eventSource(ctx.via),
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
