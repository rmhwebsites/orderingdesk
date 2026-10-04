import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { canCreateAccount } from "@/server/access";
import { encryptSecret } from "@/server/crypto";
import { claimAccessOnSignIn } from "@/server/invites";
import { approveRosterEntry, denyRosterEntry, listRosterRequests } from "@/server/roster";
import { openTestDb, seedMember, seedRosterEntry, seedUser, seedWorkspace } from "@/server/desk/test-helpers";
import { deleteConnection } from "@/server/desk/connection";
import { applyRosterCustomer, rosterRoleFor, syncRoster } from "./roster-sync";

// Tagged Shopify customers as workspace members (platform amendment
// section 2). A tag only asks for access: any storefront visitor can create
// a customer with tags (the newsletter form's contact[tags]), so a manager
// approves each (workspace, email, role) once. Stubbed fetch only.

const WS = "ws_impact";
const OTHER = "ws_other";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { ENCRYPTION_KEY: KEY } as CloudflareEnv;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const DEFAULT_TAGS = { manager: "Ordering Desk Manager", staff: "Ordering Desk Staff" };

async function setup(opts: { connection?: "legacy" | "disabled" | "none" } = {}) {
  const { db } = openTestDb();
  await seedWorkspace(db, WS);
  await seedWorkspace(db, OTHER);
  if ((opts.connection ?? "legacy") !== "none") {
    await db.insert(schema.storeConnections).values({
      workspaceId: WS,
      shopDomain: "impact-rentals.myshopify.com",
      encryptedToken: await encryptSecret("shpat_roster_token", KEY, WS),
      status: opts.connection === "disabled" ? "disabled" : "ok",
    });
  }
  return db;
}

async function roster(db: Db, workspaceId = WS) {
  const rows = await db
    .select({ email: schema.shopifyRoster.email, role: schema.shopifyRoster.role, customerId: schema.shopifyRoster.shopifyCustomerId })
    .from(schema.shopifyRoster)
    .where(eq(schema.shopifyRoster.workspaceId, workspaceId));
  return rows.sort((a, b) => a.email.localeCompare(b.email));
}

async function membership(db: Db, userId: string, workspaceId = WS) {
  const rows = await db
    .select({ role: schema.workspaceMembers.role, source: schema.workspaceMembers.source })
    .from(schema.workspaceMembers)
    .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, userId)));
  return rows[0];
}

const customer = (customerId: string, email: string | null, tags: string[]) => ({ customerId, email, tags });

async function rosterIdOf(db: Db, email: string, workspaceId = WS) {
  const rows = await db
    .select({ id: schema.shopifyRoster.id })
    .from(schema.shopifyRoster)
    .where(and(eq(schema.shopifyRoster.workspaceId, workspaceId), eq(schema.shopifyRoster.email, email)));
  if (!rows[0]) {
    throw new Error(`no roster entry for ${email}`);
  }
  return rows[0].id;
}

// What a manager's Approve and Deny do (src/server/roster.ts).
async function approve(db: Db, email: string, workspaceId = WS) {
  const rosterId = await rosterIdOf(db, email, workspaceId);
  return approveRosterEntry(db, { workspaceId, rosterId, approverId: "u_manager" }, {}, { now: NOW });
}

async function deny(db: Db, email: string, workspaceId = WS) {
  return denyRosterEntry(db, { workspaceId, rosterId: await rosterIdOf(db, email, workspaceId) }, { now: NOW });
}

async function waitingEmails(db: Db, workspaceId = WS) {
  return (await listRosterRequests(db, workspaceId)).waiting.map((entry) => [entry.email, entry.role, entry.currentRole]);
}

describe("rosterRoleFor", () => {
  it("reads the role from the workspace's tags, manager winning", () => {
    expect(rosterRoleFor(["vip", "Ordering Desk Staff"], DEFAULT_TAGS)).toBe("staff");
    expect(rosterRoleFor(["Ordering Desk Manager"], DEFAULT_TAGS)).toBe("manager");
    expect(rosterRoleFor(["Ordering Desk Staff", "Ordering Desk Manager"], DEFAULT_TAGS)).toBe("manager");
    // Shopify treats tags without regard to case.
    expect(rosterRoleFor([" ordering desk staff "], DEFAULT_TAGS)).toBe("staff");
    expect(rosterRoleFor(["Ordering Desk"], DEFAULT_TAGS)).toBeNull();
    expect(rosterRoleFor([], DEFAULT_TAGS)).toBeNull();
    expect(rosterRoleFor(["Crew Lead"], { manager: "Crew Lead", staff: "Crew" })).toBe("manager");
  });
});

