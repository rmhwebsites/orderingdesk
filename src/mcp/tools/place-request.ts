// Placing a request for anyone through an AI app (comprehensive desk design
// section 4; Wave 2 plan, Decision 15): managers and platform admins only.
// The request is a Shopify draft for the person's B2B company contact at a
// company location of the workspace's company: purchasing entity (company,
// contact, location), the location's address, IMPACT's request cart
// attributes, personalization as line item attributes, and the tags
// "via AI" and a marker (no other tag). The preview runs draftOrderCalculate
// and refuses anything but exactly $0.00, and returns every personalization
// detail verbatim for the person to confirm (owner decision 4, Oct 7:
// src/mcp/details.ts); the confirm must carry details_confirmed: true and
// those details, then sends draftOrderCreate once; after a timeout it looks
// the draft up by its marker, and an unanswered create stays "unknown" so
// the same confirmation can only look it up again. The person is named by
// their stored name through personLabel (Decision 13): a stored name that is
// Shopify's email or phone fallback is no name, and the request is refused.
// The new draft is written onto the desk like a webhook would write it, gets
// a "request_placed" entry via AI, and is announced like any new request.
// Relative imports only.

import { and, eq, or, sql } from "drizzle-orm";
import * as z from "zod";
import { events, locations, orders, people } from "../../db/schema";
import { cleanText } from "../../lib/desk-query";
import { formatMoney } from "../../lib/format";
import { EDIT_QUANTITY_MAX } from "../../lib/request-edit";
import { roleAtLeast } from "../../lib/roles";
import { withVia } from "../../lib/via";
import { broadcast, broadcastSync } from "../../server/broadcast";
import { mailingAddress } from "../../server/desk/edit-request";
import { eventView } from "../../server/desk/shapes";
import { shopifyAccess, REVIEW_READY_TRIES, REVIEW_RETRY_MS } from "../../server/desk/review";
import { notifyNewOrders } from "../../server/notify";
import { failureText } from "../../server/shopify/admin";
import { companyLocationGid } from "../../server/shopify/locations";
import { normalizeDrafts } from "../../server/shopify/normalize";
import { calculateRequest, createRequestDraft, fetchContactProfiles, findDraftByMarker, findVariants, markerTag } from "../../server/shopify/requests";
import { upsertFetchedDraft } from "../../server/sync/drafts";
import { locationAddressLines } from "../../lib/address";
import { beginConfirm, finishAction, prepareAction, preparedResult, stateMatches, type ActionRow } from "../actions";
import {
  DetailsInput,
  confirmDetailsOf,
  detailsHash,
  detailsMismatch,
  personalizationDetails,
  type PersonalizationDetail,
} from "../details";
import { randomHex, newId } from "../ids";
import { NAME_MAX, personLabel, plainText, untrusted } from "../output";
import { confirmationInput, followDeps, refusal, reviewDeps, textMismatch } from "./common";
import { CONFIRM_ADDITIVE, PREPARE, READ, defineTool, fail, ok, type ToolDeps, type ToolOutcome } from "./define";

const FORBIDDEN = "Only a manager can place requests through an AI app.";
const LINK = /https?:\/\/|www\.|javascript:|data:/i;
// Control and hidden characters (Decision 13): the class plainText strips in
// src/mcp/output.ts, here with tab and line feed too, since confirm_details
// returns these values verbatim.
const CONTROL = /[\p{C}\p{Default_Ignorable_Code_Point}\u{2028}\u{2029}]/u;

type PlacePayload = {
  input: Record<string, unknown>;
  marker: string;
  personId: string;
  // The name as the preview showed it (personLabel).
  forPerson: string;
  locationId: string;
  location: string;
  // Every personalization detail as sent (src/mcp/details.ts) and its hash;
  // the confirm must repeat them after the person confirmed them.
  details: PersonalizationDetail[];
  detailsHash: string;
};

