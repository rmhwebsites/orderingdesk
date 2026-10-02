import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedWorkspace } from "./desk/test-helpers";
import { checkCustomDomain, clearCustomDomain, normalizeDomain, setCustomDomain } from "./domains";

const ENV = { APP_URL: "https://orderingdesk.test" };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_other");
  return db;
}

async function row(db: Db, id = "ws_impact") {
  const [found] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
  return found;
}

async function verifySender(db: Db, id = "ws_impact") {
  await db.update(schema.workspaces).set({ sendingVerifiedAt: 123 }).where(eq(schema.workspaces.id, id));
}

describe("normalizeDomain", () => {
  it("accepts a host name and stores it lowercased and trimmed", () => {
    expect(normalizeDomain(" Orders.ImpactRentals.Store ", ENV)).toEqual({ ok: true, domain: "orders.impactrentals.store" });
    expect(normalizeDomain("orders.my-shop.co.uk", ENV)).toEqual({ ok: true, domain: "orders.my-shop.co.uk" });
  });

  it("refuses a scheme, a path, a port and anything that is not a host name", () => {
    const refused = [
      "https://orders.example.com",
      "orders.example.com/",
      "orders.example.com/path",
      "orders.example.com:8443",
      "orders example.com",
      "ryan@example.com",
      "localhost",
      "",
      "   ",
      "-orders.example.com",
      "orders-.example.com",
      "orders..example.com",
      "orders.example.com.",
      "1.2.3.4",
      "orders.exa_mple.com",
      `${"a".repeat(64)}.example.com`,
      `${"abcdefghi.".repeat(26)}com`,
      42,
      null,
    ];
    for (const value of refused) {
      const result = normalizeDomain(value, ENV);
      expect(result.ok, String(value)).toBe(false);
    }
  });

  it("refuses the hub host itself", () => {
    const result = normalizeDomain("OrderingDesk.test", ENV);
    expect(result.ok).toBe(false);
  });
});

describe("setCustomDomain", () => {
  it("saves the domain as pending and clears a verified sender when the domain changes", async () => {
    const db = await setup();
    await verifySender(db);
    const result = await setCustomDomain(db, ENV, "ws_impact", { domain: "Orders.ImpactRentals.Store" });
    expect(result).toEqual({ kind: "saved", domain: { domain: "orders.impactrentals.store", status: "pending" } });
    const saved = await row(db);
    expect(saved.customDomain).toBe("orders.impactrentals.store");
    expect(saved.customDomainStatus).toBe("pending");
    expect(saved.sendingVerifiedAt).toBeNull();
  });

  it("keeps the sender verification when the same domain is saved again, but asks for a new check", async () => {
    const db = await setup();
    await db
      .update(schema.workspaces)
      .set({ customDomain: "orders.impactrentals.store", customDomainStatus: "active", sendingVerifiedAt: 123 })
      .where(eq(schema.workspaces.id, "ws_impact"));
    await setCustomDomain(db, ENV, "ws_impact", { domain: "orders.impactrentals.store" });
    const saved = await row(db);
    expect(saved.customDomainStatus).toBe("pending");
    expect(saved.sendingVerifiedAt).toBe(123);
  });

  it("refuses a domain another workspace uses", async () => {
    const db = await setup();
    await setCustomDomain(db, ENV, "ws_other", { domain: "orders.impactrentals.store" });
    const result = await setCustomDomain(db, ENV, "ws_impact", { domain: "ORDERS.impactrentals.store" });
    expect(result).toEqual({ kind: "taken", error: "Another workspace already uses that domain" });
    expect((await row(db)).customDomain).toBeNull();
  });

  it("refuses bad input and the hub host without touching the row", async () => {
    const db = await setup();
    for (const body of [{ domain: "https://orders.example.com" }, { domain: "orderingdesk.test" }, {}, null]) {
      const result = await setCustomDomain(db, ENV, "ws_impact", body);
      expect(result.kind).toBe("invalid");
    }
    expect((await row(db)).customDomain).toBeNull();
  });

  it("answers not-found for a missing workspace", async () => {
    const db = await setup();
    expect(await setCustomDomain(db, ENV, "ws_missing", { domain: "orders.example.com" })).toEqual({ kind: "not-found" });
  });
});

