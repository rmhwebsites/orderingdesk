// Client hosts (platform amendment section 1), behind
// /api/workspaces/[id]/domain. Platform admins only; the routes check that.
//
// A workspace's custom domain (orders.<client domain>) is saved as pending,
// then a check fetches https://<domain>/api/health and compares the host it
// reports: only then is it active, and only an active domain opens the
// workspace (src/server/host.ts). Attaching the domain to the Worker happens
// in Cloudflare (docs/HANDOFF.md, "Attaching a client host").
//
// Changing or clearing the domain clears the workspace's sender
// verification: the derived sender (accounts@<domain>) changes with it, so
// the old test send no longer proves anything (src/server/sender.ts).

import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { workspaces } from "@/db/schema";
import { isRecord } from "./desk/shapes";
import { HEALTH_PATH, hubHostname, normalizeHost } from "./host";

type DomainEnv = { APP_URL: string };

export type DomainStatus = "pending" | "active" | "error";
export type DomainView = { domain: string | null; status: DomainStatus | null };

const HOST_MAX = 253;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CHECK_TIMEOUT_MS = 10_000;
const REASON_MAX = 300;

const EXAMPLE = "such as orders.example.com";

// The trimmed, lowercased host name, or why it is refused: a scheme, path,
// port, user or space; fewer than two labels; a label that is not letters,
// digits and inner hyphens (1 to 63 characters); a numeric last label (an
// IP address); more than 253 characters; or the hub host itself.
export function normalizeDomain(
  value: unknown,
  env: DomainEnv,
): { ok: true; domain: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `A domain is required, ${EXAMPLE}` };
  }
  const domain = value.trim().toLowerCase();
  if (domain.includes("://")) {
    return { ok: false, error: `Enter the host only, without https://, ${EXAMPLE}` };
  }
  if (/[\/:@\s]/.test(domain)) {
    return { ok: false, error: `Enter a host name only, ${EXAMPLE}` };
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return { ok: false, error: `The domain needs at least one dot, ${EXAMPLE}` };
  }
  if (domain.length > HOST_MAX || !labels.every((label) => LABEL.test(label)) || /^[0-9]+$/.test(labels[labels.length - 1])) {
    return { ok: false, error: `That is not a valid host name, ${EXAMPLE}` };
  }
  if (domain === hubHostname(env)) {
    return { ok: false, error: "That is the Ordering Desk address itself. Use the client's own domain." };
  }
  return { ok: true, domain };
}

async function readDomain(db: Db, workspaceId: string) {
  const rows = await db
    .select({ customDomain: workspaces.customDomain, customDomainStatus: workspaces.customDomainStatus })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

function isDomainConflict(e: unknown): boolean {
  const message = e instanceof Error ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ""}` : "";
  return message.includes("UNIQUE constraint failed") && message.includes("custom_domain");
}

const TAKEN = "Another workspace already uses that domain";

export type SetDomainResult =
  | { kind: "invalid"; error: string }
  | { kind: "taken"; error: string }
  | { kind: "not-found" }
  | { kind: "saved"; domain: DomainView };

// Body {domain}. Saves it with status pending (saving the same domain again
// also asks for a new check). A different domain clears the sender
// verification.
export async function setCustomDomain(
  db: Db,
  env: DomainEnv,
  workspaceId: string,
  body: unknown,
): Promise<SetDomainResult> {
  const parsed = normalizeDomain(isRecord(body) ? body.domain : undefined, env);
  if (!parsed.ok) {
    return { kind: "invalid", error: parsed.error };
  }
  const { domain } = parsed;
  const current = await readDomain(db, workspaceId);
  if (!current) {
    return { kind: "not-found" };
  }
  const taken = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.customDomain, domain), ne(workspaces.id, workspaceId)))
    .limit(1);
  if (taken.length > 0) {
    return { kind: "taken", error: TAKEN };
  }
  try {
    await db
      .update(workspaces)
      .set({
        customDomain: domain,
        customDomainStatus: "pending",
        ...(current.customDomain === domain ? {} : { sendingVerifiedAt: null }),
      })
      .where(eq(workspaces.id, workspaceId));
  } catch (e) {
    // Another workspace saved the same domain between the check and the
    // write: the unique index refuses it.
    if (isDomainConflict(e)) {
      return { kind: "taken", error: TAKEN };
    }
    throw e;
  }
  return { kind: "saved", domain: { domain, status: "pending" } };
}

export type ClearDomainResult = { kind: "not-found" } | { kind: "cleared" };

// Removes the domain (the workspace is then reached through the hub only)
// and the sender verification that depended on it.
export async function clearCustomDomain(db: Db, workspaceId: string): Promise<ClearDomainResult> {
  const result = await db
    .update(workspaces)
    .set({ customDomain: null, customDomainStatus: null, sendingVerifiedAt: null })
    .where(eq(workspaces.id, workspaceId))
    .returning({ id: workspaces.id });
  return result.length > 0 ? { kind: "cleared" } : { kind: "not-found" };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function clip(text: string): string {
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}...` : text;
}

// Why the domain does not reach this app, or null when it does.
async function probe(domain: string, fetchImpl: Fetch): Promise<string | null> {
  const url = `https://${domain}${HEALTH_PATH}`;
  const fix = "Check that it is attached to the orderingdesk Worker in Cloudflare and that its DNS is in place.";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return `No answer from https://${domain} within ${CHECK_TIMEOUT_MS / 1000} seconds. ${fix}`;
    }
    const message = e instanceof Error && e.message ? ` (${clip(e.message)})` : "";
    return `Could not reach https://${domain}${message}. ${fix}`;
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "another address";
    return `${url} redirected to ${clip(location)}. The domain must reach Ordering Desk directly. ${fix}`;
  }
  if (response.status !== 200) {
    return `${url} answered HTTP ${response.status}, so the domain does not reach Ordering Desk yet. ${fix}`;
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  if (!isRecord(body) || body.ok !== true || typeof body.host !== "string") {
    return `https://${domain} answered, but not as Ordering Desk. ${fix}`;
  }
  const reported = normalizeHost(body.host);
  if (reported !== domain) {
    return `https://${domain} reached Ordering Desk as ${clip(reported || "an unnamed host")}, not as ${domain}. ${fix}`;
  }
  return null;
}

export type CheckDomainResult =
  | { kind: "not-found" }
  | { kind: "no-domain"; error: string }
  | { kind: "checked"; domain: DomainView & { reason: string | null } };

// Confirms the saved domain reaches this app: fetches
// https://<domain>/api/health and compares the host it reports. Marks the
// domain active, or error with the reason (the reason is returned, not
// stored). The status is written only if the domain is still the one that
// was checked.
export async function checkCustomDomain(
  db: Db,
  workspaceId: string,
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): Promise<CheckDomainResult> {
  const current = await readDomain(db, workspaceId);
  if (!current) {
    return { kind: "not-found" };
  }
  const domain = current.customDomain;
  if (!domain) {
    return { kind: "no-domain", error: "Save a custom domain first, then check it." };
  }
  const reason = await probe(domain, fetchImpl);
  const status: DomainStatus = reason === null ? "active" : "error";
  const updated = await db
    .update(workspaces)
    .set({ customDomainStatus: status })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.customDomain, domain)))
    .returning({ id: workspaces.id });
  if (updated.length === 0) {
    const now = await readDomain(db, workspaceId);
    return {
      kind: "checked",
      domain: {
        domain: now?.customDomain ?? null,
        status: now?.customDomainStatus ?? null,
        reason: "The domain changed while it was being checked. Check again.",
      },
    };
  }
  return { kind: "checked", domain: { domain, status, reason } };
}
