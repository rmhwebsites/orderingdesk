import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { openTestDb, seedWorkspace } from "./desk/test-helpers";
import {
  appOrigin,
  gateRequest,
  hostOrigin,
  normalizeHost,
  resolveHost,
  slugRouteForHost,
  workspaceOrigin,
  type HostResolution,
} from "./host";

const ENV = { APP_URL: "https://orderingdesk.test" };

async function setup() {
  const { db } = openTestDb();
  await seedWorkspace(db, "ws_impact");
  await seedWorkspace(db, "ws_pending");
  await seedWorkspace(db, "ws_broken");
  await setDomain(db, "ws_impact", "orders.impactrentals.store", "active");
  await setDomain(db, "ws_pending", "orders.pending.example", "pending");
  await setDomain(db, "ws_broken", "orders.broken.example", "error");
  return db;
}

async function setDomain(db: Db, id: string, domain: string, status: "pending" | "active" | "error") {
  await db
    .update(schema.workspaces)
    .set({ customDomain: domain, customDomainStatus: status })
    .where(eq(schema.workspaces.id, id));
}

describe("normalizeHost", () => {
  it("lowercases, trims, and strips the port and a trailing dot", () => {
    expect(normalizeHost("Orders.ImpactRentals.Store:443")).toBe("orders.impactrentals.store");
    expect(normalizeHost(" localhost:3000 ")).toBe("localhost");
    expect(normalizeHost("orders.example.com.")).toBe("orders.example.com");
    expect(normalizeHost("[::1]:3000")).toBe("[::1]");
  });

  it("reads a missing host as empty", () => {
    expect(normalizeHost(null)).toBe("");
    expect(normalizeHost(undefined)).toBe("");
    expect(normalizeHost("")).toBe("");
  });
});

describe("resolveHost", () => {
  it("answers hub for the APP_URL host, with or without a port", async () => {
    const db = await setup();
    expect(await resolveHost(db, ENV, "orderingdesk.test")).toEqual({ kind: "hub" });
    expect(await resolveHost(db, ENV, "ORDERINGDESK.test:443")).toEqual({ kind: "hub" });
    expect(await resolveHost(db, { APP_URL: "http://localhost:3000" }, "localhost:3000")).toEqual({ kind: "hub" });
  });

  it("answers the workspace for its active custom domain, matched lowercased and without the port", async () => {
    const db = await setup();
    const resolved = await resolveHost(db, ENV, "Orders.ImpactRentals.Store:443");
    expect(resolved.kind).toBe("workspace");
    expect(resolved.kind === "workspace" ? resolved.workspace.id : null).toBe("ws_impact");
  });

  it("answers unknown for a pending or failed domain, a stranger, and a missing host", async () => {
    const db = await setup();
    for (const host of ["orders.pending.example", "orders.broken.example", "evil.example", "", null]) {
      expect(await resolveHost(db, ENV, host)).toEqual({ kind: "unknown" });
    }
  });

  it("never answers hub when APP_URL is not a URL", async () => {
    const db = await setup();
    expect(await resolveHost(db, { APP_URL: "" }, "")).toEqual({ kind: "unknown" });
    expect(await resolveHost(db, { APP_URL: "not a url" }, "not a url")).toEqual({ kind: "unknown" });
  });
});

describe("origins", () => {
  it("builds the hub origin from APP_URL", () => {
    expect(appOrigin(ENV)).toBe("https://orderingdesk.test");
    expect(appOrigin({ APP_URL: "http://localhost:3000/" })).toBe("http://localhost:3000");
  });

  it("builds a client origin from the stored domain with the APP_URL scheme and port", async () => {
    const db = await setup();
    const resolved = await resolveHost(db, ENV, "orders.impactrentals.store");
    expect(hostOrigin(ENV, resolved)).toBe("https://orders.impactrentals.store");
    const local = await resolveHost(db, { APP_URL: "http://localhost:3000" }, "orders.impactrentals.store:3000");
    expect(hostOrigin({ APP_URL: "http://localhost:3000" }, local)).toBe("http://orders.impactrentals.store:3000");
    expect(hostOrigin(ENV, { kind: "hub" })).toBe("https://orderingdesk.test");
    expect(hostOrigin(ENV, { kind: "unknown" })).toBeNull();
  });

  it("points workspace links at the active client host, else the hub", () => {
    expect(
      workspaceOrigin(ENV, { customDomain: "orders.impactrentals.store", customDomainStatus: "active" }),
    ).toBe("https://orders.impactrentals.store");
    expect(workspaceOrigin(ENV, { customDomain: "orders.impactrentals.store", customDomainStatus: "pending" })).toBe(
      "https://orderingdesk.test",
    );
    expect(workspaceOrigin(ENV, { customDomain: null, customDomainStatus: null })).toBe("https://orderingdesk.test");
  });
});

