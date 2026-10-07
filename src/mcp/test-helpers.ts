// Test-only support for the MCP server tests: a workspace on a client host
// with a manager, a staff member and a platform admin, a store connection,
// one request and one order, a grant, principals, a scripted Shopify, and
// tool deps. Built on src/server/desk/test-helpers.ts (real migrations in an
// in-memory SQLite database).

import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import * as schema from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import {
  draftSnapshotOf,
  openTestDb,
  seedDraft,
  seedDraftStatuses,
  seedMember,
  seedOrder,
  seedUser,
  seedWorkspace,
  snapshotOf,
} from "@/server/desk/test-helpers";
import type { Principal } from "./types";

export const WS = "ws_impact";
export const HOST = "orders.example.com";
export const ORIGIN = `https://${HOST}`;
export const HUB = "hub.example.com";
export const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
export const TOKEN = "shpat_mcp_token_never_leak";
export const SHOP = "example-rentals.myshopify.com";
export const NOW = Date.parse("2026-10-07T15:00:00.000Z");
export const MANAGER = "u_casey";
export const STAFF = "u_riley";
export const ADMIN = "u_avery";
export const GRANT = "g_casey";

export function testEnv(overrides: Partial<CloudflareEnv> = {}): CloudflareEnv {
  return {
    APP_URL: `https://${HUB}`,
    ENCRYPTION_KEY: KEY,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
    PLATFORM_ADMIN_EMAILS: "avery.stone@example.com",
    ...overrides,
  } as CloudflareEnv;
}

export const SCOPES = [
  "read_orders",
  "write_orders",
  "read_customers",
  "read_draft_orders",
  "write_draft_orders",
  "read_companies",
  "read_products",
];

// The workspace on its active client host, its people and its two cards: a
// request d1 (#D12) and an order o1 (#1001).
export async function seedMcpWorkspace(db: Db): Promise<void> {
  await seedWorkspace(db, WS);
  await db.update(schema.workspaces).set({ name: "Example Rentals", customDomain: HOST, customDomainStatus: "active" }).where(eq(schema.workspaces.id, WS));
  // The AI switch defaults off (owner decision, Oct 7); a platform admin
  // turned it on for this workspace.
  await db.update(schema.workspaceSettings).set({ aiTeam: true }).where(eq(schema.workspaceSettings.workspaceId, WS));
  await seedDraftStatuses(db, WS);
  await seedUser(db, MANAGER, "casey.lin@example.com", "Casey Lin");
  await seedUser(db, STAFF, "riley.oakes@example.com", "Riley Oakes");
  await seedUser(db, ADMIN, "avery.stone@example.com", "Avery Stone");
  await seedMember(db, WS, MANAGER, "manager");
  await seedMember(db, WS, STAFF, "staff");
  await db.insert(schema.storeConnections).values({
    workspaceId: WS,
    shopDomain: SHOP,
    encryptedToken: await encryptSecret(TOKEN, KEY, WS),
    scopes: SCOPES,
  });
  await seedDraft(db, WS, {
    id: "d1",
    draftId: "12",
    name: "#D12",
    shopify: draftSnapshotOf({ shopifyDraftId: "12", name: "#D12", customerName: "Jordan Vale", email: "jordan@example.com" }),
  });
  await seedOrder(db, WS, { id: "o1", name: "#1001", shopify: snapshotOf({ total: "0.00", currency: "USD" }) });
}

export async function setupMcp(): Promise<Db> {
  const { db } = openTestDb();
  await seedMcpWorkspace(db);
  return db;
}

export async function seedGrant(
  db: Db,
  opts: {
    id?: string;
    // null: a platform admin's hub connection for every workspace.
    workspaceId?: string | null;
    userId?: string;
    host?: string;
    scopes?: string[];
    client?: string;
    revokedAt?: number | null;
    expiresAt?: number;
  } = {},
): Promise<string> {
  const id = opts.id ?? GRANT;
  await db.insert(schema.aiGrants).values({
    id,
    workspaceId: opts.workspaceId === undefined ? WS : opts.workspaceId,
    userId: opts.userId ?? MANAGER,
    host: opts.host ?? HOST,
    clientId: "https://claude.ai/oauth/mcp-client",
    client: opts.client ?? "claude",
    clientDomain: "claude.ai",
    redirectHost: "claude.ai",
    scopes: opts.scopes ?? ["desk.read", "desk.write", "offline_access"],
    createdAt: NOW - 86400000,
    expiresAt: opts.expiresAt ?? NOW + 86400000,
    revokedAt: opts.revokedAt ?? null,
  });
  return id;
}

export function principalFor(role: Principal["role"] = "manager", overrides: Partial<Principal> = {}): Principal {
  const userId = role === "staff" ? STAFF : role === "platform" ? ADMIN : MANAGER;
  return {
    workspaceId: WS,
    workspaceName: "Example Rentals",
    userId,
    personName: role === "staff" ? "Riley Oakes" : role === "platform" ? "Avery Stone" : "Casey Lin",
    role,
    grantId: GRANT,
    client: "claude",
    scopes: ["desk.read", "desk.write", "offline_access"],
    host: HOST,
    limits: { reads: 1000, changes: role === "staff" ? 50 : 100 },
    grantExpiresAt: NOW + 86400000,
    ...overrides,
  };
}

type Call = { op: string; variables: Record<string, unknown> };
type Handler = (variables: Record<string, unknown>, count: number) => unknown;

// A scripted Shopify: each operation name answers { data: handler(...) };
// a handler may throw a DOMException TimeoutError to act as a timeout, or
// return a Response to answer exactly. Unknown operations fail the test.
export function fakeShop(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const op = body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "unknown";
    calls.push({ op, variables: body.variables });
    const count = (counts.get(op) ?? 0) + 1;
    counts.set(op, count);
    const handler = handlers[op];
    if (!handler) {
      throw new Error("unexpected Shopify request: " + op);
    }
    const answer = handler(body.variables, count);
    return answer instanceof Response ? answer : Response.json({ data: answer });
  }) as typeof fetch;
  return { impl, calls, ops: () => calls.map((call) => call.op) };
}

export function timeoutError(): never {
  throw new DOMException("The operation timed out.", "TimeoutError");
}

// An in-memory KV namespace with the calls the OAuth library makes.
export function memoryKv(): KVNamespace {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  const kindOf = (type: unknown) => (typeof type === "string" ? type : (type as { type?: string } | undefined)?.type);
  const read = (key: string, type: unknown) => {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }
    return kindOf(type) === "json" ? (JSON.parse(entry.value) as unknown) : entry.value;
  };
  return {
    async get(key: string, type?: unknown) {
      return read(key, type);
    },
    async getWithMetadata(key: string, type?: unknown) {
      return { value: read(key, type), metadata: store.get(key)?.metadata ?? null, cacheStatus: null };
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      store.set(key, { value: String(value), metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = [...store.entries()]
        .filter(([name]) => name.startsWith(options?.prefix ?? ""))
        .map(([name, entry]) => ({ name, metadata: entry.metadata }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

export function fakeCtx(props: Record<string, unknown> = {}): ExecutionContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    props,
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work.catch(() => undefined));
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
}