export const findProducts = defineTool({
  name: "find_products",
  title: "Find products",
  description: "Active products and variants matching words or a SKU, with the variant_id prepare_place_request takes. Read from Shopify.",
  minRole: "manager",
  needsWrite: true,
  counts: "read",
  annotations: READ,
  input: z.object({ query: z.string().min(2).max(60).describe("Product title words or a SKU") }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const granted = await shopifyAccess(deps.db, p.workspaceId, reviewDeps(deps));
    if (granted.kind !== "ok") {
      return refusal(granted.status, granted.error);
    }
    const { access } = granted;
    const found = await findVariants(access.shopDomain, access.token, cleanText(args.query, 60), access.fetchImpl);
    if (found.kind !== "ok") {
      const detail = failureText(found);
      return detail.includes("read_products")
        ? fail("refused", "This store's Shopify app cannot read products (read_products). A platform admin can grant it and press Refresh connection.")
        : fail(found.kind === "transient" ? "shopify_unavailable" : "refused", `Shopify did not answer the product search (${plainText(detail, 200)}).`);
    }
    return ok({
      products: found.variants
        .filter((variant) => variant.active)
        .map((variant) => ({
          variant_id: variant.variantId,
          product: plainText(variant.product, 160),
          variant: plainText(variant.variant, 120) || null,
          sku: plainText(variant.sku, 60) || null,
        })),
    });
  },
});

const LineInput = z
  .object({
    variant_id: z.string().regex(/^\d{1,20}$/).describe("A variant_id from find_products"),
    quantity: z.number().int().min(1).max(EDIT_QUANTITY_MAX),
    personalization: z
      .array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(200) }).strict())
      .max(8)
      .optional()
      .describe("Text printed on the item as label and value pairs, for business cards: Full Name, Job Title, Mobile Phone, Office Phone, Email, Office Address"),
  })
  .strict();

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] } : { firstName: parts[0] ?? "", lastName: "" };
}

