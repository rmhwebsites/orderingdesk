// Read tools for cards (comprehensive desk design section 4): search_orders
// (Wave 1c's server search, with the same AI search for a plain question
// and the same validated filter for structured arguments), get_order and
// list_statuses. Relative imports only.

import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { locations, orderSearch } from "../../db/schema";
import { locationAddressLines } from "../../lib/address";
import { cleanText, DATE_PRESETS, EMPTY_QUERY, filterChips, type DeskQuery } from "../../lib/desk-query";
import { publicAttributes, requestFieldsOf } from "../../lib/request-fields";
import { AI_QUERY_MAX } from "../../lib/search-shortcut";
import { checkStatusMove } from "../../lib/status-rules";
import { viaLabel } from "../../lib/via";
import { listEvents, orderSummaryOf } from "../../server/desk/read";
import { aiSearch } from "../../server/search/ai-search";
import { validateAiFilter, type SearchVocabulary } from "../../server/search/ai-filter";
import { searchOrders as runSearch } from "../../server/search/query";
import { loadVocabulary } from "../../server/search/vocabulary";
import { SCOPE_WRITE } from "../constants";
import { iso, NAME_MAX, plainText, untrusted } from "../output";
import { actionsFor, cardLine, findCard, HIDDEN_CONTACT, isContactLabel, statusRowsOf } from "./cards";
import { READ, defineTool, fail, ok } from "./define";

const FILTER_KEYS = [
  "kind",
  "state",
  "status",
  "locations",
  "person",
  "item",
  "personalization",
  "order_number",
  "date",
  "from",
  "to",
  "older_than_days",
  "newer_than_days",
  "sort",
  "words",
] as const;

const SearchInput = z
  .object({
    question: z.string().min(1).max(AI_QUERY_MAX).optional().describe("A plain question about the cards, read by the desk's AI search"),
    kind: z.enum(["any", "requests", "orders", "deleted"]).optional().describe("requests wait for a decision; orders are approved or placed"),
    state: z.enum(["any", "open", "closed"]).optional(),
    status: z.string().max(80).optional().describe("A status name or key from list_statuses"),
    locations: z.array(z.string().max(80)).max(10).optional().describe("Company location names from list_locations"),
    person: z.string().max(60).optional().describe("Who ordered it, or who it is for"),
    item: z.string().max(60).optional().describe("An item title, other product words, or a SKU"),
    personalization: z.string().max(60).optional().describe("Text printed or embroidered on an item"),
    order_number: z.string().max(20).optional().describe("Like #1024, or #D19 for a request"),
    date: z.enum(["any", ...DATE_PRESETS, "custom"] as [string, ...string[]]).optional().describe("When it was placed"),
    from: z.string().max(10).optional().describe("YYYY-MM-DD, with date custom"),
    to: z.string().max(10).optional().describe("YYYY-MM-DD, with date custom"),
    older_than_days: z.number().int().min(0).max(365).optional().describe("In its current status for more than this many days"),
    newer_than_days: z.number().int().min(0).max(365).optional().describe("In its current status for fewer than this many days"),
    sort: z.enum(["newest", "oldest", "waiting"]).optional().describe("waiting: longest in its status first"),
    words: z.string().max(100).optional().describe("Other words to find"),
    limit: z.number().int().min(1).max(25).optional(),
    cursor: z.string().max(100).optional().describe("next_cursor from the previous page"),
  })
  .strict();

type SearchArgs = z.infer<typeof SearchInput>;