describe("slugRouteForHost (the /w/[slug] pages)", () => {
  const workspaceHost = {
    kind: "workspace",
    workspace: { id: "ws_impact", slug: "impact-rentals" },
  } as unknown as HostResolution;

  it("renders every slug on the hub", () => {
    expect(slugRouteForHost({ kind: "hub" }, "impact-rentals")).toEqual({ kind: "render" });
  });

  it("sends the client host's own slug to its root and hides every other workspace", () => {
    expect(slugRouteForHost(workspaceHost, "impact-rentals")).toEqual({ kind: "redirect", to: "/" });
    expect(slugRouteForHost(workspaceHost, "other-client")).toEqual({ kind: "not-found" });
  });

  it("hides everything on an unknown host", () => {
    expect(slugRouteForHost({ kind: "unknown" }, "impact-rentals")).toEqual({ kind: "not-found" });
  });
});

describe("gateRequest (custom-worker, before OpenNext)", () => {
  function request(url: string, headers: Record<string, string> = {}) {
    return new Request(url, { headers });
  }

  it("answers an unknown host with a plain 404 that never shows the hub", async () => {
    const db = await setup();
    for (const url of ["https://evil.example/", "https://orders.pending.example/sign-in", "https://evil.example/api/auth/get-session"]) {
      const gated = await gateRequest(request(url), ENV, db);
      expect(gated.kind).toBe("respond");
      const response = gated.kind === "respond" ? gated.response : null;
      expect(response?.status).toBe(404);
      const body = await response!.text();
      expect(body).toContain("Not found");
      expect(body).not.toContain("Ordering Desk");
    }
  });

  it("lets the hub and an active client host through", async () => {
    const db = await setup();
    for (const url of ["https://orderingdesk.test/", "https://orders.impactrentals.store/w/x"]) {
      const gated = await gateRequest(request(url), ENV, db);
      expect(gated.kind).toBe("pass");
    }
  });

  it("answers /api/health on any host, so a pending domain can be checked", async () => {
    const db = await setup();
    for (const url of ["https://orders.pending.example/api/health", "https://evil.example/api/health"]) {
      expect((await gateRequest(request(url), ENV, db)).kind).toBe("pass");
    }
  });

  it("pins x-forwarded-host to the routed host, since OpenNext copies it over Host", async () => {
    const db = await setup();
    const gated = await gateRequest(
      request("https://orderingdesk.test/", { "x-forwarded-host": "orders.impactrentals.store" }),
      ENV,
      db,
    );
    expect(gated.kind).toBe("pass");
    const passed = gated.kind === "pass" ? gated.request : null;
    expect(passed?.headers.get("x-forwarded-host")).toBe("orderingdesk.test");
  });

  it("hands the custom worker the resolved host, and none for the health path", async () => {
    const db = await setup();
    const hub = await gateRequest(request("https://orderingdesk.test/mcp"), ENV, db);
    expect(hub).toMatchObject({ kind: "pass", resolution: { kind: "hub" } });
    const health = await gateRequest(request("https://anything.example.com/api/health"), ENV, db);
    expect(health).toMatchObject({ kind: "pass", resolution: null });
  });

  it("passes a request without x-forwarded-host through untouched", async () => {
    const db = await setup();
    const original = request("https://orders.impactrentals.store/");
    const gated = await gateRequest(original, ENV, db);
    expect(gated.kind === "pass" ? gated.request : null).toBe(original);
  });
});