export const preparePlaceRequest = defineTool({
  name: "prepare_place_request",
  title: "Prepare a request for someone",
  description:
    "Previews placing a request for an employee at a company location: it is created as a Shopify draft at $0.00 and waits for approval like any request. Checks the price with Shopify and changes nothing; returns a confirmation for confirm_place_request and, for personalized items, confirm_details: every personalization detail exactly as it will be printed, for the person to confirm.",
  minRole: "manager",
  needsWrite: true,
  counts: "read",
  annotations: PREPARE,
  input: z
    .object({
      for_person: z.string().min(1).max(64).describe("A person id from find_people"),
      location: z.string().min(1).max(80).describe("A company location name or id from list_locations"),
      lines: z.array(LineInput).min(1).max(20),
      reason: z.string().max(500).optional().describe("Why it is needed; shown on the request"),
      note: z.string().max(1000).optional().describe("A note on the draft"),
    })
    .strict(),
  async run(args, deps) {
    const p = deps.principal;
    if (!roleAtLeast(p.role, "manager")) {
      return fail("forbidden", FORBIDDEN);
    }
    for (const line of args.lines) {
      for (const field of line.personalization ?? []) {
        if (field.label.trim().startsWith("_") || LINK.test(field.value) || LINK.test(field.label) || CONTROL.test(field.value) || CONTROL.test(field.label)) {
          return fail("invalid_input", "Personalization labels cannot start with an underscore, and personalization cannot contain links, control characters or hidden characters.");
        }
        // Every detail must survive cleanText, so the person confirms and
        // the confirm repeats a real value (src/mcp/details.ts).
        if (cleanText(field.label, 40) === "" || cleanText(field.value, 200) === "") {
          return fail("invalid_input", "Personalization labels and values cannot be blank.");
        }
      }
    }
    const persons = await deps.db.select().from(people).where(and(eq(people.workspaceId, p.workspaceId), eq(people.id, args.for_person))).limit(1);
    const person = persons[0];
    if (!person) {
      return fail("not_found", "No such person in this workspace. Find them with find_people.");
    }
    const name = personLabel(person.name);
    if (!person.name || !name) {
      return fail("refused", "Ordering Desk has no name for this person (Shopify has only an email or a phone number), so a request cannot name them. Add their first and last name in Shopify first.");
    }
    const ref = args.location.trim();
    const places = await deps.db
      .select()
      .from(locations)
      .where(and(eq(locations.workspaceId, p.workspaceId), eq(locations.active, true), or(eq(locations.shopifyLocationId, ref), sql`lower(${locations.name}) = ${ref.toLowerCase()}`)))
      .limit(1);
    const place = places[0];
    if (!place) {
      return fail("not_found", `No active company location ${plainText(ref, 80)}. Find it with list_locations.`);
    }
    if (!place.address || !place.companyId) {
      return fail("refused", `${plainText(place.name, NAME_MAX)} has no shipping address or company in Shopify yet. Fix it in Shopify, then Refresh connection.`);
    }
    const granted = await shopifyAccess(deps.db, p.workspaceId, reviewDeps(deps));
    if (granted.kind !== "ok") {
      return refusal(granted.status, granted.error);
    }
    const { access } = granted;
    const contacts = await fetchContactProfiles(access.shopDomain, access.token, person.shopifyCustomerId, access.fetchImpl);
    if (contacts.kind !== "ok") {
      return fail(contacts.kind === "transient" ? "shopify_unavailable" : "refused", `Could not read ${name} in Shopify (${plainText(failureText(contacts), 200)}).`);
    }
    const profile = contacts.profiles?.find((entry) => entry.companyId === place.companyId);
    if (!profile) {
      return fail("refused", `${name} is not a contact of this company in Shopify. Add them as a company contact in Shopify first.`);
    }
    const marker = markerTag(randomHex(8));
    const reason = args.reason ? cleanText(args.reason, 500) : "";
    const note = args.note ? args.note.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, 1000) : "";
    const lineItems = args.lines.map((line) => ({
      variantId: `gid://shopify/ProductVariant/${line.variant_id}`,
      quantity: line.quantity,
      customAttributes: (line.personalization ?? []).map((field) => ({ key: cleanText(field.label, 40), value: cleanText(field.value, 200) })),
    }));
    // What the person confirms is exactly what Shopify gets (Decision 12).
    const details = personalizationDetails(lineItems);
    const input: Record<string, unknown> = {
      purchasingEntity: {
        purchasingCompany: {
          companyId: `gid://shopify/Company/${place.companyId}`,
          companyContactId: `gid://shopify/CompanyContact/${profile.contactId}`,
          companyLocationId: companyLocationGid(place.shopifyLocationId),
        },
      },
      lineItems,
      shippingAddress: mailingAddress(place.address, splitName(person.name)),
      customAttributes: [
        { key: "For Employee Name", value: person.name },
        { key: "Ship to Branch", value: place.name },
        ...(reason ? [{ key: "Reason for Request", value: reason }] : []),
      ],
      tags: ["via AI", marker],
      ...(note ? { note } : {}),
    };
    const calc = await calculateRequest(access.shopDomain, access.token, input, access.fetchImpl);
    if (calc.kind !== "ok") {
      return calc.kind === "transient"
        ? fail("shopify_unavailable", `Shopify did not answer the price check (${plainText(calc.detail, 200)}). Nothing changed.`)
        : fail("refused", `Shopify refused this request: ${plainText(failureText(calc), 300)}. Nothing changed.`);
    }
    const total = calc.calculated.total;
    if (total === null || Number(total) !== 0) {
      const amount = total ? formatMoney(total, calc.calculated.currency) : "an amount Shopify did not report";
      return fail("refused", `This request would total ${amount} at ${plainText(place.name, NAME_MAX)}. Ordering Desk only places requests that total $0.00.`);
    }
    const payload: PlacePayload = {
      input,
      marker,
      personId: person.id,
      forPerson: name,
      locationId: place.shopifyLocationId,
      location: place.name,
      details,
      detailsHash: await detailsHash(details),
    };
    const prepared = await prepareAction(deps.db, p, { tool: "place_request", targetId: null, payload, state: "" }, deps.now());
    const lines = calc.calculated.lines.map((line) => `${line.quantity} x ${plainText(line.title, 160)}${line.variant ? ` (${plainText(line.variant, 80)})` : ""}`);
    const where = plainText(place.name, NAME_MAX);
    const warnings = profile.locationIds.includes(place.shopifyLocationId) ? [] : [`${name} has no role at ${where} in Shopify; Shopify may refuse the request.`];
    return preparedResult(prepared, {
      summary: `Place a request for ${name} at ${where}: ${lines.join(", ")}. Total $0.00. It ships to ${where} and waits for approval like any request.`,
      details: {
        for_person: name,
        location: where,
        ship_to: locationAddressLines(place.address).map((line) => plainText(line, 200)),
        lines,
        reason: untrusted(reason),
      },
      warnings,
      // Verbatim, not through plainText: these are the values the person
      // checks and Shopify prints (checked above: no links, no control
      // characters). Contact details included, by owner decision 4.
      confirmDetails: confirmDetailsOf(details),
      confirm: { tool: "confirm_place_request", fields: { for_person: name, location: place.name, ...(details.length > 0 ? { details } : {}) } },
    });
  },
});