function structuredQuery(args: SearchArgs, vocab: SearchVocabulary): { query: DeskQuery } | { error: string } {
  const statusName = args.status === undefined ? null : (vocab.statuses.find((status) => status.key === args.status)?.label ?? args.status);
  const wantedItem = args.item?.trim().toLowerCase();
  const itemTitle = wantedItem ? (vocab.items.find((title) => title.toLowerCase() === wantedItem) ?? null) : null;
  const query = validateAiFilter(
    {
      kind: args.kind ?? "any",
      status: statusName,
      state: args.state ?? "any",
      locations: args.locations ?? [],
      person: args.person ?? null,
      itemTitle,
      itemText: itemTitle ? null : (args.item ?? null),
      personalization: args.personalization ?? null,
      orderNumber: args.order_number ?? null,
      date: args.date ?? "any",
      from: args.from ?? null,
      to: args.to ?? null,
      olderThanDays: args.older_than_days ?? null,
      newerThanDays: args.newer_than_days ?? null,
      sort: args.sort ?? "newest",
      text: args.words ?? null,
    },
    vocab,
  );
  if (!query) {
    return { error: "Those filters could not be read. Check the values against list_statuses and list_locations." };
  }
  if (statusName !== null && query.status === null) {
    return { error: `No status is called "${plainText(args.status, 80)}". Statuses: ${vocab.statuses.map((status) => status.label).join(", ")}.` };
  }
  if ((args.locations?.length ?? 0) !== query.locations.length) {
    return { error: `Unknown company location. Locations: ${vocab.locations.map((location) => location.name).join(", ")}.` };
  }
  if (args.date === "custom" && (query.from === null || query.to === null)) {
    return { error: "A custom date needs from and to as YYYY-MM-DD, from first, at most three years apart." };
  }
  return { query };
}

export const searchOrders = defineTool({
  name: "search_orders",
  title: "Search orders and requests",
  description:
    "Finds cards (employee requests and orders) over all history, newest first, 10 at a time. Takes either a plain question (read by the desk's AI search) or filters; with neither it lists open cards. Returns each card's number, kind, status, waiting days, requester, location and items.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: SearchInput,
  async run(args, deps) {
    const p = deps.principal;
    const now = deps.now();
    const structured = FILTER_KEYS.some((key) => args[key] !== undefined);
    if (args.question && structured) {
      return fail("invalid_input", "Send a question or filters, not both.");
    }
    const loaded = await loadVocabulary(deps.db, p.workspaceId);
    let query: DeskQuery;
    let understood: "question" | "keywords" | "filters" | "open cards";
    let fallback: string | null = null;
    if (args.question) {
      const outcome = await aiSearch(deps.db, deps.ai, { workspaceId: p.workspaceId, userId: p.userId, now }, { q: args.question });
      if (outcome.kind === "invalid") {
        return fail("invalid_input", outcome.error);
      }
      if (outcome.kind === "filter") {
        query = outcome.query;
        understood = "question";
      } else {
        query = { ...EMPTY_QUERY, view: "all", q: cleanText(args.question, AI_QUERY_MAX) };
        understood = "keywords";
        fallback = outcome.reason;
      }
    } else if (structured) {
      const checked = structuredQuery(args, loaded.vocab);
      if ("error" in checked) {
        return fail("invalid_input", checked.error);
      }
      query = checked.query;
      understood = "filters";
    } else {
      query = EMPTY_QUERY;
      understood = "open cards";
    }
    const page = await runSearch(deps.db, p.workspaceId, query, { now, timeZone: loaded.timeZone, limit: args.limit ?? 10, cursor: args.cursor ?? null });
    const statusByKey = new Map((await statusRowsOf(deps.db, p.workspaceId)).map((row) => [row.key, row]));
    return ok({
      total: page.total,
      shown: page.orders.length,
      next_cursor: page.nextCursor,
      understood_as: understood,
      ...(fallback ? { ai_search: `not used (${fallback}); searched the words instead` } : {}),
      filters: filterChips(query, { locations: loaded.vocab.locations, requesterName: null }).map((chip) => plainText(chip.label, 120)),
      cards: page.orders.map((entry) => cardLine(orderSummaryOf(entry.row, entry.locationName, entry.requesterId, entry.hasPo), statusByKey, now)),
    });
  },
});

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function lineOf(raw: unknown, index: number): Record<string, unknown> {
  const item = record(raw);
  return {
    line: index + 1,
    title: plainText(item.title, 160),
    variant: plainText(item.variant, 120) || null,
    sku: plainText(item.sku, 60) || null,
    quantity: typeof item.qty === "number" ? item.qty : null,
    personalization: publicAttributes(item.props).map((attribute) => ({
      label: plainText(attribute.key, 60),
      value: untrusted(isContactLabel(attribute.key) ? HIDDEN_CONTACT : attribute.value, 500),
    })),
  };
}

