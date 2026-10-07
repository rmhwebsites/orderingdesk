import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, StatusView } from "@/server/desk/shapes";
import { draftSnapshotOf, snapshotOf } from "@/server/desk/test-helpers";
import { ToastProvider } from "@/components/toasts";
import { OrderDrawerContent, type DrawerOrder, type MemberView } from "./order-drawer";

// The request drawer as a manager or platform admin sees it (draft orders
// spec sections 11.3 and 11.6).
const NOW = Date.parse("2026-10-05T15:00:00.000Z");
const SELF = "u_self";
const ADMIN = "u_ryan";

const STATUSES: StatusView[] = [
  { key: "new", label: "New", color: "lime", sort: 0, triggersPo: false, shopifyLink: null, closed: false },
  { key: "approved", label: "Approved", color: "green", sort: 1, triggersPo: false, shopifyLink: "draft_completed", closed: false },
  { key: "rejected", label: "Rejected", color: "pink", sort: 2, triggersPo: false, shopifyLink: "draft_rejected", closed: true },
];

function draftCard(overrides: Partial<DrawerOrder> = {}): DrawerOrder {
  return {
    id: "d1",
    shopifyOrderId: null,
    name: "#D12",
    shopify: draftSnapshotOf(),
    statusKey: "rejected",
    statusSetBy: ADMIN,
    statusSetAt: NOW - 60000,
    createdAt: NOW - 3600000,
    shopifyDraftId: "12",
    draftName: "#D12",
    draftSnapshot: null,
    draftDeletedAt: null,
    locationId: null,
    ...overrides,
  };
}

function statusEvent(overrides: Partial<EventView> = {}): EventView {
  return {
    id: "e1",
    orderId: "d1",
    type: "status",
    text: "Rejected the request. Status set to Rejected",
    actorId: ADMIN,
    meta: { from: "new", to: "rejected", action: "reject" },
    createdAt: NOW - 60000,
    source: "app",
    ...overrides,
  };
}

const noop = () => {};
const none = async () => null;

function render(
  opts: {
    order?: DrawerOrder;
    timeline?: EventView[];
    members?: MemberView[];
    requesterId?: string | null;
    extra?: Record<string, unknown>;
  } = {},
) {
  return renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(OrderDrawerContent, {
        labelId: "drawer-title",
        orderId: "d1",
        summary: undefined,
        detail: { status: "ready", order: opts.order ?? draftCard(), itemsTruncated: false, location: null, requesterId: opts.requesterId ?? null },
        timeline: opts.timeline ?? [],
        timelineStatus: "ready",
        statuses: STATUSES,
        members: new Map((opts.members ?? []).map((member) => [member.userId, member])),
        selfUserId: SELF,
        role: "manager",
        shopDomain: "impactrentals.myshopify.com",
        drafts: { draftsEnabled: true },
        onChangeStatus: noop,
        onAddNote: none,
        onApprove: none,
        onReject: none,
        onCancelOrder: none,
        onEditRequest: async () => ({ warning: null }),
        onClose: noop,
        onRetry: noop,
        canManagePos: true,
        poRefreshKey: 0,
        onCreatePo: noop,
        onEditPo: noop,
        basePath: "/w/impact",
        ...(opts.extra ?? {}),
      }),
    ),
  );
}