describe("clearCustomDomain", () => {
  it("clears the domain, its status and the sender verification", async () => {
    const db = await setup();
    await db
      .update(schema.workspaces)
      .set({ customDomain: "orders.impactrentals.store", customDomainStatus: "active", sendingVerifiedAt: 123 })
      .where(eq(schema.workspaces.id, "ws_impact"));
    expect(await clearCustomDomain(db, "ws_impact")).toEqual({ kind: "cleared" });
    const cleared = await row(db);
    expect(cleared.customDomain).toBeNull();
    expect(cleared.customDomainStatus).toBeNull();
    expect(cleared.sendingVerifiedAt).toBeNull();
    expect(await clearCustomDomain(db, "ws_missing")).toEqual({ kind: "not-found" });
  });
});

describe("checkCustomDomain", () => {
  async function pending(db: Db) {
    await setCustomDomain(db, ENV, "ws_impact", { domain: "orders.impactrentals.store" });
  }

  function answering(response: Response | Error) {
    return vi.fn(async (_url: string, _init?: RequestInit) => {
      if (response instanceof Error) {
        throw response;
      }
      return response;
    });
  }

  it("fetches https://<domain>/api/health and marks the domain active when it reports that host", async () => {
    const db = await setup();
    await pending(db);
    const fetchImpl = answering(Response.json({ ok: true, host: "orders.impactrentals.store" }));
    const result = await checkCustomDomain(db, "ws_impact", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://orders.impactrentals.store/api/health");
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("manual");
    expect(result).toEqual({
      kind: "checked",
      domain: { domain: "orders.impactrentals.store", status: "active", reason: null },
    });
    expect((await row(db)).customDomainStatus).toBe("active");
  });

  it("accepts the reported host with a port or in another case", async () => {
    const db = await setup();
    await pending(db);
    const result = await checkCustomDomain(db, "ws_impact", answering(Response.json({ ok: true, host: "Orders.ImpactRentals.Store:443" })));
    expect(result.kind === "checked" ? result.domain.status : null).toBe("active");
  });

  it("marks the domain error with a reason when another host answers", async () => {
    const db = await setup();
    await pending(db);
    const result = await checkCustomDomain(db, "ws_impact", answering(Response.json({ ok: true, host: "orderingdesk.test" })));
    expect(result.kind).toBe("checked");
    const domain = result.kind === "checked" ? result.domain : null;
    expect(domain?.status).toBe("error");
    expect(domain?.reason).toContain("orderingdesk.test");
    expect((await row(db)).customDomainStatus).toBe("error");
  });

  it("gives a reason for every way the host can fail to reach the app", async () => {
    const cases: Array<[Response | Error, string]> = [
      [new Response("nope", { status: 522 }), "HTTP 522"],
      [new Response(null, { status: 301, headers: { location: "https://www.example.com/" } }), "redirected"],
      [new Response("<html>parked</html>", { status: 200 }), "not as Ordering Desk"],
      [Response.json({ ok: false }), "not as Ordering Desk"],
      [new TypeError("fetch failed"), "Could not reach"],
      [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "No answer"],
    ];
    for (const [answer, expected] of cases) {
      const db = await setup();
      await pending(db);
      const result = await checkCustomDomain(db, "ws_impact", answering(answer));
      const domain = result.kind === "checked" ? result.domain : null;
      expect(domain?.status, expected).toBe("error");
      expect(domain?.reason, expected).toContain(expected);
    }
  });

  it("refuses to check a workspace with no domain, and a missing workspace", async () => {
    const db = await setup();
    const fetchImpl = answering(Response.json({ ok: true, host: "x" }));
    expect((await checkCustomDomain(db, "ws_impact", fetchImpl)).kind).toBe("no-domain");
    expect(await checkCustomDomain(db, "ws_missing", fetchImpl)).toEqual({ kind: "not-found" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not mark a domain that was replaced while the check ran", async () => {
    const db = await setup();
    await pending(db);
    const fetchImpl = vi.fn(async () => {
      await setCustomDomain(db, ENV, "ws_impact", { domain: "orders.other.example" });
      return Response.json({ ok: true, host: "orders.impactrentals.store" });
    });
    const result = await checkCustomDomain(db, "ws_impact", fetchImpl);
    expect(result.kind).toBe("checked");
    const saved = await row(db);
    expect(saved.customDomain).toBe("orders.other.example");
    expect(saved.customDomainStatus).toBe("pending");
    expect(result.kind === "checked" ? result.domain : null).toEqual({
      domain: "orders.other.example",
      status: "pending",
      reason: "The domain changed while it was being checked. Check again.",
    });
  });
});