export const getOrder = defineTool({
  name: "get_order",
  title: "Get an order or request",
  description:
    "One card in full: status and waiting time, requester and request fields, company location and address, lines with personalization, the latest 20 timeline entries, and which prepare tools apply to it for you.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({ order: z.string().min(1).max(64).describe("An order number like #1024, a request number like #D19, or a card id") }).strict(),
  async run(args, deps) {
    const p = deps.principal;
    const now = deps.now();
    const card = await findCard(deps.db, p.workspaceId, args.order);
    if (!card) {
      return fail("not_found", `No order or request ${plainText(args.order, 64)} in ${plainText(p.workspaceName, 80)}.`);
    }
    const [statusRows, located, indexed, timeline] = await Promise.all([
      statusRowsOf(deps.db, p.workspaceId),
      card.locationId
        ? deps.db
            .select()
            .from(locations)
            .where(and(eq(locations.workspaceId, p.workspaceId), eq(locations.shopifyLocationId, card.locationId)))
            .limit(1)
        : Promise.resolve([]),
      deps.db.select({ requesterId: orderSearch.requesterId }).from(orderSearch).where(eq(orderSearch.orderId, card.id)).limit(1),
      listEvents(deps.db, p.workspaceId, card.id),
    ]);
    const location = located[0] ?? null;
    // The purchase order flag is not part of a card's line here.
    const summary = orderSummaryOf(card, location?.name ?? null, indexed[0]?.requesterId ?? null, false);
    const statusByKey = new Map(statusRows.map((row) => [row.key, row]));
    const snapshot = record(card.shopify);
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const fields = requestFieldsOf(card.shopify, card.draftSnapshot);
    const entries = timeline.kind === "ok" ? timeline.events.slice(0, 20) : [];
    return ok(
      {
        ...cardLine(summary, statusByKey, now),
        status_set: { at: iso(card.statusSetAt), by_you: card.statusSetBy === p.userId },
        requester_person_id: summary.requesterId,
        request_fields: fields.attributes.map((attribute) => ({
          label: plainText(attribute.key, 60),
          value: untrusted(isContactLabel(attribute.key) ? HIDDEN_CONTACT : attribute.value, 1000),
        })),
        location: location
          ? {
              id: location.shopifyLocationId,
              name: plainText(location.name, NAME_MAX),
              address: location.address ? locationAddressLines(location.address).map((line) => plainText(line, 200)) : [],
            }
          : null,
        lines: items.slice(0, 35).map(lineOf),
        items_truncated: summary.itemsTruncated,
        total: summary.total ? `${summary.total} ${summary.currency}` : null,
        note: untrusted(snapshot.note, 2000),
        cancelled: summary.cancelled,
        timeline: entries.map((event) => ({
          at: iso(event.createdAt),
          who: event.actorId
            ? event.actorId === p.userId
              ? "you"
              : plainText(event.actorName ?? "a team member", NAME_MAX)
            : event.source === "shopify"
              ? "Shopify"
              : "Ordering Desk",
          via: viaLabel(event),
          type: event.type,
          text: untrusted(event.text, 1000),
        })),
        you_can: actionsFor(p, card, p.scopes.includes(SCOPE_WRITE)),
      },
      { kind: "order", id: card.id },
    );
  },
});

const LINKS: Record<string, string> = {
  fulfilled: "Shopify fulfillment (moving an order here fulfills it in Shopify)",
  delivered: "Shopify delivery",
  draft_completed: "Approve",
  draft_rejected: "Reject",
  cancelled: "Cancel",
};

export const listStatuses = defineTool({
  name: "list_statuses",
  title: "List statuses",
  description: "The workspace's statuses in order: name and key, whether it is closed, what sets it, and whether requests and orders may be moved into it with a status change.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({}).strict(),
  async run(_args, deps) {
    const p = deps.principal;
    const rows = await statusRowsOf(deps.db, p.workspaceId);
    return ok({
      statuses: rows.map((row) => ({
        key: row.key,
        name: plainText(row.label, 80),
        closed: row.closed,
        set_by: row.shopifyLink ? (LINKS[row.shopifyLink] ?? row.shopifyLink) : null,
        requests_can_move_here: checkStatusMove({ isDraft: true, role: p.role, current: undefined, target: row }).ok,
        orders_can_move_here: checkStatusMove({ isDraft: false, role: p.role, current: undefined, target: row }).ok,
      })),
    });
  },
});