async function cardIdForDraft(deps: ToolDeps, draftId: string): Promise<string | null> {
  const rows = await deps.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.workspaceId, deps.principal.workspaceId), eq(orders.shopifyDraftId, draftId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

// The draft Shopify created, onto the desk: written like a webhook would
// write it, with a "request_placed" entry via AI, announced after the answer.
async function land(deps: ToolDeps, action: ActionRow, payload: PlacePayload, node: Record<string, unknown>): Promise<ToolOutcome> {
  const p = deps.principal;
  const now = deps.now();
  const [draft] = normalizeDrafts([node]);
  if (!draft) {
    await finishAction(deps.db, action.id, "done", "created_unread");
    return ok({ done: true, message: "Shopify created the request; it appears on the desk with the next sync." });
  }
  const written = await upsertFetchedDraft(deps.db, p.workspaceId, draft, now);
  const orderId = written.kind === "unchanged" ? await cardIdForDraft(deps, draft.shopifyDraftId) : written.orderId;
  let placed: ReturnType<typeof eventView> | null = null;
  if (orderId) {
    const event = {
      id: newId(),
      workspaceId: p.workspaceId,
      orderId,
      type: "request_placed" as const,
      text: `Placed this request for ${plainText(payload.forPerson, NAME_MAX)} at ${plainText(payload.location, NAME_MAX)}`,
      actorId: p.userId,
      meta: withVia({ forPerson: payload.forPerson, location: payload.location, marker: payload.marker }, { client: p.client }),
      createdAt: now,
      source: "ai" as const,
    };
    await deps.db.insert(events).values(event);
    placed = eventView(event);
  }
  await finishAction(deps.db, action.id, "done", "ok");
  deps.after(async () => {
    if (!orderId) {
      return;
    }
    const added = written.kind === "added";
    await broadcastSync(deps.env, p.workspaceId, { addedOrderIds: added ? [orderId] : [], updatedOrderIds: added ? [] : [orderId] });
    if (placed) {
      await broadcast(deps.env, p.workspaceId, { kind: "order.activity", event: placed });
    }
    await notifyNewOrders(deps.db, deps.env, p.workspaceId, [orderId], followDeps(deps));
  });
  const totalNote = Number(draft.total) !== 0 ? " Shopify shows a total above $0.00 now, so Approve will refuse it until that is fixed." : "";
  return ok(
    {
      done: true,
      request: draft.name,
      card_id: orderId,
      for_person: plainText(payload.forPerson, NAME_MAX),
      location: plainText(payload.location, NAME_MAX),
      message: `Request ${draft.name} is waiting for approval.${totalNote}`,
    },
    orderId ? { kind: "order", id: orderId } : undefined,
  );
}

export const confirmPlaceRequest = defineTool({
  name: "confirm_place_request",
  title: "Confirm a request for someone",
  description:
    "Creates the request prepared by prepare_place_request in Shopify, once. Repeat the person and the location exactly as the preview showed them; for personalized items also details_confirmed: true, once the person confirmed the details are correct, and the details exactly as confirm_details listed them. If Shopify did not answer, calling it again with the same confirmation only looks the request up.",
  minRole: "manager",
  needsWrite: true,
  counts: "self",
  annotations: CONFIRM_ADDITIVE,
  input: z
    .object({
      confirmation_id: confirmationInput,
      for_person: z.string().min(1).max(120).describe("The person's name as the preview showed it"),
      location: z.string().min(1).max(80).describe("The location's name as the preview showed it"),
      details_confirmed: z
        .literal(true)
        .optional()
        .describe("true once the person confirmed the personalization details are correct; required when the request has personalized items"),
      details: DetailsInput.optional().describe("The personalization details exactly as confirm_details listed them; required when the request has personalized items"),
    })
    .strict(),
  async run(args, deps) {
    const p = deps.principal;
    if (!roleAtLeast(p.role, "manager")) {
      return fail("forbidden", FORBIDDEN);
    }
    // Hashed before the echo check, which is synchronous (Decision 12).
    const echoedHash = await detailsHash(args.details ?? []);
    const start = await beginConfirm<PlacePayload>(deps, {
      id: args.confirmation_id,
      tool: "place_request",
      echo: (stored) =>
        textMismatch("person", args.for_person, stored.forPerson) ??
        textMismatch("location", args.location, stored.location) ??
        detailsMismatch(stored, args.details_confirmed, echoedHash),
    });
    if (!start.ok) {
      return start.outcome;
    }
    const { action, payload, recheck } = start;
    if (!(await stateMatches(action, ""))) {
      await finishAction(deps.db, action.id, "failed", "changed");
      return fail("changed", "This confirmation does not match what was prepared. Prepare the request again.");
    }
    const granted = await shopifyAccess(deps.db, p.workspaceId, reviewDeps(deps));
    if (granted.kind !== "ok") {
      await finishAction(deps.db, action.id, recheck ? "unknown" : "failed", "no_access");
      return refusal(granted.status, granted.error);
    }
    const { access } = granted;
    const lookUp = async (): Promise<Record<string, unknown> | null> => {
      const found = await findDraftByMarker(access.shopDomain, access.token, payload.marker, access.fetchImpl);
      return found.kind === "ok" ? found.node : null;
    };
    if (recheck) {
      const node = await lookUp();
      if (node) {
        return land(deps, action, payload, node);
      }
      await finishAction(deps.db, action.id, "unknown", "not_found_yet");
      return fail("unknown_outcome", `Shopify still shows no request with the tag ${payload.marker}. Try again in a minute, or look for that tag in Shopify's draft orders.`);
    }
    const sent = await createRequestDraft(access.shopDomain, access.token, payload.input, access.fetchImpl);
    if (sent.kind === "ok") {
      const node = sent.node ?? (await lookUp());
      if (node) {
        return land(deps, action, payload, node);
      }
      await finishAction(deps.db, action.id, "done", "created_unread");
      return ok({ done: true, message: "Shopify created the request; it appears on the desk with the next sync." });
    }
    if (sent.kind !== "transient") {
      await finishAction(deps.db, action.id, "failed", "refused");
      return fail("refused", `Shopify did not create the request: ${plainText(failureText(sent), 300)}. Nothing was created.`);
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < REVIEW_READY_TRIES; attempt++) {
      await sleep(REVIEW_RETRY_MS);
      const node = await lookUp();
      if (node) {
        return land(deps, action, payload, node);
      }
    }
    await finishAction(deps.db, action.id, "unknown", "no_answer");
    return fail(
      "unknown_outcome",
      "Shopify did not answer, so it is not known whether the request was created. Ordering Desk never sends it twice: call confirm_place_request again with the same confirmation in a minute, and it will look for the request in Shopify.",
    );
  },
});
