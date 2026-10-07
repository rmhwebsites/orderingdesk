// get_my_access: who this connection acts for and today's use against the
// daily limits. Relative imports only.

import * as z from "zod";
import { roleLabel } from "../../lib/roles";
import { aiClientLabel } from "../../lib/via";
import { SCOPE_WRITE } from "../constants";
import { iso, NAME_MAX, personLabel, plainText } from "../output";
import { mcpUsageToday } from "../usage";
import { READ, defineTool, ok } from "./define";

export const getMyAccess = defineTool({
  name: "get_my_access",
  title: "My access",
  description:
    "Who this connection acts for: the workspace, your role, whether it may change things, the connected app, when the connection expires, and today's lookups and changes against the daily limits.",
  minRole: "staff",
  needsWrite: false,
  counts: "read",
  annotations: READ,
  input: z.object({}).strict(),
  async run(_args, deps) {
    const p = deps.principal;
    const used = await mcpUsageToday(deps.db, p, deps.now());
    return ok({
      workspace: plainText(p.workspaceName, NAME_MAX),
      // The principal goes by the email when the account has no name.
      you: personLabel(p.personName),
      role: roleLabel(p.role),
      access: p.scopes.includes(SCOPE_WRITE) ? "look up and change (each change previewed, then confirmed)" : "look up only",
      app: aiClientLabel(p.client),
      connection_expires: iso(p.grantExpiresAt),
      // A platform admin's hub connection works in every workspace with AI
      // on (Task 30A); this answer is for the workspace the call named.
      ...(p.everyWorkspace ? { connection_covers: "every workspace with AI connections on; list_workspaces names them" } : {}),
      today: {
        lookups_used: used.reads,
        lookups_limit: p.limits.reads,
        changes_used: used.changes,
        changes_limit: p.limits.changes,
        resets: "00:00 UTC",
      },
    });
  },
});