describe("applyRosterCustomer", () => {
  it("puts a tagged customer on the roster as waiting, granting nothing until a manager approves", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    expect(await roster(db)).toEqual([{ email: "jo@impact.example", role: "staff", customerId: "501" }]);
    expect(await membership(db, "u_jo")).toBeUndefined();
    expect(await waitingEmails(db)).toEqual([["jo@impact.example", "staff", null]]);

    // Approving gives an existing user the membership at once.
    expect(await approve(db, "jo@impact.example")).toEqual({ kind: "approved", email: "jo@impact.example", role: "staff" });
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "shopify" });
    expect(await membership(db, "u_jo", OTHER)).toBeUndefined();
    expect(await waitingEmails(db)).toEqual([]);
  });

  // The storefront attack: a stranger tags their own new customer with the
  // manager tag. Nothing follows from it until a manager approves.
  it("gives a storefront-tagged stranger no account route and no membership until approved", async () => {
    const db = await setup();
    await applyRosterCustomer(db, WS, "502", customer("502", "new.person@impact.example", ["Ordering Desk Manager"]), NOW);
    expect(await roster(db)).toEqual([{ email: "new.person@impact.example", role: "manager", customerId: "502" }]);
    expect(await canCreateAccount(db, {}, "new.person@impact.example")).toBe(false);
    // Even with an account from somewhere else, sign-in grants nothing here.
    await seedUser(db, "u_new", "new.person@impact.example");
    await claimAccessOnSignIn(db, "u_new", "new.person@impact.example");
    expect(await membership(db, "u_new")).toBeUndefined();

    await approve(db, "new.person@impact.example");
    expect(await canCreateAccount(db, {}, "new.person@impact.example")).toBe(true);
    expect(await membership(db, "u_new")).toEqual({ role: "manager", source: "shopify" });
  });

  it("needs a new approval to raise a role, keeping the old role meanwhile, and lowers at once", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    await approve(db, "jo@impact.example");

    // Staff to manager: the membership stays staff and the raise waits.
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff", "Ordering Desk Manager"]), NOW + 1);
    expect(await roster(db)).toEqual([{ email: "jo@impact.example", role: "manager", customerId: "501" }]);
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "shopify" });
    expect(await waitingEmails(db)).toEqual([["jo@impact.example", "manager", "staff"]]);
    // A sign-in meanwhile grants the approved role only.
    await claimAccessOnSignIn(db, "u_jo", "jo@impact.example");
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "shopify" });

    await approve(db, "jo@impact.example");
    expect(await membership(db, "u_jo")).toEqual({ role: "manager", source: "shopify" });

    // Manager to staff applies at once, with no approval.
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW + 2);
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "shopify" });
    expect(await waitingEmails(db)).toEqual([]);

    // And raising again needs approving again.
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW + 3);
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "shopify" });
    expect(await waitingEmails(db)).toEqual([["jo@impact.example", "manager", "staff"]]);
  });

  it("keeps an earlier staff approval when a raise that never got approved is taken back", async () => {
    const db = await setup();
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    await approve(db, "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW + 1);
    // Not signed up yet: the staff approval still opens an account.
    expect(await canCreateAccount(db, {}, "jo@impact.example")).toBe(true);
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW + 2);
    expect(await waitingEmails(db)).toEqual([]);
    expect(await canCreateAccount(db, {}, "jo@impact.example")).toBe(true);
  });

  it("removes the roster row, its approval and the shopify membership when the tag goes or the customer is deleted", async () => {
    for (const next of [customer("501", "jo@impact.example", ["vip"]), null]) {
      const db = await setup();
      await seedUser(db, "u_jo", "jo@impact.example");
      expect(await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW)).toEqual([]);
      await approve(db, "jo@impact.example");
      // The user whose access went, so their open sockets can be closed.
      expect(await applyRosterCustomer(db, WS, "501", next, NOW + 1)).toEqual(["u_jo"]);
      expect(await roster(db)).toEqual([]);
      expect(await membership(db, "u_jo")).toBeUndefined();

      // Tagged again later: a fresh request, waiting for a fresh approval.
      await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW + 2);
      expect(await membership(db, "u_jo")).toBeUndefined();
      expect(await waitingEmails(db)).toEqual([["jo@impact.example", "staff", null]]);
    }
  });

  it("keeps a denied entry denied through tag changes, until the tag is removed and added again", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    expect(await deny(db, "jo@impact.example")).toEqual({ kind: "denied", revokedUserId: null });
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW + 1);
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW + 2);
    const requests = await listRosterRequests(db, WS);
    expect(requests.waiting).toEqual([]);
    expect(requests.denied.map((entry) => [entry.email, entry.role])).toEqual([["jo@impact.example", "manager"]]);
    expect(await membership(db, "u_jo")).toBeUndefined();

    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["vip"]), NOW + 3);
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW + 4);
    expect(await waitingEmails(db)).toEqual([["jo@impact.example", "staff", null]]);
    expect((await listRosterRequests(db, WS)).denied).toEqual([]);
  });

  it("denying takes away every shopify membership for the email here, a pending raise included", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    await approve(db, "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW + 1);
    expect(await deny(db, "jo@impact.example")).toEqual({ kind: "denied", revokedUserId: "u_jo" });
    expect(await membership(db, "u_jo")).toBeUndefined();
    expect(await canCreateAccount(db, {}, "jo@impact.example")).toBe(false);
  });

  // A manager's invite outranks a tag: the roster never touches it.
  it("never touches a manual membership, granting, approving, denying or removing", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await seedMember(db, WS, "u_jo", "staff", "manual");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW);
    await approve(db, "jo@impact.example");
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "manual" });
    expect(await deny(db, "jo@impact.example")).toEqual({ kind: "denied", revokedUserId: null });
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "manual" });
    expect(await applyRosterCustomer(db, WS, "501", null, NOW + 1)).toEqual([]);
    expect(await roster(db)).toEqual([]);
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "manual" });
  });

  it("moves the request to the new email when the customer's email changes, which needs approving again", async () => {
    const db = await setup();
    await seedUser(db, "u_old", "old@impact.example");
    await seedUser(db, "u_new", "new@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "old@impact.example", ["Ordering Desk Staff"]), NOW);
    await approve(db, "old@impact.example");
    expect(await applyRosterCustomer(db, WS, "501", customer("501", "new@impact.example", ["Ordering Desk Staff"]), NOW + 1)).toEqual([
      "u_old",
    ]);
    expect(await roster(db)).toEqual([{ email: "new@impact.example", role: "staff", customerId: "501" }]);
    expect(await membership(db, "u_old")).toBeUndefined();
    expect(await membership(db, "u_new")).toBeUndefined();
    await approve(db, "new@impact.example");
    expect(await membership(db, "u_new")).toEqual({ role: "staff", source: "shopify" });
  });

  // A different customer with the email means the old one was deleted (a
  // missed customers/delete): it starts over like any new request.
  it("starts over when the same email comes back on another customer", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    await approve(db, "jo@impact.example");
    expect(await applyRosterCustomer(db, WS, "777", customer("777", "jo@impact.example", ["Ordering Desk Staff"]), NOW + 1)).toEqual([
      "u_jo",
    ]);
    expect(await membership(db, "u_jo")).toBeUndefined();
    expect(await waitingEmails(db)).toEqual([["jo@impact.example", "staff", null]]);
  });

  it("only touches its own workspace, and skips a customer without an email", async () => {
    const db = await setup();
    // Roster writes only happen for a connected store (a webhook or the
    // sync), and one that finds its store disconnected takes itself back.
    await db.insert(schema.storeConnections).values({
      workspaceId: OTHER,
      shopDomain: "other-store.myshopify.com",
      encryptedToken: await encryptSecret("shpat_other_token", KEY, OTHER),
      status: "ok",
    });
    await seedUser(db, "u_jo", "jo@impact.example");
    await applyRosterCustomer(db, OTHER, "9", customer("9", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    await approve(db, "jo@impact.example", OTHER);
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW);
    await approve(db, "jo@impact.example");
    await applyRosterCustomer(db, WS, "501", null, NOW + 1);
    expect(await roster(db, OTHER)).toHaveLength(1);
    expect(await membership(db, "u_jo", OTHER)).toEqual({ role: "staff", source: "shopify" });
    await applyRosterCustomer(db, WS, "777", customer("777", null, ["Ordering Desk Manager"]), NOW);
    expect(await roster(db)).toEqual([]);
  });

  it("takes back every tag-based access when the store is no longer connected", async () => {
    const db = await setup({ connection: "disabled" });
    await seedUser(db, "u_jo", "jo@impact.example");
    await seedRosterEntry(db, { workspaceId: WS, email: "jo@impact.example", role: "staff", customerId: "501", state: "approved" });
    await seedMember(db, WS, "u_jo", "staff", "shopify");
    const revoked = await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW);
    expect(revoked).toEqual(["u_jo"]);
    expect(await roster(db)).toEqual([]);
    expect(await membership(db, "u_jo")).toBeUndefined();
  });

  it("uses the workspace's own tag names", async () => {
    const db = await setup();
    await db
      .update(schema.workspaces)
      .set({ rosterTags: { manager: "Crew Lead", staff: "Crew" } })
      .where(eq(schema.workspaces.id, WS));
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Manager"]), NOW);
    expect(await roster(db)).toEqual([]);
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Crew"]), NOW);
    expect(await roster(db)).toEqual([{ email: "jo@impact.example", role: "staff", customerId: "501" }]);
  });
});