describe("OrderDrawerContent", () => {
  it("names a platform admin who is not a member in the timeline and the status line", () => {
    const html = render({
      timeline: [
        { ...statusEvent(), actorName: "Ryan Hale" },
        {
          ...statusEvent({ id: "e2", type: "note", text: "Duplicate of #D11", meta: { rejectReason: true } }),
          actorName: "Ryan Hale",
        },
      ],
    });
    expect(html).not.toContain("Former member");
    expect(html).not.toContain("former member");
    expect(html.match(/>Ryan Hale</g)).toHaveLength(2);
    expect(html).toContain("Status set by Ryan Hale,");
  });

  it("prefers the member list, and still says former member when nobody can be named", () => {
    const member: MemberView = { userId: ADMIN, role: "manager", email: "ryan@example.com", name: "Ryan H." };
    const named = render({ timeline: [{ ...statusEvent(), actorName: "Ryan Hale" }], members: [member] });
    expect(named).toContain(">Ryan H.<");
    expect(named).toContain("Status set by Ryan H.,");

    const gone = render({ timeline: [{ ...statusEvent(), actorName: null }] });
    expect(gone).toContain(">Former member<");
    expect(gone).toContain("Status set by a former member,");

    // The status line takes the name from the entry that set the status,
    // not from someone else's.
    const other = render({ timeline: [{ ...statusEvent({ actorId: "u_other" }), actorName: "Sam Ortiz" }] });
    expect(other).toContain("Status set by a former member,");
  });

  it("shows only Deleted in Shopify, never the Open draft status, for a draft Shopify deleted", () => {
    const deleted = render({ order: draftCard({ draftDeletedAt: NOW - 5000 }) });
    expect(deleted).toContain(">Deleted in Shopify<");
    expect(deleted).not.toContain("Draft open");

    const open = render();
    expect(open).toContain("· Draft open");
    expect(open).not.toContain(">Deleted in Shopify<");
  });

  it("offers Approve and next for the next request waiting", () => {
    const html = render({
      order: draftCard({ statusKey: "new" }),
      extra: { nextRequest: { id: "d13", name: "#D13" }, onApproveAndNext: async () => null },
    });
    expect(html).toContain(">Approve and next<");
  });

  it("hides the Paid chip and a $0 order's totals when prices are hidden", () => {
    const order = draftCard({
      shopifyOrderId: "5001",
      name: "#1001",
      shopify: snapshotOf({ total: "0.00", currency: "USD" }),
      statusKey: "new",
      draftName: null,
      shopifyDraftId: null,
    });
    const shown = render({ order, extra: { showPrices: true } });
    expect(shown).toContain(">Paid</span>");
    expect(shown).toContain("Order total");
    const hidden = render({ order, extra: { showPrices: false } });
    expect(hidden).not.toContain(">Paid</span>");
    expect(hidden).not.toContain("Order total");
  });

  it("quotes the rejection reason with who rejected the request", () => {
    const html = render({
      timeline: [
        { ...statusEvent(), actorName: "Ryan Hale" },
        { ...statusEvent({ id: "e2", type: "note", text: "Duplicate of #D11", meta: { rejectReason: true } }), actorName: "Ryan Hale" },
      ],
    });
    expect(html).toContain(">Duplicate of #D11</blockquote>");
    expect(html).toContain("Rejected by Ryan Hale,");
  });

  it("keeps the decision and the status in a footer within reach, and the header's status row from sm", () => {
    const html = render({ order: draftCard({ statusKey: "new" }) });
    const footer = html.match(/<footer[\s\S]*<\/footer>/)?.[0] ?? "";
    expect(footer).toContain(">Approve<");
    expect(footer).toContain(">Reject<");
    expect(footer).toMatch(/<div class="flex flex-wrap items-center gap-2 sm:hidden"><span data-tone/);
    const header = html.match(/<header[\s\S]*<\/header>/)?.[0] ?? "";
    expect(header).toContain("hidden flex-wrap items-center gap-2 sm:flex");
    expect(html.match(/>Approve</g)).toHaveLength(1);
  });

  it("gives staff the phone footer with the status alone", () => {
    const html = render({ order: draftCard({ statusKey: "new" }), extra: { role: "staff" } });
    expect(html.match(/<footer[^>]*>/)?.[0]).toContain("sm:hidden");
    expect(html).not.toContain(">Approve<");
  });
});

describe("OrderDrawerContent requester", () => {
  it("links the requester of a request and the customer of an order to their page", () => {
    const request = render({ order: draftCard({ statusKey: "new", statusSetBy: null }), requesterId: "p1" });
    expect(request).toMatch(/<a[^>]*href="\/w\/impact\/people\/p1"[^>]*>Jordan Vale<\/a>/);
    const order = render({
      order: draftCard({ id: "o1", shopifyOrderId: "5001", name: "#1001", shopify: snapshotOf(), statusKey: "new", statusSetBy: null, shopifyDraftId: null, draftName: null }),
      requesterId: "p2",
    });
    expect(order).toMatch(/<a[^>]*href="\/w\/impact\/people\/p2"[^>]*>Riley Oakes<\/a>/);
    expect(render({ order: draftCard({ statusKey: "new", statusSetBy: null }) })).not.toContain("/people/");
  });
});
