import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventView, StatusView } from "@/server/desk/shapes";
import { draftSnapshotOf } from "@/server/desk/test-helpers";
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

function render(opts: { order?: DrawerOrder; timeline?: EventView[]; members?: MemberView[] } = {}) {
  return renderToStaticMarkup(
    createElement(OrderDrawerContent, {
      labelId: "drawer-title",
      orderId: "d1",
      summary: undefined,
      detail: { status: "ready", order: opts.order ?? draftCard(), itemsTruncated: false },
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
      onClose: noop,
      onRetry: noop,
      canManagePos: true,
      poRefreshKey: 0,
      onCreatePo: noop,
      onEditPo: noop,
    }),
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
    expect(deleted).not.toContain(">Open<");

    const open = render();
    expect(open).toContain(">Open<");
    expect(open).not.toContain(">Deleted in Shopify<");
  });
});