type Query = { query: string; variables: Record<string, unknown> };

// Serves customer pages in order; an Error entry answers HTTP 503.
function customerPages(pages: Array<Array<{ id: string; email: string | null; tags: string[] }> | Error>) {
  const calls: Query[] = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Query;
    calls.push(body);
    const index = calls.length - 1;
    const page = pages[index];
    if (!page || page instanceof Error) {
      return new Response("{}", { status: 503 });
    }
    return new Response(
      JSON.stringify({
        data: {
          customers: {
            nodes: page,
            pageInfo: { hasNextPage: index < pages.length - 1, endCursor: index < pages.length - 1 ? `cursor-${index + 1}` : null },
          },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { impl, calls };
}

const node = (id: number, email: string | null, tags: string[]) => ({ id: `gid://shopify/Customer/${id}`, email, tags });

describe("syncRoster", () => {
  it("pages through the tagged customers and reconciles the roster with them", async () => {
    const db = await setup();
    await seedUser(db, "u_gone", "gone@impact.example");
    await seedUser(db, "u_jo", "jo@impact.example");
    await applyRosterCustomer(db, WS, "400", customer("400", "gone@impact.example", ["Ordering Desk Staff"]), NOW - 1);
    await approve(db, "gone@impact.example");
    const shop = customerPages([
      [node(501, "Jo@Impact.example", ["Ordering Desk Staff"]), node(502, "lee@impact.example", ["Ordering Desk Manager"])],
      [node(503, "sam@impact.example", ["Ordering Desk Staff", "Ordering Desk Manager"]), node(504, null, ["Ordering Desk Staff"])],
    ]);
    const result = await syncRoster(db, env, WS, { fetchImpl: shop.impl, now: () => NOW });
    expect(result).toEqual({ kind: "ok", complete: true, entries: 3, removed: 1, revokedUserIds: ["u_gone"] });

    expect(shop.calls.map((call) => call.variables)).toEqual([
      { cursor: null, search: 'tag:"Ordering Desk Manager" OR tag:"Ordering Desk Staff"' },
      { cursor: "cursor-1", search: 'tag:"Ordering Desk Manager" OR tag:"Ordering Desk Staff"' },
    ]);
    expect(await roster(db)).toEqual([
      { email: "jo@impact.example", role: "staff", customerId: "501" },
      { email: "lee@impact.example", role: "manager", customerId: "502" },
      { email: "sam@impact.example", role: "manager", customerId: "503" },
    ]);
    // New entries wait for a manager; the removed one lost its membership.
    expect(await membership(db, "u_jo")).toBeUndefined();
    expect((await waitingEmails(db)).map(([email]) => email)).toEqual([
      "jo@impact.example",
      "lee@impact.example",
      "sam@impact.example",
    ]);
    expect(await membership(db, "u_gone")).toBeUndefined();
  });

  it("keeps approvals across runs, lowers a role at once and holds a raise for approval", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await seedUser(db, "u_lee", "lee@impact.example");
    const run = (pages: Parameters<typeof customerPages>[0]) =>
      syncRoster(db, env, WS, { fetchImpl: customerPages(pages).impl, now: () => NOW });
    await run([[node(501, "jo@impact.example", ["Ordering Desk Staff"]), node(502, "lee@impact.example", ["Ordering Desk Manager"])]]);
    await approve(db, "jo@impact.example");
    await approve(db, "lee@impact.example");
    await run([[node(501, "jo@impact.example", ["Ordering Desk Staff"]), node(502, "lee@impact.example", ["Ordering Desk Manager"])]]);
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "shopify" });
    expect(await membership(db, "u_lee")).toEqual({ role: "manager", source: "shopify" });
    expect(await waitingEmails(db)).toEqual([]);

    await run([[node(501, "jo@impact.example", ["Ordering Desk Manager"]), node(502, "lee@impact.example", ["Ordering Desk Staff"])]]);
    expect(await membership(db, "u_jo")).toEqual({ role: "staff", source: "shopify" });
    expect(await membership(db, "u_lee")).toEqual({ role: "staff", source: "shopify" });
    expect(await waitingEmails(db)).toEqual([["jo@impact.example", "manager", "staff"]]);
  });

  it("only adds when it could not read every page", async () => {
    const db = await setup();
    await applyRosterCustomer(db, WS, "400", customer("400", "keep@impact.example", ["Ordering Desk Staff"]), NOW - 1);
    const shop = customerPages([[node(501, "jo@impact.example", ["Ordering Desk Staff"])], new Error("down")]);
    expect(await syncRoster(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toEqual({
      kind: "ok",
      complete: false,
      entries: 1,
      removed: 0,
      revokedUserIds: [],
    });
    expect((await roster(db)).map((row) => row.email)).toEqual(["jo@impact.example", "keep@impact.example"]);
  });

  it("changes nothing when Shopify cannot be read at all", async () => {
    const db = await setup();
    await applyRosterCustomer(db, WS, "400", customer("400", "keep@impact.example", ["Ordering Desk Staff"]), NOW - 1);
    expect(await syncRoster(db, env, WS, { fetchImpl: customerPages([new Error("down")]).impl, now: () => NOW })).toEqual({
      kind: "failed",
      detail: "Shopify responded with HTTP 503",
    });
    expect(await roster(db)).toHaveLength(1);
  });

  it("never removes a manual membership", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await seedMember(db, WS, "u_jo", "manager", "manual");
    await applyRosterCustomer(db, WS, "501", customer("501", "jo@impact.example", ["Ordering Desk Staff"]), NOW - 1);
    expect(await syncRoster(db, env, WS, { fetchImpl: customerPages([[]]).impl, now: () => NOW })).toMatchObject({
      kind: "ok",
      removed: 1,
      revokedUserIds: [],
    });
    expect(await roster(db)).toEqual([]);
    expect(await membership(db, "u_jo")).toEqual({ role: "manager", source: "manual" });
  });

  // The roster writes after a slow Shopify read; if the store was
  // disconnected meanwhile (which clears every tag-based access), what the
  // run wrote is taken back, so nothing tag-based survives a disconnect.
  it("takes back what it granted when the store was disconnected while it read Shopify", async () => {
    const db = await setup();
    await seedUser(db, "u_jo", "jo@impact.example");
    await seedRosterEntry(db, { workspaceId: WS, email: "jo@impact.example", role: "staff", customerId: "501", state: "approved" });
    const shop = customerPages([[node(501, "jo@impact.example", ["Ordering Desk Manager"])]]);
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await deleteConnection(db, WS);
      // Granted again behind the disconnect's back (an approval landing).
      await seedRosterEntry(db, { workspaceId: WS, email: "jo@impact.example", role: "staff", customerId: "501", state: "approved" });
      await seedMember(db, WS, "u_jo", "staff", "shopify");
      return shop.impl(input, init);
    }) as typeof fetch;
    const result = await syncRoster(db, env, WS, { fetchImpl: racing, now: () => NOW });
    expect(result).toMatchObject({ kind: "ok", revokedUserIds: ["u_jo"] });
    expect(await roster(db)).toEqual([]);
    expect(await membership(db, "u_jo")).toBeUndefined();
  });

  it("skips a workspace without a connected store", async () => {
    for (const connection of ["none", "disabled"] as const) {
      const db = await setup({ connection });
      const shop = customerPages([[]]);
      expect(await syncRoster(db, env, WS, { fetchImpl: shop.impl, now: () => NOW })).toEqual({ kind: "skipped" });
      expect(shop.calls).toHaveLength(0);
    }
  });
});
