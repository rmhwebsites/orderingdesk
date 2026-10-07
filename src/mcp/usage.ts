// Daily MCP limits per person (Wave 2 plan, Decision 9), counted in Wave
// 1c's ai_usage: every read and prepare call is a lookup (mcp_read), every
// confirm that reaches the desk service is a change (mcp_change). The limits
// come from workspace_settings through the principal. Relative imports only.

import type { Db } from "../db";
import { claimDaily, usageToday } from "../server/search/usage";
import type { Principal } from "./types";

export const MCP_READ = "mcp_read";
export const MCP_CHANGE = "mcp_change";

export function claimRead(db: Db, p: Principal, now: number): Promise<boolean> {
  return claimDaily(db, { workspaceId: p.workspaceId, principalId: p.userId, kind: MCP_READ }, p.limits.reads, now);
}

export function claimChange(db: Db, p: Principal, now: number): Promise<boolean> {
  return claimDaily(db, { workspaceId: p.workspaceId, principalId: p.userId, kind: MCP_CHANGE }, p.limits.changes, now);
}

export async function mcpUsageToday(db: Db, p: Principal, now: number): Promise<{ reads: number; changes: number }> {
  const counts = await usageToday(db, p.workspaceId, p.userId, now);
  return { reads: counts[MCP_READ] ?? 0, changes: counts[MCP_CHANGE] ?? 0 };
}
