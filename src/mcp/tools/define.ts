// What an MCP tool is (Wave 2 plan, Decisions 16 and 17): its name and
// description for the chat app, who may see it (minRole, and needsWrite for
// prepare and confirm tools, listed only with desk.write), how it counts
// against the daily limits (read: one lookup claimed before it runs; self:
// a confirm claims a change itself, once it reaches the desk service), its
// annotations, its zod input (strict: unknown keys are refused), and run.
// Tools return ok(data) or fail(code, message); src/mcp/registry.ts turns
// that into the MCP result and the audit row. Descriptions say what a tool
// does, never how the model should behave. Relative imports only.

import type * as z from "zod";
import type { Db } from "../../db";
import type { Role } from "../../lib/roles";
import type { AiRunner } from "../../server/search/ai";
import type { AuditTarget } from "../audit";
import type { ToolErrorCode } from "../output";
import type { Principal } from "../types";

export type ToolDeps = {
  db: Db;
  env: CloudflareEnv;
  principal: Principal;
  now: () => number;
  // Work to run after the answer (follow-ups: broadcast, pushes, the
  // Shopify status tag). A thunk, so tests can capture it without running
  // it; production runs it under ctx.waitUntil.
  after: (work: () => Promise<unknown>) => void;
  // Shopify stand-ins for tests.
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // The Workers AI binding for questions asked through search_orders.
  ai?: AiRunner;
};

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown>; target?: AuditTarget }
  | { ok: false; code: ToolErrorCode; message: string; target?: AuditTarget };

export type Annotations = { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  description: string;
  minRole: Role;
  needsWrite: boolean;
  counts: "read" | "self";
  annotations: Annotations;
  input: S;
  run: (args: z.infer<S>, deps: ToolDeps) => Promise<ToolOutcome>;
};

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function ok(data: Record<string, unknown>, target?: AuditTarget): ToolOutcome {
  return target ? { ok: true, data, target } : { ok: true, data };
}

export function fail(code: ToolErrorCode, message: string, target?: AuditTarget): ToolOutcome {
  return target ? { ok: false, code, message, target } : { ok: false, code, message };
}

export const READ: Annotations = { readOnlyHint: true, openWorldHint: false };
// A prepare tool stores a preview and changes nothing anyone sees.
export const PREPARE: Annotations = { readOnlyHint: true, openWorldHint: false };
export const CONFIRM_DESTRUCTIVE: Annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
export const CONFIRM_ADDITIVE: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
