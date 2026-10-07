// Who an MCP call acts for, resolved from D1 on every call
// (src/mcp/principal.ts): never taken from the token alone or from a tool
// argument. Relative imports only.

import type { Role } from "../lib/roles";
import type { AiClient } from "../lib/via";

export type Principal = {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  personName: string;
  // Live from D1 on this call.
  role: Role;
  grantId: string;
  client: AiClient;
  // desk.read, desk.write, offline_access, as the person granted.
  scopes: string[];
  host: string;
  limits: { reads: number; changes: number };
  grantExpiresAt: number;
  // Set when this call came through a platform admin's hub connection for
  // every workspace (owner decision 3, Oct 7): the tool's workspace argument
  // picked this workspace (src/mcp/every-workspace.ts).
  everyWorkspace?: true;
};

// A platform admin's hub connection for every workspace with AI on,
// resolved from D1 on every call (src/mcp/principal.ts,
// resolveEveryWorkspace). It names no workspace: each tool call does, and
// src/mcp/every-workspace.ts turns that into a Principal.
export type EveryWorkspaceConnection = {
  userId: string;
  personName: string;
  grantId: string;
  client: AiClient;
  scopes: string[];
  host: string;
  grantExpiresAt: number;
};
