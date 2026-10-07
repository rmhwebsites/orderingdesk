// Which tools a principal sees, and the wrapper every tool call goes
// through (Wave 2 plan, Decisions 9, 13, 14 and 16): a lookup is counted
// before the tool runs (refused over the limit), a thrown error (in the
// count or in the tool) becomes a structured internal error that names
// nothing, and every call writes one audit row. Nothing may escape: the MCP
// SDK would send an escaped error's message, for a failed D1 query its SQL
// and ids, to the chat app as raw text. Relative imports only.

import { roleAtLeast } from "../lib/roles";
import { writeAudit } from "./audit";
import { SCOPE_WRITE } from "./constants";
import { errorResult, okResult, type ToolResult } from "./output";
import type { ToolDef, ToolDeps, ToolOutcome } from "./tools/define";
import type { Principal } from "./types";
import { claimRead } from "./usage";

// Takes the role and scopes only, so an every-workspace connection (role
// platform, Task 30A) filters the same way before any workspace is named.
export function toolsFor(p: Pick<Principal, "role" | "scopes">, all: readonly ToolDef[]): ToolDef[] {
  return all.filter((tool) => roleAtLeast(p.role, tool.minRole) && (!tool.needsWrite || p.scopes.includes(SCOPE_WRITE)));
}

export async function runTool(tool: ToolDef, args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const { db, principal: p } = deps;
  const now = deps.now();
  let outcome: ToolOutcome;
  try {
    outcome =
      tool.counts === "read" && !(await claimRead(db, p, now))
        ? { ok: false, code: "limit_reached", message: `Today's limit of ${p.limits.reads} lookups is used up. It resets at 00:00 UTC.` }
        : await tool.run(args as never, deps);
  } catch (e) {
    console.error("[mcp] " + JSON.stringify({ workspaceId: p.workspaceId, tool: tool.name, error: e instanceof Error ? e.name : "unknown" }));
    outcome = { ok: false, code: "internal", message: "Ordering Desk hit an error. Check the card in Ordering Desk before trying again." };
  }
  await writeAudit(db, p, { tool: tool.name, outcome: outcome.ok ? "ok" : outcome.code, target: outcome.target ?? null }, now);
  return outcome.ok ? okResult(outcome.data) : errorResult(outcome.code, outcome.message);
}
